// Pure derivation of the running-turn pill's phase and run-action arms. The
// inputs are published session state — the durable data-level node stream, the
// live assistant partial, in-flight calls, job views, and activity facts — so
// a replayed turn derives the same phase.

import type { SessionJob } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  ConversationNode,
  PartialAssistant,
  RunningToolCall,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentActivityMap } from '../contract/subagent-activity.ts'
import { isSubagentDelegationTool } from '../contract/turn-process.ts'

/** One published phase of the running-turn pill. */
export type PillPhase =
  | {
    /** Open compaction owns the subline; `since` drives its clock. */
    readonly kind: 'compaction'
    readonly since: number
  }
  | {
    /** A scheduled model-request retry is counting down. */
    readonly kind: 'retry'
    /** Attempt number of the scheduled retry. */
    readonly retry: number
    /** Retry budget; absent under the unlimited `always` policy. */
    readonly max: number | undefined
    /** Provider failure that triggered the retry. */
    readonly failure: LlmFailure
    /** Epoch ms of the `llm/retry` record; the countdown anchor. */
    readonly at: number
    /** Full scheduled delay in ms. */
    readonly delayMs: number
  }
  | {
    /** An in-flight subagent delegation carries the newest activity fact. */
    readonly kind: 'subagent'
    readonly callId: string
    /** The delegation's display label from the activity record. */
    readonly label: string
    /** The local child's durable session id, present only when the run is in-process. */
    readonly childSessionId?: SessionId
  }
  | {
    /** The newest running tool owns the turn. */
    readonly kind: 'tool'
    readonly callId: string
    readonly name: string
  }
  | {
    /** No visible assistant output yet: the turn waits on a live background job. */
    readonly kind: 'job'
    /** The live job's display label. */
    readonly label: string
  }
  | {
    /** No tool evidence: the assistant's streaming phase owns the pill. */
    readonly kind: 'assistant'
    readonly mode: 'first-token' | 'thinking' | 'generating'
  }
  | {
    /** The turn already produced visible assistant output and works between visible phases. */
    readonly kind: 'working'
  }

/** Facts the pill derives from; every input is published session/chat state. */
export interface PillPhaseInput {
  /** The session's finalized conversation nodes in ascending seq order (the durable stream). */
  readonly nodes: readonly ConversationNode[]
  /** Seq of the running turn's `turn/start` boundary, or null when no boundary is known in the loaded scope. */
  readonly turnStartSeq: number | null
  /** In-flight tool roots of the running turn, sorted by start time. */
  readonly runningCalls: readonly RunningToolCall[]
  /** The running assistant step's live partial, or null when nothing visible is streaming. */
  readonly partial: PartialAssistant | null
  /** The session's background-job views (the live ones are `running` or `stopping`). */
  readonly jobs: readonly SessionJob[]
  /** Epoch ms of the open compaction's start; undefined when not compacting. */
  readonly compactingSince: number | undefined
  /** The session's in-flight subagent activity map. */
  readonly activity: SubagentActivityMap
}

type ScheduledRetryPhase = Extract<PillPhase, { kind: 'retry' }>

/** Whether a node seq lies past the running turn's start boundary, or the window is unknown. */
function inTurnWindow(seq: number, turnStartSeq: number | null): boolean {
  return turnStartSeq === null || seq > turnStartSeq
}

/**
 * Pick the pill's phase for a running turn.
 *
 * The priority chain is open compaction, a scheduled model-request retry, an
 * in-flight subagent delegation, any other running tool, the assistant's live
 * stream (a reasoning tail is `thinking`, anything else visible is
 * `generating`), a live background job, then the honest fallback: `working`
 * once the turn has visible assistant output, else `first-token` while the
 * request genuinely has no chunk yet. Only published stream data, the live
 * partial, and the durable activity map feed the result, so a replayed turn
 * derives the same phase.
 *
 * @param input - published node stream, turn window, in-flight calls, live partial, job views, compaction fact, and activity map.
 * @returns the single phase the pill renders.
 */
