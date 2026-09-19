// @vitest-environment jsdom
/**
 * StreamingNarrator over a controllable Chat snapshot: complete sentences
 * start and append as the running step grows, settling flushes the tail,
 * binds the durable message id, and finishes; auto-read off emits nothing;
 * a newer running step takes over from the old read; a rewritten projection
 * abandons streaming but still marks the message spoken at settle; an
 * interrupted settle flushes without binding; unmount pauses the read; and a
 * remounted narrator resumes from saved progress, including a tail that
 * settled while the Session was away.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  AssistantBlock, AssistantMessageNode, ChatConversationViewNode, ChatNode, ChatSnapshot,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import { zh } from '../src/client/locales.ts'
import type { ReadAloudStreamProps } from '../src/client/slots.ts'
import type { StreamNarrationState } from '../src/client/streaming.ts'
import { StreamingNarrator } from '../src/client/StreamingNarrator.tsx'

const t = makeTranslate(zh, commonZh)

type Step = ChatNode<'assistant-step'>

function textBlock(text: string): AssistantBlock {
  return { kind: 'text', text }
}

/** A running Assistant step whose text may still grow. */
function running(key: string, text: string, turn = 1, step = 1): Step {
  return {
    key,
    kind: 'assistant-step',
    data: { status: 'running', turn, step, blocks: [textBlock(text)], time: 0 },
  } as unknown as Step
}

/** A settled Assistant step, with a durable id unless `messageId` is null. */
function settled(key: string, text: string, messageId: MessageId | null, turn = 1, step = 1): Step {
  const blocks = [textBlock(text)]
  const final: AssistantMessageNode = {
    kind: 'assistant',
    seq: 1,
    ...(messageId === null ? {} : { messageId }),
    time: 0,
    turn,
    step,
    blocks,
  }
  return {
    key,
    kind: 'assistant-step',
    data: { status: 'settled', turn, step, blocks, time: 0, finalNode: final },
  } as unknown as Step
}

/** The fixture Chat snapshot: the nodes the narrator scans, newest last. */
function chatSnapshot(rows: readonly Step[]): ChatSnapshot {
  const map = new Map(rows.map(row => [row.key, row as unknown as ChatConversationViewNode]))
  return {
    order: rows.map(row => row.key),
    nodes: {
      get: (key: string) => map.get(key),
      source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
      processSource: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
      values: () => [...map.values()],
    },
    locations: { getTurn: () => [], getStep: () => [] },
    navigation: { items: () => [] },
    timeline: { turnOrder: [], turns: new Map() },
    legacy: {
      nodes: [],
      turnTimings: new Map(),
      turnEnds: new Map(),
      partial: null,
      runningCalls: [],
    },
  }
}

/** A snapshot with arbitrary node kinds, for selector scan coverage. */
function rawSnapshot(entries: ReadonlyArray<[string, ChatConversationViewNode]>): ChatSnapshot {
  const base = chatSnapshot([])
  const map = new Map(entries)
  return {
    ...base,
    order: entries.map(([key]) => key),
    nodes: { ...base.nodes, get: (key: string) => map.get(key) },
  }
}

