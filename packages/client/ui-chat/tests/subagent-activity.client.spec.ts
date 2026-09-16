/** Per-session subagent-activity fold and event-window feed. */
import { describe, expect, it } from 'vitest'
import {
  MutableSessionEventSource,
  type SessionEventLikeEntry,
  type SessionEventSource,
  type SessionEventWindow,
} from '@deepseek-ai/dsh-api-session-controller/client'
// Pulls the `subagent/activity` SessionEventMap merge into this program.
import type {} from '@deepseek-ai/dsh-tool-subagent/types'
import type { SubagentActivityFact, SubagentActivityMap } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SubagentActivityKind } from '@deepseek-ai/dsh-subagent/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import {
  SubagentActivityFeed, applySubagentActivity, rebuildSubagentActivity,
} from '../src/client/subagent-activity.ts'

const at = (seq: number, e: Record<string, unknown>): SessionEvent =>
  ({ seq, time: 1_700_000_000_000 + seq, ...e }) as unknown as SessionEvent

const activity = (
  seq: number,
  callId: string,
  kind: SubagentActivityKind,
  label: string,
  provider = 'dsh',
  childSessionId?: string,
): SessionEvent =>
  at(seq, {
    type: 'subagent/activity',
    data: {
      callId, provider, kind, label,
      ...(childSessionId !== undefined ? { childSessionId } : {}),
    },
  })

const toolResult = (seq: number, callId: string): SessionEvent =>
  at(seq, { type: 'tool/result', data: { message: { source: { callId } } } })

const turnStart = (seq: number, turn: number): SessionEvent =>
  at(seq, { type: 'turn/start', data: { turn } })

const entry = (event: SessionEvent): SessionEventLikeEntry => ({ type: 'event', event })

/** A client-only live chunk; transients never touch the activity map. */
const chunk = (seq: number): SessionEventLikeEntry =>
  ({
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq,
      time: 1_700_000_000_000 + seq,
      data: { attemptId: 'a1', turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    },
  } as unknown as SessionEventLikeEntry)

const t = (seq: number): number => 1_700_000_000_000 + seq

const fact = (at: number, kind: SubagentActivityKind, label: string, provider = 'dsh', childSessionId?: string): SubagentActivityFact =>
  ({
    at, kind, label, provider,
    ...(childSessionId !== undefined ? { childSessionId: childSessionId as SessionId } : {}),
  })

