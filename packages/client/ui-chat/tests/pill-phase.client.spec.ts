/**
 * Pure derivation of the running-turn pill phase and run-action arms over the
 * published data-level channels: the durable node stream, the turn window,
 * in-flight calls, the live partial, job views, and the activity map.
 */
import { describe, expect, it } from 'vitest'
import type { SessionJob } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  AssistantBlock, AssistantMessageNode, ConversationNode, ModelRetryNode,
  PartialAssistant, RunningToolCall, SteeringMessageNode, SubagentActivityFact,
  SubagentActivityMap, ToolResultNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentActivityKind } from '@deepseek-ai/dsh-subagent/client'
import { derivePillPhase, firstUserPromptText, hasSettledTool } from '../src/client/chat/pill-phase.ts'

const T = 1_700_000_000_000

const running = (callId: string, name: string): RunningToolCall => ({
  callId, name, argsRaw: '{}', turn: 1, step: 1, time: T, subCalls: [],
})
const settled = (seq: number, callId: string, name: string): ToolResultNode => ({
  kind: 'tool-result', seq, time: T + seq, callId,
  call: { name, argsRaw: '{}' }, callTime: T + seq - 500,
  content: [], isError: false, subCalls: [],
})

const retryNormal = (seq: number, retry = 1, retryState: ModelRetryNode['retryState'] = 'scheduled'): ModelRetryNode => ({
  kind: 'model-retry', retryId: 'pill-retry' as ModelRetryNode['retryId'],
  seq, time: T + seq, turn: 1, step: 0, retryState,
  provider: 'mock', mode: 'normal', policyKey: 'mock-normal',
  retry, maxRetries: 2, delayMs: 450,
  failure: { code: 'TRANSPORT', message: '连接被重置' },
})
const retryAlways = (seq: number, retry = 1, retryState: ModelRetryNode['retryState'] = 'scheduled'): ModelRetryNode => ({
  kind: 'model-retry', retryId: 'pill-retry' as ModelRetryNode['retryId'],
  seq, time: T + seq, turn: 1, step: 0, retryState,
  provider: 'mock', mode: 'always', policyKey: 'mock-always',
  retry, delayMs: 450,
  failure: { code: 'TRANSPORT', message: '连接被重置' },
})

const user = (seq: number, texts: readonly string[]): UserMessageNode => ({
  kind: 'user', seq, time: T + seq,
  content: texts.map(text => ({ type: 'text', text })) as never, source: null,
})
const steering = (seq: number, text: string): SteeringMessageNode => ({
  kind: 'steering',
  messageId: `steering-${String(seq)}` as SteeringMessageNode['messageId'],
  seq, time: T + seq, content: [{ type: 'text', text }] as never, source: null,
})
const assistant = (seq: number, turn: number, step: number, blocks: readonly AssistantBlock[]): AssistantMessageNode => ({
  kind: 'assistant', seq, time: T + seq, turn, step, blocks,
})
const partial = (turn: number, step: number, blocks: readonly AssistantBlock[]): PartialAssistant => ({ turn, step, blocks })
const job = (label: string, status: SessionJob['status'], startedAt: number): SessionJob => ({
  id: `job-${label}` as SessionJob['id'], kind: 'bash', label, status, startedAt,
})

const fact = (at: number, kind: SubagentActivityKind, label: string, provider = 'dsh', childSessionId?: string): SubagentActivityFact =>
  ({
    at, kind, label, provider,
    ...(childSessionId !== undefined ? { childSessionId: childSessionId as SessionId } : {}),
  })

interface PhaseOptions {
  turnStartSeq?: number | null
  runningCalls?: readonly RunningToolCall[]
  partial?: PartialAssistant | null
  jobs?: readonly SessionJob[]
  compactingSince?: number
  activity?: SubagentActivityMap
}

const phase = (nodes: readonly ConversationNode[], options: PhaseOptions = {}): ReturnType<typeof derivePillPhase> =>
  derivePillPhase({
    nodes,
    turnStartSeq: options.turnStartSeq ?? null,
    runningCalls: options.runningCalls ?? [],
    partial: options.partial ?? null,
    jobs: options.jobs ?? [],
    compactingSince: options.compactingSince,
    activity: options.activity ?? {},
  })

