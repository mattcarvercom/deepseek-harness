import { describe, expect, it } from 'vitest'
import {
  PendingInboxPrompts,
  type FoldableSessionEvent,
} from '../src/client/sessions/pending-inbox-prompts.ts'
import { inboxUserMessage as userMsg } from './event-script.client.ts'

type Ev = FoldableSessionEvent

function pluginMsg(id: string, text: string) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin' } }
}

// The engine's splice payload always carries `inserted` (empty for removals).
const insert = (target: string, start: number, inserted: unknown[]): Ev => (
  { type: 'agent/inbox/spliced', data: { target, start, inserted } }
)
const claim = (target: string, start: number, removedCount: number): Ev => (
  { type: 'agent/inbox/spliced', data: { target, start, removedCount, inserted: [] } }
)
const cancel = (target: string, start: number, removedCount: number): Ev => (
  { type: 'agent/inbox/spliced', data: { target, start, removedCount, inserted: [], outcome: 'canceled' } }
)
const replace = (target: string, start: number, inserted: unknown[]): Ev => (
  { type: 'agent/inbox/spliced', data: { target, start, removedCount: 1, inserted, outcome: 'canceled' } }
)
const turnStart = (turn: number): Ev => ({ type: 'turn/start', data: { turn } })
const turnEnd = (turn: number): Ev => ({ type: 'turn/end', data: { turn, reason: 'end' } })
const commit = (id: string, rpcId?: string): Ev => (
  { type: 'user/message', data: userMsg(id, 'irrelevant', rpcId) }
)