describe('applySubagentActivity', () => {
  it('upserts an activity fact under the delegating call id', () => {
    const map = {}
    expect(applySubagentActivity(map, entry(activity(1, 'c1', 'tool', 'Running bash', 'dsh')))).toBe(true)
    expect(map).toEqual({ c1: { at: t(1), kind: 'tool', label: 'Running bash', provider: 'dsh' } })
  })

  it('upserts a latched local child session id onto the fact', () => {
    const map = {}
    expect(applySubagentActivity(map, entry(activity(1, 'c1', 'tool', 'Running bash', 'dsh', 'child-1')))).toBe(true)
    expect(map).toStrictEqual({ c1: { at: t(1), kind: 'tool', label: 'Running bash', provider: 'dsh', childSessionId: 'child-1' } })
  })

  it('keeps the child id key absent for an unlatched fact', () => {
    const map = {}
    expect(applySubagentActivity(map, entry(activity(1, 'c1', 'tool', 'Running bash')))).toBe(true)
    expect(map).toStrictEqual({ c1: { at: t(1), kind: 'tool', label: 'Running bash', provider: 'dsh' } })
  })

  it('treats a moved or dropped child id as a changed fact', () => {
    // Latched → different id: the latch rewrites the fact even when nothing else moved.
    let map: SubagentActivityMap = { c1: fact(t(1), 'tool', 'Running bash', 'dsh', 'child-1') }
    expect(applySubagentActivity(map, entry(activity(1, 'c1', 'tool', 'Running bash', 'dsh', 'child-2')))).toBe(true)
    expect(map).toStrictEqual({ c1: { at: t(1), kind: 'tool', label: 'Running bash', provider: 'dsh', childSessionId: 'child-2' } })
    // Latched → unlatched and unlatched → latched are changes too.
    map = { c1: fact(t(1), 'tool', 'Running bash', 'dsh', 'child-1') }
    expect(applySubagentActivity(map, entry(activity(1, 'c1', 'tool', 'Running bash')))).toBe(true)
    expect(map).toStrictEqual({ c1: { at: t(1), kind: 'tool', label: 'Running bash', provider: 'dsh' } })
    map = { c1: fact(t(1), 'tool', 'Running bash') }
    expect(applySubagentActivity(map, entry(activity(1, 'c1', 'tool', 'Running bash', 'dsh', 'child-1')))).toBe(true)
    expect(map).toStrictEqual({ c1: { at: t(1), kind: 'tool', label: 'Running bash', provider: 'dsh', childSessionId: 'child-1' } })
  })

  it('leaves an identical fact untouched', () => {
    const map: SubagentActivityMap = { c1: fact(t(1), 'tool', 'Running bash') }
    const before = map.c1
    expect(applySubagentActivity(map, entry(activity(1, 'c1', 'tool', 'Running bash', 'dsh')))).toBe(false)
    expect(map.c1).toBe(before)
  })

  it('replaces a moved fact on the same call', () => {
    const map: SubagentActivityMap = { c1: fact(t(1), 'output', 'Producing') }
    expect(applySubagentActivity(map, entry(activity(2, 'c1', 'tool', 'Running bash', 'dsh')))).toBe(true)
    expect(map.c1).toEqual({ at: t(2), kind: 'tool', label: 'Running bash', provider: 'dsh' })
  })

  it('prunes a settled delegation on its tool/result', () => {
    const map: SubagentActivityMap = { c1: fact(t(1), 'tool', 'Running bash') }
    expect(applySubagentActivity(map, entry(toolResult(2, 'c1')))).toBe(true)
    expect(map).toEqual({})
  })

  it('ignores a tool/result for a call with no fact', () => {
    expect(applySubagentActivity({}, entry(toolResult(2, 'c1')))).toBe(false)
  })

  it('ignores every other durable entry', () => {
    const map: SubagentActivityMap = { c1: fact(t(1), 'tool', 'Running bash') }
    expect(applySubagentActivity(map, entry(turnStart(2, 1)))).toBe(false)
    expect(map).toEqual({ c1: { at: t(1), kind: 'tool', label: 'Running bash', provider: 'dsh' } })
  })

  it('ignores transient live chunks', () => {
    expect(applySubagentActivity({}, chunk(1))).toBe(false)
  })
})

describe('rebuildSubagentActivity', () => {
  it('folds the window in log order, pruning settled delegations', () => {
    const entries = [
      entry(turnStart(1, 1)),
      entry(activity(2, 'c1', 'output', 'Producing')),
      entry(activity(3, 'c1', 'tool', 'Running bash')),
      entry(toolResult(4, 'c1')),
      entry(activity(5, 'c2', 'tool', 'Running read')),
    ]
    expect(rebuildSubagentActivity(entries)).toEqual({
      c2: { at: t(5), kind: 'tool', label: 'Running read', provider: 'dsh' },
    })
  })

  it('rebuilds an empty window', () => {
    expect(rebuildSubagentActivity([])).toEqual({})
  })

  it('carries a latched child id through the fold until the call settles', () => {
    const entries = [
      entry(activity(2, 'c1', 'output', 'Producing', 'dsh', 'child-1')),
      entry(activity(3, 'c1', 'tool', 'Running bash', 'dsh', 'child-1')),
      entry(toolResult(4, 'c1')),
      entry(activity(5, 'c2', 'tool', 'Running read', 'dsh', 'child-2')),
    ]
    expect(rebuildSubagentActivity(entries)).toStrictEqual({
      c2: { at: t(5), kind: 'tool', label: 'Running read', provider: 'dsh', childSessionId: 'child-2' },
    })
  })
})