export function derivePillPhase(input: PillPhaseInput): PillPhase {
  const { nodes, turnStartSeq, runningCalls, partial, jobs, compactingSince, activity } = input
  if (compactingSince !== undefined) return { kind: 'compaction', since: compactingSince }

  let scheduled: { seq: number; phase: ScheduledRetryPhase } | undefined
  for (const node of nodes) {
    if (node.kind !== 'model-retry' || node.retryState !== 'scheduled' || !inTurnWindow(node.seq, turnStartSeq)) continue
    if (scheduled !== undefined && node.seq <= scheduled.seq) continue
    scheduled = {
      seq: node.seq,
      phase: {
        kind: 'retry',
        retry: node.retry,
        max: 'maxRetries' in node ? node.maxRetries : undefined,
        failure: node.failure,
        at: node.time,
        delayMs: node.delayMs,
      },
    }
  }
  if (scheduled !== undefined) return scheduled.phase

  let child: { at: number; callId: string; label: string; childSessionId?: SessionId } | undefined
  for (const call of runningCalls) {
    if (!isSubagentDelegationTool(call.name)) continue
    const fact = activity[call.callId]
    if (fact === undefined) continue
    if (child === undefined || fact.at > child.at) {
      child = {
        at: fact.at,
        callId: call.callId,
        label: fact.label,
        ...fact.childSessionId !== undefined ? { childSessionId: fact.childSessionId } : {},
      }
    }
  }
  if (child !== undefined) {
    return {
      kind: 'subagent',
      callId: child.callId,
      label: child.label,
      ...child.childSessionId !== undefined ? { childSessionId: child.childSessionId } : {},
    }
  }

  const tool = runningCalls.at(-1)
  if (tool !== undefined) return { kind: 'tool', callId: tool.callId, name: tool.name }

  if (partial !== null) {
    for (let i = partial.blocks.length - 1; i >= 0; i -= 1) {
      const block = partial.blocks[i]
      if (block !== undefined && block.kind !== 'tool-call' && block.kind !== 'other') {
        return { kind: 'assistant', mode: block.kind === 'reasoning' ? 'thinking' : 'generating' }
      }
    }
  }

  let job: SessionJob | undefined
  for (const candidate of jobs) {
    if (candidate.status !== 'running' && candidate.status !== 'stopping') continue
    if (job === undefined || candidate.startedAt > job.startedAt) {
      job = candidate
    }
  }
  if (job !== undefined) return { kind: 'job', label: job.label }

  for (const node of nodes) {
    if (node.kind !== 'assistant' || !inTurnWindow(node.seq, turnStartSeq)) continue
    for (const block of node.blocks) {
      if (block.kind === 'text' || block.kind === 'reasoning' || block.kind === 'image') {
        return { kind: 'working' }
      }
    }
  }
  return { kind: 'assistant', mode: 'first-token' }
}

/**
 * Whether a running turn has already settled at least one tool result — the
 * arm that makes cancel-&-re-run worth its confirmation dialog.
 * @param nodes - the session's finalized conversation nodes in ascending seq order.
 * @param turnStartSeq - seq of the running turn's start boundary, or null when unknown.
 * @returns whether any tool result inside the turn window carries its final result.
 */
export function hasSettledTool(nodes: readonly ConversationNode[], turnStartSeq: number | null): boolean {
  for (const node of nodes) {
    if (node.kind === 'tool-result' && inTurnWindow(node.seq, turnStartSeq)) return true
  }
  return false
}

/**
 * Text of a running turn's first committed user message, for cancel & re-run.
 * @param nodes - the session's finalized conversation nodes in ascending seq order.
 * @param turnStartSeq - seq of the running turn's start boundary, or null when unknown.
 * @returns the joined text parts, or undefined when the turn opened without user text.
 */
export function firstUserPromptText(nodes: readonly ConversationNode[], turnStartSeq: number | null): string | undefined {
  for (const node of nodes) {
    if (node.kind !== 'user' || !inTurnWindow(node.seq, turnStartSeq)) continue
    const text = node.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .filter(part => part !== '')
      .join('\n')
      .trim()
    return text === '' ? undefined : text
  }
  return undefined
}