/** Mount the narrator over a live Chat snapshot and scripted verbs. */
function mount(rows: readonly Step[], autoRead = true) {
  const chat = createSnapshotStore(chatSnapshot(rows))
  const pref = createSnapshotStore(autoRead)
  // A miniature director: live reads and saved projection progress per key.
  // A finished read stays live while its queued audio drains, as the real
  // director's does, so finish() only marks it done.
  const live = new Set<string>()
  const saved = new Map<string, StreamNarrationState>()
  const start = vi.fn((key: string) => { live.add(key) })
  const append = vi.fn()
  const bind = vi.fn()
  const finish = vi.fn()
  const observe = vi.fn()
  const pauseSession = vi.fn()
  const isStreaming = vi.fn((key: string) => live.has(key))
  const loadNarration = vi.fn((key: string) => saved.get(key))
  const saveNarration = vi.fn((key: string, state: StreamNarrationState | undefined) => {
    if (state === undefined) saved.delete(key)
    else saved.set(key, state)
  })
  const props = {
    useChat: bindSnapshotSelector(chat),
    useAutoRead: bindSnapshotSelector(pref),
    start,
    append,
    bind,
    finish,
    observe,
    pauseSession,
    isStreaming,
    loadNarration,
    saveNarration,
    t,
  } as unknown as ReadAloudStreamProps
  const narrate = (): ReturnType<typeof render> => render(<StreamingNarrator {...props} />)
  const ui = narrate()
  return {
    ...ui,
    start,
    append,
    bind,
    finish,
    observe,
    pauseSession,
    isStreaming,
    loadNarration,
    saveNarration,
    pref,
    live,
    saved,
    remount: (): void => { narrate() },
    update: (next: readonly Step[]): void => {
      act(() => { chat.set(chatSnapshot(next)) })
    },
    set: (next: ChatSnapshot): void => {
      act(() => { chat.set(next) })
    },
  }
}

afterEach(cleanup)