describe('SubagentActivityFeed', () => {
  it('publishes the folded window at construction with a stable snapshot', () => {
    const source = new MutableSessionEventSource()
    source.replace([
      entry(activity(1, 'c1', 'tool', 'Running bash')),
      entry(toolResult(2, 'c1')),
      entry(activity(3, 'c2', 'output', 'Producing')),
    ], false)
    const feed = new SubagentActivityFeed(source)
    expect(feed.store.getSnapshot()).toEqual({ c2: { at: t(3), kind: 'output', label: 'Producing', provider: 'dsh' } })
    expect(feed.store.getSnapshot()).toBe(feed.store.getSnapshot())
    feed.dispose()
  })

  it('applies appended entries incrementally', () => {
    const source = new MutableSessionEventSource()
    source.replace([entry(activity(1, 'c1', 'tool', 'Running bash'))], false)
    const feed = new SubagentActivityFeed(source)
    source.append(entry(activity(2, 'c2', 'output', 'Producing')))
    expect(feed.store.getSnapshot()).toEqual({
      c1: { at: t(1), kind: 'tool', label: 'Running bash', provider: 'dsh' },
      c2: { at: t(2), kind: 'output', label: 'Producing', provider: 'dsh' },
    })
    source.append(entry(toolResult(3, 'c1')))
    expect(feed.store.getSnapshot()).toEqual({ c2: { at: t(2), kind: 'output', label: 'Producing', provider: 'dsh' } })
    feed.dispose()
  })

  it('keeps the snapshot reference stable when an append changes nothing', () => {
    const source = new MutableSessionEventSource()
    source.replace([entry(activity(1, 'c1', 'tool', 'Running bash'))], false)
    const feed = new SubagentActivityFeed(source)
    const before = feed.store.getSnapshot()
    source.append(entry(turnStart(2, 1)))
    expect(feed.store.getSnapshot()).toBe(before)
    feed.dispose()
  })

  it('rescans the whole window on replace and prepend', () => {
    const source = new MutableSessionEventSource()
    source.replace([entry(activity(1, 'c1', 'tool', 'Running bash'))], false)
    const feed = new SubagentActivityFeed(source)
    source.replace([entry(activity(9, 'c2', 'tool', 'Other')), entry(toolResult(10, 'c2'))], false)
    expect(feed.store.getSnapshot()).toEqual({})
    source.prepend([entry(activity(5, 'c3', 'output', 'Producing'))], true)
    expect(feed.store.getSnapshot()).toEqual({ c3: { at: t(5), kind: 'output', label: 'Producing', provider: 'dsh' } })
    feed.dispose()
  })

  it('treats a settled-assistant publication as a no-op', () => {
    const source = new MutableSessionEventSource()
    source.replace([entry(activity(1, 'c1', 'tool', 'Running bash'))], false)
    const feed = new SubagentActivityFeed(source)
    const before = feed.store.getSnapshot()
    source.settleAssistant('a1' as never)
    expect(feed.store.getSnapshot()).toBe(before)
    feed.dispose()
  })

  it('no-ops on an unchanged revision and rescans across a revision gap', () => {
    // The real Session feed advances one revision per publication; this
    // hand-crafted source drives the defensive branches a missed publication
    // or a replaced window could reach.
    let window: SessionEventWindow = windowOf(1, 'replace', [entry(activity(1, 'c1', 'tool', 'Running bash'))])
    const listeners = new Set<() => void>()
    const source: SessionEventSource = {
      getSnapshot: () => window,
      subscribe: (fn) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    }
    const notify = (): void => { for (const fn of [...listeners]) fn() }
    const feed = new SubagentActivityFeed(source)
    expect(feed.store.getSnapshot()).toEqual({ c1: { at: t(1), kind: 'tool', label: 'Running bash', provider: 'dsh' } })
    const first = feed.store.getSnapshot()
    window = windowOf(1, 'replace', [entry(activity(1, 'c1', 'tool', 'Running bash'))])
    notify()
    expect(feed.store.getSnapshot()).toBe(first)
    window = windowOf(3, 'replace', [entry(activity(2, 'c2', 'output', 'Producing'))])
    notify()
    expect(feed.store.getSnapshot()).toEqual({ c2: { at: t(2), kind: 'output', label: 'Producing', provider: 'dsh' } })
    feed.dispose()
  })

  it('stops following after dispose and tolerates a second call', () => {
    const source = new MutableSessionEventSource()
    source.replace([entry(activity(1, 'c1', 'tool', 'Running bash'))], false)
    const feed = new SubagentActivityFeed(source)
    const before = feed.store.getSnapshot()
    feed.dispose()
    source.append(entry(activity(2, 'c2', 'output', 'Producing')))
    expect(feed.store.getSnapshot()).toBe(before)
    feed.dispose()
  })
})

function windowOf(
  revision: number,
  kind: 'replace' | 'prepend' | 'append',
  entries: readonly SessionEventLikeEntry[],
): SessionEventWindow {
  return { entries, hasMore: false, revision, change: { kind, entries } }
}
