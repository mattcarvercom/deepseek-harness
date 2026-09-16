// Client-memory fold of the durable inbox over the session window the client
// holds: which user prompts were admitted to the Host inbox and are therefore
// model-visible at the next turn or step boundary, but are not yet committed
// as the canonical user/message node.

import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionRequestId } from '../../types.ts'
import type { PendingInboxPrompt } from '../contract/snapshot.ts'
import { previewOf, textOf } from './message-preview.ts'

interface ClaimedPrompt {
  readonly message: UserMessage
  readonly placement: 'queued' | 'steering'
  /** The open turn at claim time; its turn/end retires any still-uncommitted entry. */
  readonly turn: number
}

type InboxTarget = 'next-turn' | 'next-step'

/** A session event as structurally read by the fold; window entries may be compact records. */
export type FoldableSessionEvent = {
  readonly type: string
  readonly data?: unknown
}

function isUserSource(message: UserMessage): boolean {
  const source = message.source as { readonly kind?: unknown } | undefined
  return source?.kind === 'user'
}

function project(message: UserMessage, placement: 'queued' | 'steering'): PendingInboxPrompt {
  const source = message.source as { readonly kind?: unknown; readonly rpcId?: unknown } | undefined
  const rpcId = source?.kind === 'user' && typeof source.rpcId === 'string'
    ? source.rpcId as SessionRequestId
    : undefined
  const content = message.content as unknown as readonly ContentBlock[]
  return {
    id: message.id,
    placement,
    ...(rpcId === undefined ? {} : { rpcId }),
    content,
    preview: previewOf(content),
    text: textOf(content),
  }
}

/**
 * Client-memory fold of the durable inbox over a bounded session window.
 *
 * The fold mirrors the canonical `agent/inbox/spliced` splice arithmetic
 * (same `toSpliced` semantics, same duplicate-id rejection) over the same
 * window data the queue mirror and the submission observer consume, so no
 * new session event is needed: the canonical `user/message` remains the
 * only surface representation of a committed prompt.
 *
 * The window is bounded, not the full log: a splice whose removed slice
 * predates the folded data cannot be validated or replayed, so it is
 * skipped instead of thrown on, and a claim it describes is never tracked
 * (the prompt surfaces through its durable commit instead). History pages
 * apply insertion-only splices with duplicate-id rejection; their removals
 * describe past list states the current window fold already reflects.
 */
export class PendingInboxPrompts {
  private nextTurn: UserMessage[] = []
  private nextStep: UserMessage[] = []
  private readonly claimed = new Map<MessageId, ClaimedPrompt>()
  private openTurn: number | undefined

  /**
   * Replace the fold state and re-fold one window from its head.
   * @param events - the new contiguous window, in log order.
   */
  reset(events: readonly FoldableSessionEvent[]): void {
    this.nextTurn = []
    this.nextStep = []
    this.claimed.clear()
    this.openTurn = undefined
    for (const event of events) this.feed(event)
  }

  /**
   * Fold one history page older than the current window. Only insertion
   * splices apply (duplicate ids rejected); page removals and turn events
   * describe past states and leave the current fold untouched.
   * @param events - the prepended page, in log order.
   * @returns whether the snapshot-visible state changed.
   */
  prepend(events: readonly FoldableSessionEvent[]): boolean {
    const before = this.signature()
    const openTurn = this.openTurn
    for (const event of events) this.feedPrepend(event)
    this.openTurn = openTurn
    return this.signature() !== before
  }

  /**
   * Fold one live event.
   * @param event - the newly appended session event.
   * @returns whether the snapshot-visible state changed.
   */
  append(event: FoldableSessionEvent): boolean {
    const before = this.signature()
    this.feed(event)
    return this.signature() !== before
  }

  /**
   * Currently in-flight user prompts, in order: user-source entries still
   * in the projection (queued for next-turn, steering for next-step)
   * followed by uncommitted claimed entries in claim order.
   * @returns the immutable snapshot list (empty when nothing is in flight).
   */
  snapshot(): readonly PendingInboxPrompt[] {
    const entries: PendingInboxPrompt[] = []
    for (const message of this.nextTurn) {
      if (isUserSource(message)) entries.push(project(message, 'queued'))
    }
    for (const message of this.nextStep) {
      if (isUserSource(message)) entries.push(project(message, 'steering'))
    }
    for (const { message, placement } of this.claimed.values()) {
      entries.push(project(message, placement))
    }
    return entries
  }

  // ---- Private ----

  /** Snapshot-visible signature: identity, placement, and derived text size. */
  private signature(): string {
    let out = ''
    for (const entry of this.snapshot()) {
      out += `${entry.id}:${entry.placement}:${entry.preview}:${entry.text === null ? 'n' : entry.text.length};`
    }
    return out
  }