describe('StreamingNarrator', () => {
  it('records the running node so its live completion can auto-read', () => {
    const ui = mount([running('k1', 'One sentence. Two')])
    expect(ui.observe).toHaveBeenCalledWith('k1')

    ui.update([settled('k1', 'One sentence. Two.', 'm1' as MessageId)])
    expect(ui.observe).toHaveBeenCalledTimes(1)
  })

  it('starts on the first complete sentence and appends as more complete', () => {
    const ui = mount([running('k1', 'One sentence. Two')])

    expect(ui.start).toHaveBeenCalledTimes(1)
    expect(ui.start).toHaveBeenCalledWith('k1', expect.objectContaining({
      blockIndex: 0, text: 'One sentence.',
    }))
    expect(ui.append).not.toHaveBeenCalled()

    ui.update([running('k1', 'One sentence. Two sentence. Three')])

    expect(ui.append).toHaveBeenCalledTimes(1)
    expect(ui.append).toHaveBeenCalledWith('k1', expect.objectContaining({ text: 'Two sentence.' }))
    expect(ui.finish).not.toHaveBeenCalled()
  })

  it('maps each utterance onto its source ranges through the block segments', () => {
    const ui = mount([running('k1', 'First sentence. **Second part**')])

    expect(ui.start).toHaveBeenCalledWith('k1', expect.objectContaining({
      text: 'First sentence.',
      segments: [{ start: 0, end: 15, sourceStart: 0, sourceEnd: 15 }],
    }))
  })

  it('scans past non-assistant rows for the newest Assistant node', () => {
    const ui = mount([])
    ui.set(rawSnapshot([
      ['k1', running('k1', 'One sentence. Two')],
      ['user', { key: 'user', kind: 'user' } as unknown as ChatConversationViewNode],
    ]))

    expect(ui.start).toHaveBeenCalledWith('k1', expect.objectContaining({ text: 'One sentence.' }))
  })

  it('finishes the live read when the Assistant row disappears', () => {
    const ui = mount([running('k1', 'One sentence. Two')])

    ui.update([])

    expect(ui.finish).toHaveBeenCalledWith('k1')
  })

  it('flushes the tail, binds the durable id, and finishes at settle', () => {
    const ui = mount([running('k1', 'Done. Tail part')])
    expect(ui.start).toHaveBeenCalledWith('k1', expect.objectContaining({ text: 'Done.' }))

    ui.update([settled('k1', 'Done. Tail part', 'm1' as MessageId)])

    expect(ui.append).toHaveBeenCalledWith('k1', expect.objectContaining({ text: 'Tail part' }))
    expect(ui.bind).toHaveBeenCalledWith('k1', 'm1')
    expect(ui.finish).toHaveBeenCalledWith('k1')
  })

  it('flushes an interrupted settle without binding', () => {
    const ui = mount([running('k1', 'Only partial')])
    expect(ui.start).not.toHaveBeenCalled()

    ui.update([settled('k1', 'Only partial', null)])

    expect(ui.start).toHaveBeenCalledWith('k1', expect.objectContaining({ text: 'Only partial' }))
    expect(ui.bind).not.toHaveBeenCalled()
    expect(ui.finish).toHaveBeenCalledWith('k1')
  })

  it('emits nothing with auto-read off', () => {
    const ui = mount([running('k1', 'One sentence. Two')], false)

    expect(ui.start).not.toHaveBeenCalled()
    expect(ui.append).not.toHaveBeenCalled()

    // Turning the preference off mid-read finishes the live read quietly.
    ui.update([running('k1', 'One sentence. Two sentence. Three')])
    expect(ui.start).not.toHaveBeenCalled()
  })

  it('finishes the live read when the preference turns off mid-stream', () => {
    const ui = mount([running('k1', 'One sentence. Two')])
    expect(ui.start).toHaveBeenCalledTimes(1)

    act(() => { ui.pref.set(false) })

    expect(ui.finish).toHaveBeenCalledWith('k1')
  })

  it('hands over when a newer sibling step starts running', () => {
    const ui = mount([running('k1', 'Old sentence. More')])
    expect(ui.start).toHaveBeenLastCalledWith('k1', expect.objectContaining({ text: 'Old sentence.' }))

    ui.update([running('k1', 'Old sentence. More'), running('k2', 'New sentence. More', 1, 2)])

    expect(ui.finish).toHaveBeenCalledWith('k1')
    expect(ui.start).toHaveBeenLastCalledWith('k2', expect.objectContaining({ text: 'New sentence.' }))
  })

  it('abandons a rewritten projection and lets settle mark the message spoken', () => {
    const ui = mount([running('k1', 'Original sentence. More')])
    expect(ui.start).toHaveBeenCalledTimes(1)

    ui.update([running('k1', 'Rewritten.')])

    expect(ui.finish).toHaveBeenCalledWith('k1')
    expect(ui.append).not.toHaveBeenCalled()
    expect(ui.saved.has('k1')).toBe(false)

    // Still running with a rewritten projection: the narrator stays out.
    ui.update([running('k1', 'Rewritten. More')])
    expect(ui.start).toHaveBeenCalledTimes(1)

    ui.update([settled('k1', 'Rewritten.', 'm1' as MessageId)])

    expect(ui.bind).toHaveBeenCalledWith('k1', 'm1')
    expect(ui.append).not.toHaveBeenCalled()
  })

  it('abandons a divergence before anything was spoken without finishing', () => {
    const ui = mount([running('k1', 'Partial only')])
    expect(ui.start).not.toHaveBeenCalled()

    ui.update([running('k1', 'Different partial')])
    expect(ui.finish).not.toHaveBeenCalled()
    expect(ui.bind).not.toHaveBeenCalled()

    ui.update([settled('k1', 'Different partial.', 'm1' as MessageId)])
    expect(ui.bind).toHaveBeenCalledWith('k1', 'm1')
  })

  it('abandons a rewritten stopped read without touching it', () => {
    const ui = mount([running('k1', 'One sentence. More')])
    expect(ui.start).toHaveBeenCalledTimes(1)

    // The user stopped the read; only its saved progress remains.
    ui.live.clear()
    ui.unmount()
    ui.remount()
    ui.update([running('k1', 'Rewritten.')])

    expect(ui.finish).not.toHaveBeenCalled()
    expect(ui.append).not.toHaveBeenCalled()
    expect(ui.saved.has('k1')).toBe(false)
  })

  it('reads a rewrite at settle when nothing was spoken yet, binding nothing', () => {
    const ui = mount([running('k1', 'Partial only')])
    ui.update([running('k1', 'Different')])
    // Nothing was emitted, so the spoken-prefix rule keeps the stream alive.
    expect(ui.finish).not.toHaveBeenCalled()

    ui.update([settled('k1', 'Different.', null)])

    expect(ui.start).toHaveBeenCalledWith('k1', expect.objectContaining({ text: 'Different.' }))
    expect(ui.bind).not.toHaveBeenCalled()
    expect(ui.finish).toHaveBeenCalledWith('k1')
  })

  it('does not append a tail whose settled projection was rewritten', () => {
    const ui = mount([running('k1', 'Original sentence. More')])

    ui.update([settled('k1', 'Completely different.', 'm1' as MessageId)])

    expect(ui.append).not.toHaveBeenCalled()
    expect(ui.bind).toHaveBeenCalledWith('k1', 'm1')
    expect(ui.finish).toHaveBeenCalledWith('k1')
  })

  it('ignores a settled node it never streamed', () => {
    const ui = mount([settled('k1', 'Text.', 'm1' as MessageId)])

    expect(ui.bind).not.toHaveBeenCalled()
    expect(ui.finish).not.toHaveBeenCalled()
  })

  it('does nothing without an Assistant node', () => {
    const ui = mount([])

    expect(ui.start).not.toHaveBeenCalled()
    expect(ui.append).not.toHaveBeenCalled()
    expect(ui.finish).not.toHaveBeenCalled()
  })

  it('pauses the read when it unmounts mid-stream', () => {
    const ui = mount([running('k1', 'One sentence. Two')])
    expect(ui.start).toHaveBeenCalledTimes(1)

    ui.unmount()

    expect(ui.pauseSession).toHaveBeenCalledTimes(1)
    expect(ui.finish).not.toHaveBeenCalled()
  })

  it('resumes a paused read from saved progress after a remount', () => {
    const ui = mount([running('k1', 'One sentence. Two')])
    expect(ui.start).toHaveBeenCalledTimes(1)

    ui.unmount()
    expect(ui.pauseSession).toHaveBeenCalledTimes(1)

    ui.remount()
    ui.update([running('k1', 'One sentence. Two sentence.')])

    expect(ui.start).toHaveBeenCalledTimes(1)
    expect(ui.append).toHaveBeenCalledWith('k1', expect.objectContaining({ text: 'Two sentence.' }))
  })

  it('flushes a tail that settled while the Session was away', () => {
    const ui = mount([running('k1', 'First. Tail part')])
    expect(ui.start).toHaveBeenCalledWith('k1', expect.objectContaining({ text: 'First.' }))

    ui.unmount()
    ui.update([settled('k1', 'First. Tail part', 'm1' as MessageId)])
    ui.remount()

    expect(ui.append).toHaveBeenCalledWith('k1', expect.objectContaining({ text: 'Tail part' }))
    expect(ui.bind).toHaveBeenCalledWith('k1', 'm1')
    expect(ui.finish).toHaveBeenCalledWith('k1')
    expect(ui.saved.has('k1')).toBe(false)
  })

  it('does not replay the message while the finished read is still draining', () => {
    const ui = mount([running('k1', 'First. Tail part')])
    expect(ui.start).toHaveBeenCalledTimes(1)

    ui.update([settled('k1', 'First. Tail part', 'm1' as MessageId)])
    expect(ui.append).toHaveBeenCalledWith('k1', expect.objectContaining({ text: 'Tail part' }))
    const appended = ui.append.mock.calls.length

    // The director keeps the read streaming while its tail drains; further
    // passes over the settled node must not adopt it and flush the full text.
    ui.update([settled('k1', 'First. Tail part', 'm1' as MessageId)])
    ui.update([settled('k1', 'First. Tail part', 'm1' as MessageId)])

    expect(ui.append.mock.calls.length).toBe(appended)
    expect(ui.start).toHaveBeenCalledTimes(1)
  })

  it('marks an abandoned settle without a durable id as handled', () => {
    const ui = mount([running('k1', 'Original sentence. More')])
    ui.update([running('k1', 'Rewritten.')])
    expect(ui.finish).toHaveBeenCalledWith('k1')

    ui.update([settled('k1', 'Rewritten.', null)])

    expect(ui.bind).not.toHaveBeenCalled()
    expect(ui.finish).toHaveBeenCalledTimes(1)
  })
})