describe('PendingInboxPrompts', () => {
  it('surfaces a queued user prompt from an insert splice', () => {
    const fold = new PendingInboxPrompts()
    expect(fold.append(insert('next-turn', 0, [userMsg('m1', 'first', 'rpc-1')]))).toBe(true)
    expect(fold.snapshot()).toEqual([
      {
        id: 'm1',
        placement: 'queued',
        rpcId: 'rpc-1',
        content: [{ type: 'text', text: 'first' }],
        preview: 'first',
        text: 'first',
      },
    ])
  })

  it('drops a queued prompt once it is committed as user/message', () => {
    const fold = new PendingInboxPrompts()
    fold.reset([
      insert('next-turn', 0, [userMsg('m1', 'first', 'rpc-1')]),
      turnStart(1),
      claim('next-turn', 0, 1),
      commit('m1', 'rpc-1'),
    ])
    expect(fold.snapshot()).toEqual([])
  })

  it('keeps a claimed prompt through the claim→commit window and retires it at turn/end', () => {
    const fold = new PendingInboxPrompts()
    fold.reset([
      insert('next-step', 0, [userMsg('m1', 'steer', 'rpc-1')]),
      turnStart(1),
      claim('next-step', 0, 1),
    ])
    expect(fold.snapshot()).toEqual([
      {
        id: 'm1',
        placement: 'steering',
        rpcId: 'rpc-1',
        content: [{ type: 'text', text: 'steer' }],
        preview: 'steer',
        text: 'steer',
      },
    ])
    expect(fold.append(turnEnd(1))).toBe(true)
    expect(fold.snapshot()).toEqual([])
  })

  it('does not claim a canceled splice: removed prompts never become model-visible', () => {
    const fold = new PendingInboxPrompts()
    fold.reset([
      insert('next-turn', 0, [userMsg('m1', 'first')]),
      insert('next-turn', 1, [userMsg('m2', 'second')]),
    ])
    expect(fold.append(cancel('next-turn', 0, 2))).toBe(true)
    expect(fold.snapshot()).toEqual([])
  })

  it('tracks a replacement in place of the replaced prompt', () => {
    const fold = new PendingInboxPrompts()
    fold.reset([insert('next-turn', 0, [userMsg('m1', 'old')])])
    expect(fold.append(replace('next-turn', 0, [userMsg('m2', 'new', 'rpc-2')]))).toBe(true)
    expect(fold.snapshot()).toEqual([
      {
        id: 'm2',
        placement: 'queued',
        rpcId: 'rpc-2',
        content: [{ type: 'text', text: 'new' }],
        preview: 'new',
        text: 'new',
      },
    ])
  })

  it('skips non-user sources: plugin and model projections are not user prompts', () => {
    const fold = new PendingInboxPrompts()
    fold.reset([
      insert('next-turn', 0, [pluginMsg('p1', 'context')]),
      insert('next-turn', 1, [userMsg('m1', 'mine', 'rpc-1')]),
    ])
    expect(fold.snapshot()).toEqual([
      {
        id: 'm1',
        placement: 'queued',
        rpcId: 'rpc-1',
        content: [{ type: 'text', text: 'mine' }],
        preview: 'mine',
        text: 'mine',
      },
    ])
  })

  it('tolerates a bounded-window claim whose removed slice predates the fold: skips, never throws', () => {
    const fold = new PendingInboxPrompts()
    // The claim references the pre-window list (one removed at head); the fold
    // only saw the later insert, so the removed identity is unrecoverable.
    expect(() => fold.append(claim('next-turn', 0, 1))).not.toThrow()
    expect(fold.snapshot()).toEqual([])
    // A later valid claim of the folded state still works.
    fold.reset([
      insert('next-turn', 0, [userMsg('m1', 'first', 'rpc-1')]),
      claim('next-turn', 0, 1),
    ])
    // No open turn at claim time: the message is removed but never stamped,
    // so it stays untracked (it surfaces through its durable commit instead).
    expect(fold.snapshot()).toEqual([])
  })

  it('prepends history insert splices with duplicate-id rejection only', () => {
    const fold = new PendingInboxPrompts()
    fold.reset([insert('next-turn', 0, [userMsg('m2', 'newer')])])
    // Page older than the window: one insert for an id the fold already has
    // (dedupe) and one for an id it does not (recovered).
    expect(fold.prepend([
      insert('next-turn', 0, [userMsg('m2', 'newer')]),
      insert('next-turn', 0, [userMsg('m1', 'older', 'rpc-1')]),
    ])).toBe(true)
    expect(fold.snapshot()).toEqual([
      {
        id: 'm2',
        placement: 'queued',
        content: [{ type: 'text', text: 'newer' }],
        preview: 'newer',
        text: 'newer',
      },
      {
        id: 'm1',
        placement: 'queued',
        rpcId: 'rpc-1',
        content: [{ type: 'text', text: 'older' }],
        preview: 'older',
        text: 'older',
      },
    ])
  })

  it('ignores history removals and turn events: they describe past states, not the current fold', () => {
    const fold = new PendingInboxPrompts()
    fold.reset([
      insert('next-turn', 0, [userMsg('m1', 'still pending', 'rpc-1')]),
      turnStart(7),
      claim('next-step', 0, 1),
      turnEnd(7),
    ])
    expect(fold.snapshot()).toHaveLength(1)
    // A page whose only effects are a removal, a turn pair, and a commit of
    // old material leaves the current fold untouched.
    expect(fold.prepend([
      claim('next-turn', 0, 1),
      turnStart(3),
      turnEnd(3),
      commit('old-1'),
    ])).toBe(false)
    expect(fold.snapshot()).toEqual([
      {
        id: 'm1',
        placement: 'queued',
        rpcId: 'rpc-1',
        content: [{ type: 'text', text: 'still pending' }],
        preview: 'still pending',
        text: 'still pending',
      },
    ])
  })

  it('retires a claimed prompt by rpcId when the commit carries a different id', () => {
    const fold = new PendingInboxPrompts()
    fold.reset([
      insert('next-turn', 0, [userMsg('m1', 'first', 'rpc-1')]),
      turnStart(1),
      claim('next-turn', 0, 1),
    ])
    expect(fold.append(commit('m1-renamed', 'rpc-1'))).toBe(true)
    expect(fold.snapshot()).toEqual([])
  })

  it('retires a committed id left in the projection when its claim splice was skipped', () => {
    const fold = new PendingInboxPrompts()
    fold.reset([
      insert('next-turn', 0, [userMsg('m1', 'first', 'rpc-1')]),
      insert('next-turn', 1, [userMsg('m2', 'second', 'rpc-2')]),
      turnStart(1),
      // start 5 exceeds the folded list: the claim is skipped and m1 stays in
      // the projection at commit time.
      claim('next-turn', 5, 1),
      commit('m1', 'rpc-1'),
    ])
    expect(fold.snapshot()).toEqual([
      {
        id: 'm2',
        placement: 'queued',
        rpcId: 'rpc-2',
        content: [{ type: 'text', text: 'second' }],
        preview: 'second',
        text: 'second',
      },
    ])
  })

  it('retires a listed prompt by rpcId when the compact commit record lost its id', () => {
    const fold = new PendingInboxPrompts()
    fold.reset([insert('next-turn', 0, [userMsg('m1', 'first', 'rpc-1')])])
    const compact: Ev = {
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user', rpcId: 'rpc-1' },
        content: [{ type: 'text', text: 'irrelevant' }],
      },
    }
    expect(fold.append(compact)).toBe(true)
    expect(fold.snapshot()).toEqual([])
  })

  it('reports no snapshot-visible change for turn markers alone', () => {
    const fold = new PendingInboxPrompts()
    expect(fold.append(turnStart(1))).toBe(false)
    expect(fold.append(turnEnd(1))).toBe(false)
    expect(fold.append({ type: 'agent/step/start', data: {} })).toBe(false)
  })

  it('orders the snapshot: next-turn, then next-step, then claimed in claim order', () => {
    const fold = new PendingInboxPrompts()
    fold.reset([
      insert('next-turn', 0, [userMsg('q1', 'q1')]),
      insert('next-turn', 1, [userMsg('q2', 'q2')]),
      insert('next-step', 0, [userMsg('s1', 's1')]),
      insert('next-step', 1, [userMsg('s2', 's2')]),
      turnStart(1),
      claim('next-turn', 0, 1),
      claim('next-step', 0, 1),
    ])
    expect(fold.snapshot().map(entry => entry.id)).toEqual(['q2', 's2', 'q1', 's1'])
  })
})