  private feed(event: FoldableSessionEvent): void {
    switch (event.type) {
      case 'agent/inbox/spliced':
        this.applySplice(event.data)
        return
      case 'turn/start': {
        const turn = readNumber(event.data, 'turn')
        if (turn !== undefined) this.openTurn = turn
        return
      }
      case 'turn/end': {
        const turn = readNumber(event.data, 'turn')
        if (turn === undefined) return
        if (this.openTurn === turn) this.openTurn = undefined
        for (const [id, entry] of [...this.claimed]) {
          if (entry.turn === turn) this.claimed.delete(id)
        }
        return
      }
      case 'user/message':
        this.retireCommitted(event.data)
        return
      default:
        return
    }
  }

  private feedPrepend(event: FoldableSessionEvent): void {
    if (event.type !== 'agent/inbox/spliced') return
    const splice = readSplice(event.data)
    if (splice === undefined || splice.removedCount !== 0) return
    const list = splice.target === 'next-turn' ? this.nextTurn : this.nextStep
    for (const message of splice.inserted) {
      if (list.some(candidate => candidate.id === message.id)) continue
      list.push(message)
    }
  }

  private applySplice(data: unknown): void {
    const splice = readSplice(data)
    if (splice === undefined) return
    const list = splice.target === 'next-turn' ? this.nextTurn : this.nextStep
    if (splice.start > list.length || splice.start + splice.removedCount > list.length) return
    const removed = list.slice(splice.start, splice.start + splice.removedCount)
    const candidate = list.toSpliced(splice.start, splice.removedCount, ...splice.inserted)
    const ids = new Set<string>()
    for (const message of splice.target === 'next-turn'
      ? [...candidate, ...this.nextStep]
      : [...this.nextTurn, ...candidate]) {
      if (ids.has(message.id)) return
      ids.add(message.id)
    }
    if (splice.target === 'next-turn') this.nextTurn = candidate
    else this.nextStep = candidate
    if (splice.outcome === 'canceled') return
    if (splice.removedCount === 0 || this.openTurn === undefined) return
    for (const message of removed) {
      if (!isUserSource(message)) continue
      this.claimed.set(message.id, {
        message,
        placement: splice.target === 'next-turn' ? 'queued' : 'steering',
        turn: this.openTurn,
      })
    }
  }

  /**
   * Retire a prompt already committed as a durable user node, so the fold
   * stops projecting it as pending.
   *
   * The id path covers the canonical claim→commit case and a window whose
   * claim splice was skipped for divergence, leaving the id in a projection
   * list at commit time. The rpcId path covers compact commit records that
   * lost the id. Both paths retire from the claimed map and both projection
   * lists.
   * @param data - the `user/message` event payload, possibly a compact record.
   */
  private retireCommitted(data: unknown): void {
    const message = data as { readonly id?: unknown; readonly source?: unknown } | undefined
    const source = message?.source as { readonly kind?: unknown; readonly rpcId?: unknown } | undefined
    if (source?.kind !== 'user') return
    const committedId = typeof message?.id === 'string' ? message.id as MessageId : undefined
    if (committedId !== undefined) {
      if (this.claimed.has(committedId)) this.claimed.delete(committedId)
      this.nextTurn = this.nextTurn.filter(candidate => candidate.id !== committedId)
      this.nextStep = this.nextStep.filter(candidate => candidate.id !== committedId)
    }
    const rpcId = typeof source.rpcId === 'string' ? source.rpcId as SessionRequestId : undefined
    if (rpcId === undefined) return
    const matches = (candidate: UserMessage): boolean => {
      const candidateSource = candidate.source as
        | { readonly kind?: unknown; readonly rpcId?: unknown }
        | undefined
      return candidateSource?.kind === 'user' && candidateSource.rpcId === rpcId
    }
    for (const [id, entry] of [...this.claimed]) {
      if (matches(entry.message)) this.claimed.delete(id)
    }
    this.nextTurn = this.nextTurn.filter(candidate => !matches(candidate))
    this.nextStep = this.nextStep.filter(candidate => !matches(candidate))
  }
}

function readNumber(data: unknown, key: string): number | undefined {
  const value = (data as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function readSplice(data: unknown): {
  readonly target: InboxTarget
  readonly start: number
  readonly removedCount: number
  readonly inserted: UserMessage[]
  readonly outcome?: string
} | undefined {
  const splice = data as {
    readonly target?: unknown
    readonly start?: unknown
    readonly removedCount?: unknown
    readonly inserted?: unknown
    readonly outcome?: unknown
  } | undefined
  if (splice === undefined) return undefined
  if (splice.target !== 'next-turn' && splice.target !== 'next-step') return undefined
  if (!Number.isSafeInteger(splice.start) || (splice.start as number) < 0) return undefined
  const removedCount = Number.isSafeInteger(splice.removedCount) ? (splice.removedCount as number) : 0
  if (removedCount < 0) return undefined
  if (!Array.isArray(splice.inserted)) return undefined
  const inserted = splice.inserted.filter(
    (entry): entry is UserMessage => (
      typeof entry === 'object' && entry !== null
      && typeof (entry as { readonly id?: unknown }).id === 'string'
    ),
  )
  return {
    target: splice.target,
    start: splice.start as number,
    removedCount,
    inserted,
    ...(splice.outcome === undefined ? {} : { outcome: splice.outcome as string }),
  }
}