describe('derivePillPhase', () => {
  it('lets an open compaction own the subline over every other phase', () => {
    const nodes = [
      user(1, ['do it']),
      retryNormal(5),
      assistant(6, 1, 1, [{ kind: 'text', text: '答' }]),
    ]
    expect(phase(nodes, {
      runningCalls: [running('c1', 'subagent'), running('c2', 'bash')],
      partial: partial(1, 1, [{ kind: 'reasoning', text: '想' }]),
      jobs: [job('build', 'running', T)],
      compactingSince: T,
      activity: { c1: fact(T + 9, 'tool', 'Running bash') },
    })).toEqual({ kind: 'compaction', since: T })
  })

  it('picks the newest scheduled retry by seq', () => {
    const nodes = [retryNormal(5, 1), retryNormal(9, 2)]
    expect(phase(nodes)).toEqual({
      kind: 'retry', retry: 2, max: 2,
      failure: { code: 'TRANSPORT', message: '连接被重置' },
      at: T + 9, delayMs: 450,
    })
  })

  it('reports no max for an unlimited retry policy', () => {
    expect(phase([retryAlways(7, 3)])).toStrictEqual({
      kind: 'retry', retry: 3, max: undefined,
      failure: { code: 'TRANSPORT', message: '连接被重置' },
      at: T + 7, delayMs: 450,
    })
  })

  it('ignores non-scheduled retry chains', () => {
    expect(phase([retryNormal(5, 1, 'started')])).toEqual({ kind: 'assistant', mode: 'first-token' })
    // A started chain newer than a scheduled one must not displace it.
    const mixed = [retryNormal(5, 1, 'scheduled'), retryNormal(9, 2, 'started')]
    expect(phase(mixed)).toEqual({
      kind: 'retry', retry: 1, max: 2,
      failure: { code: 'TRANSPORT', message: '连接被重置' },
      at: T + 5, delayMs: 450,
    })
  })

  it('ignores a scheduled retry that falls before the turn window', () => {
    const nodes = [user(20, ['do it']), retryNormal(5)]
    expect(phase(nodes, { turnStartSeq: 10 })).toEqual({ kind: 'assistant', mode: 'first-token' })
    // The same retry inside the window (or with an unknown window) is reported.
    expect(phase(nodes, { turnStartSeq: 2 })).toEqual({
      kind: 'retry', retry: 1, max: 2,
      failure: { code: 'TRANSPORT', message: '连接被重置' },
      at: T + 5, delayMs: 450,
    })
    expect(phase(nodes)).toEqual({
      kind: 'retry', retry: 1, max: 2,
      failure: { code: 'TRANSPORT', message: '连接被重置' },
      at: T + 5, delayMs: 450,
    })
  })

  it('lets the newest subagent activity fact win among running delegations', () => {
    const options: PhaseOptions = {
      runningCalls: [running('c1', 'subagent'), running('c2', 'subagent_fork'), running('c3', 'bash')],
      activity: {
        c1: fact(T + 9, 'output', 'Producing'),
        c2: fact(T + 3, 'tool', 'Running read'),
      },
    }
    expect(phase([], options)).toEqual({ kind: 'subagent', callId: 'c1', label: 'Producing' })
    // A later delegation with an older fact must not displace the newer one.
    options.activity = {
      c1: fact(T + 9, 'output', 'Producing'),
      c3: fact(T + 5, 'tool', 'Reading'),
    }
    expect(phase([], options)).toEqual({ kind: 'subagent', callId: 'c1', label: 'Producing' })
  })

  it('carries a latched child session id onto the winning subagent phase', () => {
    expect(phase([], {
      runningCalls: [running('c1', 'subagent')],
      activity: { c1: fact(T + 9, 'tool', 'Running bash', 'dsh', 'child-1') },
    })).toStrictEqual({ kind: 'subagent', callId: 'c1', label: 'Running bash', childSessionId: 'child-1' })
    // The newest-fact winner carries its own latched id, not the loser's.
    expect(phase([], {
      runningCalls: [running('c1', 'subagent'), running('c2', 'subagent_fork')],
      activity: {
        c1: fact(T + 9, 'tool', 'Running bash', 'dsh', 'child-1'),
        c2: fact(T + 12, 'tool', 'Running read', 'dsh', 'child-2'),
      },
    })).toStrictEqual({ kind: 'subagent', callId: 'c2', label: 'Running read', childSessionId: 'child-2' })
    // An unlatched (remote) fact leaves the key absent.
    expect(phase([], {
      runningCalls: [running('c1', 'subagent')],
      activity: { c1: fact(T + 9, 'tool', 'Running bash') },
    })).toStrictEqual({ kind: 'subagent', callId: 'c1', label: 'Running bash' })
  })

  it('falls through to the tool phase for a delegation without an activity fact', () => {
    expect(phase([], { runningCalls: [running('c1', 'subagent')] })).toEqual({ kind: 'tool', callId: 'c1', name: 'subagent' })
  })

  it('ignores activity facts on non-delegation tools', () => {
    expect(phase([], {
      runningCalls: [running('c1', 'bash')],
      activity: { c1: fact(T + 9, 'tool', 'Running bash') },
    })).toEqual({ kind: 'tool', callId: 'c1', name: 'bash' })
  })

  it('lets the newest in-flight call win for the tool phase', () => {
    expect(phase([], { runningCalls: [running('c1', 'bash'), running('c2', 'read')] }))
      .toEqual({ kind: 'tool', callId: 'c2', name: 'read' })
  })

  it('reads a running reasoning tail as thinking', () => {
    expect(phase([], { partial: partial(1, 1, [{ kind: 'text', text: '先' }, { kind: 'reasoning', text: '想' }]) }))
      .toEqual({ kind: 'assistant', mode: 'thinking' })
  })

  it('reads a running text tail as generating', () => {
    expect(phase([], { partial: partial(1, 1, [{ kind: 'reasoning', text: '想' }, { kind: 'text', text: '答' }]) }))
      .toEqual({ kind: 'assistant', mode: 'generating' })
  })

  it('skips trailing tool-call and other blocks when reading the partial', () => {
    // A trailing tool call belongs to the streamed call, not the assistant phase.
    expect(phase([], {
      partial: partial(1, 1, [{ kind: 'reasoning', text: '想' }, { kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{}' }]),
    })).toEqual({ kind: 'assistant', mode: 'thinking' })
    expect(phase([], {
      partial: partial(1, 1, [{ kind: 'text', text: '答' }, { kind: 'other', block: { opaque: true } }]),
    })).toEqual({ kind: 'assistant', mode: 'generating' })
    // A tool-only stream carries no assistant phase of its own.
    expect(phase([], {
      partial: partial(1, 1, [{ kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{}' }]),
    })).toEqual({ kind: 'assistant', mode: 'first-token' })
  })

  it('reports the newest live job when nothing visible is streaming', () => {
    const options = { jobs: [job('test:web', 'running', T + 5)] }
    expect(phase([], options)).toEqual({ kind: 'job', label: 'test:web' })
    // A stopping job is still live; finished jobs are not.
    options.jobs = [job('test:web', 'stopping', T + 5), job('old', 'completed', T)]
    expect(phase([], options)).toEqual({ kind: 'job', label: 'test:web' })
    // The newest live job by start time wins.
    options.jobs = [job('first', 'running', T), job('second', 'running', T + 9)]
    expect(phase([], options)).toEqual({ kind: 'job', label: 'second' })
    // No live jobs: the phase falls through.
    options.jobs = [job('old', 'killed', T)]
    expect(phase([], options)).toEqual({ kind: 'assistant', mode: 'first-token' })
  })

  it('lets a visible stream or a running tool beat a live job', () => {
    expect(phase([], {
      partial: partial(1, 1, [{ kind: 'text', text: '答' }]),
      jobs: [job('test:web', 'running', T)],
    })).toEqual({ kind: 'assistant', mode: 'generating' })
    expect(phase([], {
      runningCalls: [running('c1', 'bash')],
      jobs: [job('test:web', 'running', T)],
    })).toEqual({ kind: 'tool', callId: 'c1', name: 'bash' })
  })

  it('reports honest working once the turn has visible assistant output', () => {
    const text = assistant(5, 1, 1, [{ kind: 'text', text: '答' }])
    const reasoning = assistant(5, 1, 1, [{ kind: 'reasoning', text: '想' }])
    const image = assistant(5, 1, 1, [{ kind: 'image', attachment: { id: 'a1', name: 'a.png', bytes: 1 } as never }])
    for (const node of [text, reasoning, image]) {
      expect(phase([node], { turnStartSeq: 4 })).toEqual({ kind: 'working' })
    }
  })

  it('treats an assistant with only non-visible blocks as not yet visible', () => {
    const toolOnly = assistant(5, 1, 1, [{ kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{}' }])
    expect(phase([toolOnly])).toEqual({ kind: 'assistant', mode: 'first-token' })
    // A visible answer from an earlier turn outside the window does not count.
    expect(phase([assistant(2, 1, 1, [{ kind: 'text', text: '旧答' }]), toolOnly], { turnStartSeq: 3 }))
      .toEqual({ kind: 'assistant', mode: 'first-token' })
  })

  it('reads an empty or evidence-free turn as waiting for the first token', () => {
    expect(phase([])).toEqual({ kind: 'assistant', mode: 'first-token' })
    const noAssistant = [user(1, ['do it']), steering(2, 'interject'), settled(3, 'c1', 'bash')]
    expect(phase(noAssistant)).toEqual({ kind: 'assistant', mode: 'first-token' })
  })

  it('orders the arms retry over subagent over tool over stream over job over working', () => {
    const answer = assistant(9, 1, 1, [{ kind: 'text', text: '答' }])
    const nodes = [answer, retryNormal(5)]
    const runningCalls = [running('c1', 'subagent'), running('c2', 'bash')]
    const streaming = partial(1, 2, [{ kind: 'reasoning', text: '想' }])
    const jobs = [job('test:web', 'running', T)]
    const activity = { c1: fact(T + 9, 'tool', 'Running bash') }

    expect(phase(nodes, { compactingSince: T })).toEqual({ kind: 'compaction', since: T })
    expect(phase(nodes, { runningCalls, partial: streaming, jobs, activity })).toEqual({
      kind: 'retry', retry: 1, max: 2,
      failure: { code: 'TRANSPORT', message: '连接被重置' },
      at: T + 5, delayMs: 450,
    })
    expect(phase([], { runningCalls, partial: streaming, jobs, activity })).toEqual({ kind: 'subagent', callId: 'c1', label: 'Running bash' })
    expect(phase([], { runningCalls, partial: streaming, jobs })).toEqual({ kind: 'tool', callId: 'c2', name: 'bash' })
    expect(phase([], { partial: streaming, jobs })).toEqual({ kind: 'assistant', mode: 'thinking' })
    expect(phase([], { jobs })).toEqual({ kind: 'job', label: 'test:web' })
    expect(phase([answer], {})).toEqual({ kind: 'working' })
    expect(phase([], {})).toEqual({ kind: 'assistant', mode: 'first-token' })
  })
})

describe('hasSettledTool', () => {
  it('sees a settled result inside the turn window', () => {
    const nodes = [user(1, ['do it']), settled(6, 'c2', 'read')]
    expect(hasSettledTool(nodes, null)).toBe(true)
    expect(hasSettledTool(nodes, 5)).toBe(true)
  })

  it('stays false while every tool is still in flight or the window excludes it', () => {
    const inWindow = [settled(6, 'c2', 'read')]
    expect(hasSettledTool(inWindow, 10)).toBe(false)
    const none = [user(1, ['do it'])]
    expect(hasSettledTool(none, null)).toBe(false)
    expect(hasSettledTool([], null)).toBe(false)
  })
})

describe('firstUserPromptText', () => {
  it('joins the first in-window user message text blocks with newlines', () => {
    const nodes = [user(1, ['first', 'second'])]
    expect(firstUserPromptText(nodes, null)).toBe('first\nsecond')
    expect(firstUserPromptText(nodes, 0)).toBe('first\nsecond')
  })

  it('returns undefined for a whitespace-only prompt', () => {
    expect(firstUserPromptText([user(1, ['   ', ''])], null)).toBeUndefined()
  })

  it('returns undefined when the first user message has no text parts', () => {
    expect(firstUserPromptText([user(1, [''])], null)).toBeUndefined()
  })

  it('skips steering rows that precede the user message', () => {
    expect(firstUserPromptText([steering(1, 'interject'), user(2, ['do it'])], null)).toBe('do it')
  })

  it('returns undefined when the turn opened without an in-window user message', () => {
    expect(firstUserPromptText([], null)).toBeUndefined()
    expect(firstUserPromptText([steering(1, 'interject')], null)).toBeUndefined()
    expect(firstUserPromptText([user(1, ['old prompt'])], 5)).toBeUndefined()
  })
})
