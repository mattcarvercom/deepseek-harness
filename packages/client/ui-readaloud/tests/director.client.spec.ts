// @vitest-environment jsdom
/**
 * ReadAloudDirector over a stubbed WebAudio and a controlled chunk stream:
 * one shared AudioContext created on first use, playback starting on the
 * first chunk while later chunks are scheduled behind it as they arrive, at
 * most one live read, every superseded or stopped read (scheduled sources or
 * in-flight synthesis) publishes idle, cancelling the engine and discarding
 * its late chunks; a failed chunk publishes failed and stops scheduled
 * audio; scheduled audio truncates at the five-minute cap; dispose closes
 * the context, cancels synthesis, and refuses further work. onended delivery
 * is queued as a microtask, matching the real event.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  INITIAL_READALOUD_PLAYBACK, ReadAloudDirector, type ReadAloudPlaybackState,
} from '../src/client/director.ts'
import type { SanottsEngine } from '../src/client/engine.ts'
import type { SanoSynthesisResult } from '../src/client/sanotts-types.ts'
import { DEFAULT_READALOUD_VOICE } from '../src/client/voices.ts'

/**
 * Scripted buffer source: records connect/start/stop attempts; `finish`
 * simulates natural playback completion and `stop` rejects once ended, both
 * delivering onended as a queued microtask like the real event.
 */
class FakeSource {
  buffer: { length: number; sampleRate: number; duration: number } | null = null
  onended: (() => void) | null = null
  connects = 0
  startCalls: number[] = []
  stopCalls = 0
  ended = false

  connect(destination: unknown) {
    this.connects += 1
    return destination
  }

  start(when = 0) {
    this.startCalls.push(when)
  }

  stop() {
    this.stopCalls += 1
    if (this.ended) throw new Error('InvalidStateError')
    this.ended = true
    queueMicrotask(() => { this.onended?.() })
  }

  finish() {
    this.ended = true
    queueMicrotask(() => { this.onended?.() })
  }
}

/** Scripted AudioContext: records sources, resume, close, and its clock. */
class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: 'running' | 'suspended'
  currentTime = 0
  closed = false
  closeCalls = 0
  resumeCalls = 0
  sources: FakeSource[] = []
  readonly destination = {}

  constructor() {
    this.state = initialContextState
    FakeAudioContext.instances.push(this)
  }

  resume(): Promise<void> {
    this.resumeCalls += 1
    this.state = 'running'
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closeCalls += 1
    this.closed = true
    return closeRejects ? Promise.reject(new Error('already closed')) : Promise.resolve()
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    return { channels, length, sampleRate, duration: length / sampleRate, copyToChannel: () => {} }
  }

  createBufferSource() {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  }
}

let initialContextState: 'running' | 'suspended' = 'running'
let closeRejects = false

beforeAll(() => {
  vi.stubGlobal('AudioContext', FakeAudioContext)
})
afterAll(() => {
  vi.unstubAllGlobals()
})
beforeEach(() => {
  FakeAudioContext.instances.length = 0
  initialContextState = 'running'
  closeRejects = false
})

/** Drain queued microtasks (queued onended handlers, late promise work). */
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

type StreamItem =
  | { kind: 'part'; value: SanoSynthesisResult; span: { start: number; end: number } }
  | { kind: 'error'; error: unknown }
  | { kind: 'end' }

/** One engine stream the test feeds chunk by chunk. */
interface StreamState {
  queue: StreamItem[]
  notify: (() => void) | undefined
}

/** Chunk-stream engine whose results the test pushes per stream. */
function makeEngine() {
  const calls: Array<[text: string, voice: string]> = []
  const streams: StreamState[] = []
  async function* stream(text: string, voice: string) {
    const state: StreamState = { queue: [], notify: undefined }
    const index = calls.length
    calls.push([text, voice])
    streams[index] = state
    for (;;) {
      if (state.queue.length === 0) {
        await new Promise<void>((resolve) => { state.notify = resolve })
      }
      const item = state.queue.shift()
      if (item === undefined) continue
      if (item.kind === 'end') return
      if (item.kind === 'error') throw item.error
      yield { text: 'chunk', start: item.span.start, end: item.span.end, result: item.value }
    }
  }
  const pushTo = (index: number, item: StreamItem): void => {
    const state = streams[index]
    if (state === undefined) return
    state.queue.push(item)
    const notify = state.notify
    state.notify = undefined
    notify?.()
  }
  const last = () => streams.length - 1
  const cancel = vi.fn()
  return {
    calls,
    cancel,
    engine: { stream, cancel } as unknown as SanottsEngine,
    push: (value = result(), index = last(), span: { start: number; end: number } = { start: 0, end: 3 }) => {
      pushTo(index, { kind: 'part', value, span })
    },
    fail: (error: unknown = new Error('synthesis failed'), index = last()) => { pushTo(index, { kind: 'error', error }) },
    end: (index = last()) => { pushTo(index, { kind: 'end' }) },
  }
}

function makeDirector(engine: ReturnType<typeof makeEngine>, voice?: string) {
  return new ReadAloudDirector(engine.engine, (voice ?? DEFAULT_READALOUD_VOICE) as never)
}

function makeStore() {
  return createSnapshotStore<ReadAloudPlaybackState>(INITIAL_READALOUD_PLAYBACK)
}

/** One speakable block whose segments map 1:1 onto its text. */
function blockOf(text: string, blockIndex = 0) {
  return {
    blockIndex,
    text,
    segments: [{ start: 0, end: text.length, sourceStart: 0, sourceEnd: text.length }],
  }
}

function request(store: ReturnType<typeof makeStore>, messageId: MessageId, text: string) {
  return {
    sessionId: 's1' as SessionId,
    messageId,
    blocks: [blockOf(text)],
    store,
  }
}

/** The highlight the default engine span (0..5) maps to for the request blocks. */
const HL = { blockIndex: 0, ranges: [{ start: 0, end: 3 }] }

function result(samples = new Float32Array(4), sampleRate = 8000): SanoSynthesisResult {
  return { samples, sampleRate, phonemeCount: 1, elapsedMs: 0 }
}

describe('ReadAloudDirector', () => {
  it('starts playing on the first chunk and settles back to idle when playback ends', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'hello'))
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'synthesizing', highlight: undefined })
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(engine.calls).toEqual([['hello', DEFAULT_READALOUD_VOICE]])

    engine.push(result())
    await flush()

    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'playing', highlight: HL })
    const context = FakeAudioContext.instances[0]!
    expect(context.sources).toHaveLength(1)
    const source = context.sources[0]!
    expect(source.connects).toBe(1)
    expect(source.startCalls).toEqual([0.25])
    // The first source carries the start-up silence pad.
    expect(source.buffer!.length).toBe(4 + 640)

    engine.end()
    await flush()
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'playing', highlight: HL })

    source.finish()
    await flush()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('schedules later chunks behind the one already playing', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'two chunks'))
    engine.push(result(new Float32Array(8000), 8000))
    await flush()
    engine.push(result(new Float32Array(8000), 8000))
    await flush()

    const context = FakeAudioContext.instances[0]!
    expect(context.sources).toHaveLength(2)
    expect(context.sources[0]!.startCalls).toEqual([0.25])
    expect(context.sources[1]!.startCalls).toEqual([1.33])

    engine.end()
    await flush()
    context.sources[0]!.finish()
    context.sources[1]!.finish()
    await flush()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('a source finishing before the stream completes does not publish idle', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'two chunks'))
    engine.push(result())
    await flush()
    FakeAudioContext.instances[0]!.sources[0]!.finish()
    await flush()
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'playing', highlight: HL })

    engine.push(result())
    engine.end()
    await flush()
    FakeAudioContext.instances[0]!.sources[1]!.finish()
    await flush()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('settles an empty stream immediately', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'nothing'))
    engine.end()
    await flush()

    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(FakeAudioContext.instances[0]!.sources).toHaveLength(0)
  })

  it('a new speak cancels the previous synthesis, stops its sources, and ignores its late chunks', async () => {
    const engine = makeEngine()
    const storeA = makeStore()
    const storeB = makeStore()
    const director = makeDirector(engine)

    director.speak(request(storeA, 'm1' as MessageId, 'one'))
    engine.push(result())
    await flush()
    expect(storeA.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'playing', highlight: HL })

    director.speak(request(storeB, 'm2' as MessageId, 'two'))

    expect(engine.cancel).toHaveBeenCalledTimes(1)
    const [s1] = FakeAudioContext.instances[0]!.sources
    expect(s1!.stopCalls).toBe(1)
    expect(storeA.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(storeB.getSnapshot()).toEqual({ messageId: 'm2' as MessageId, phase: 'synthesizing', highlight: undefined })

    engine.push(result(), 0)
    await flush()
    expect(storeB.getSnapshot()).toEqual({ messageId: 'm2' as MessageId, phase: 'synthesizing', highlight: undefined })

    engine.push(result())
    await flush()
    expect(storeA.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(storeB.getSnapshot()).toEqual({ messageId: 'm2' as MessageId, phase: 'playing', highlight: HL })
  })

  it('a stop during synthesis publishes idle, cancels, and discards the late chunk', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'hello'))
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'synthesizing', highlight: undefined })

    director.stop()
    expect(engine.cancel).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)

    engine.push(result())
    await flush()

    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(FakeAudioContext.instances[0]!.sources).toHaveLength(0)
  })

  it('a failed chunk before playback publishes the failed phase without cancelling', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'hello'))
    engine.fail()
    await flush()

    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'failed', highlight: undefined })
    expect(engine.cancel).not.toHaveBeenCalled()
    expect(FakeAudioContext.instances[0]!.sources).toHaveLength(0)
  })

  it('a failed chunk after playback stops the scheduled audio and publishes failed', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'hello'))
    engine.push(result())
    await flush()
    engine.fail()
    await flush()

    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'failed', highlight: undefined })
    expect(FakeAudioContext.instances[0]!.sources[0]!.stopCalls).toBe(1)
  })

  it('a failed chunk after a stop is discarded', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'hello'))
    director.stop()
    engine.fail()
    await flush()

    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('a stop with nothing live publishes nothing and does not cancel, and later speaks still work', async () => {
    const engine = makeEngine()
    const store = makeStore()
    let notifications = 0
    store.subscribe(() => { notifications += 1 })
    const director = makeDirector(engine)

    director.stop()
    expect(notifications).toBe(0)
    expect(engine.cancel).not.toHaveBeenCalled()

    director.speak(request(store, 'm1' as MessageId, 'hello'))
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'synthesizing', highlight: undefined })
  })

  it('survives a stop() rejection from an already-ended source', async () => {
    const engine = makeEngine()
    const storeA = makeStore()
    const storeB = makeStore()
    const director = makeDirector(engine)

    director.speak(request(storeA, 'm1' as MessageId, 'one'))
    engine.push(result())
    await flush()
    const s1 = FakeAudioContext.instances[0]!.sources[0]!
    s1.finish()
    // The onended is queued but has not run: the director still owns the
    // ended source, so the next speak's internal stop() hits stop() on an
    // ended source and must swallow the rejection.
    director.speak(request(storeB, 'm2' as MessageId, 'two'))

    expect(s1.stopCalls).toBe(1)
    expect(engine.cancel).toHaveBeenCalledTimes(1)
    expect(storeA.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(storeB.getSnapshot()).toEqual({ messageId: 'm2' as MessageId, phase: 'synthesizing', highlight: undefined })

    await flush()
    engine.push(result())
    await flush()
    expect(storeA.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(storeB.getSnapshot()).toEqual({ messageId: 'm2' as MessageId, phase: 'playing', highlight: HL })
  })

  it('resumes a suspended context when playback starts', async () => {
    initialContextState = 'suspended'
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'hello'))
    engine.push(result())
    await flush()

    const context = FakeAudioContext.instances[0]!
    expect(context.resumeCalls).toBe(1)
    expect(context.state).toBe('running')
  })

  it('resumes a suspended context when resuming a paused read', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'hello'))
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: 5 })
    await flush()
    director.pause()

    const context = FakeAudioContext.instances[0]!
    context.state = 'suspended'
    director.resume()

    expect(context.resumeCalls).toBe(1)
    expect(context.state).toBe('running')
    expect(store.getSnapshot().phase).toBe('synthesizing')
  })

  it('reuses one context across sequential reads', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'one'))
    engine.push(result())
    engine.end(0)
    await flush()
    FakeAudioContext.instances[0]!.sources[0]!.finish()
    await flush()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)

    director.speak(request(store, 'm2' as MessageId, 'two'))
    engine.push(result())
    await flush()

    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeAudioContext.instances[0]!.sources).toHaveLength(2)
  })

  it('publishes only the source ranges the spoken chunk intersects', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const messageId = 'm1' as MessageId
    const text = 'alpha beta'
    const request = {
      sessionId: 's1' as SessionId,
      messageId,
      blocks: [{
        blockIndex: 0,
        text,
        segments: [
          { start: 0, end: 5, sourceStart: 0, sourceEnd: 5 },
          { start: 6, end: 10, sourceStart: 12, sourceEnd: 16 },
        ],
      }],
      store,
    }

    director.speak(request)
    engine.push(result(), 0, { start: 6, end: 10 })
    await flush()

    expect(store.getSnapshot()).toEqual({
      messageId,
      phase: 'playing',
      highlight: { blockIndex: 0, ranges: [{ start: 12, end: 16 }] },
    })
  })

  it('moves the highlight when the previous chunk ends, not when it is scheduled', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const messageId = 'm1' as MessageId
    const request = {
      sessionId: 's1' as SessionId,
      messageId,
      blocks: [{
        blockIndex: 0,
        text: 'alpha beta',
        segments: [
          { start: 0, end: 5, sourceStart: 0, sourceEnd: 5 },
          { start: 6, end: 10, sourceStart: 12, sourceEnd: 16 },
        ],
      }],
      store,
    }

    director.speak(request)
    engine.push(result(), 0, { start: 0, end: 5 })
    engine.push(result(), 0, { start: 6, end: 10 })
    await flush()

    // Both chunks are scheduled, but the mark still covers the one playing.
    expect(store.getSnapshot()).toEqual({
      messageId,
      phase: 'playing',
      highlight: { blockIndex: 0, ranges: [{ start: 0, end: 5 }] },
    })

    FakeAudioContext.instances[0]!.sources[0]!.finish()
    await flush()

    expect(store.getSnapshot()).toEqual({
      messageId,
      phase: 'playing',
      highlight: { blockIndex: 0, ranges: [{ start: 12, end: 16 }] },
    })
  })

  it('streams appended blocks and binds the durable message id', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const key = 'node-key'
    const sessionId = 's1' as SessionId

    director.startStream({ sessionId, key, store })
    expect(engine.calls).toEqual([])
    expect(store.getSnapshot()).toEqual({
      messageId: undefined, phase: 'synthesizing', highlight: undefined,
    })

    director.append(sessionId, key, blockOf('one'))
    director.finish(sessionId, key)
    await flush()
    expect(engine.calls).toEqual([['one', DEFAULT_READALOUD_VOICE]])
    // The queued utterance marks before its first chunk is scheduled.
    expect(store.getSnapshot()).toEqual({ messageId: undefined, phase: 'synthesizing', highlight: HL })

    engine.push(result(), 0, { start: 0, end: 3 })
    engine.end(0)
    await flush()
    expect(store.getSnapshot()).toEqual({ messageId: undefined, phase: 'playing', highlight: HL })

    // The streamed step settles: bind the durable id without breaking playback.
    director.bind(sessionId, key, 'm1' as MessageId)
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'playing', highlight: HL })

    FakeAudioContext.instances[0]!.sources[0]!.finish()
    await flush()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('keeps the first queued utterance mark until its chunk is scheduled', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const sessionId = 's1' as SessionId

    director.startStream({ sessionId, key: 'node-key', store })
    director.append(sessionId, 'node-key', blockOf('one'))
    const first = store.getSnapshot()

    director.append(sessionId, 'node-key', blockOf('two'))

    expect(store.getSnapshot()).toEqual(first)
    director.finish(sessionId, 'node-key')
  })

  it('keeps streaming blocks flowing across appends', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const key = 'node-key'
    const sessionId = 's1' as SessionId

    director.startStream({ sessionId, key, store })
    director.append(sessionId, key, blockOf('one'))
    await flush()
    engine.end(0)
    director.append(sessionId, key, blockOf('two'))
    director.finish(sessionId, key)
    await flush()

    expect(engine.calls).toEqual([['one', DEFAULT_READALOUD_VOICE], ['two', DEFAULT_READALOUD_VOICE]])
  })

  it('ignores streaming control calls for another session or key', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const key = 'node-key'
    const sessionId = 's1' as SessionId

    director.startStream({ sessionId, key, store })
    director.append('s2' as SessionId, key, blockOf('wrong session'))
    director.append(sessionId, 'other-key', blockOf('wrong key'))
    director.finish('s2' as SessionId, key)
    director.bind('s2' as SessionId, key, 'm2' as MessageId)
    await flush()

    expect(engine.calls).toEqual([])
    expect(store.getSnapshot()).toEqual({
      messageId: undefined, phase: 'synthesizing', highlight: undefined,
    })
    director.stop()
  })

  it('a stop wakes a stream waiting for its next block and discards later appends', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const key = 'node-key'
    const sessionId = 's1' as SessionId

    director.startStream({ sessionId, key, store })
    director.stop()
    director.append(sessionId, key, blockOf('late block'))
    await flush()

    expect(engine.calls).toEqual([])
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('defers the previous read until the first streamed chunk is scheduled', async () => {
    const engine = makeEngine()
    const storeA = makeStore()
    const storeB = makeStore()
    const director = makeDirector(engine)
    const sessionId = 's1' as SessionId

    director.speak(request(storeA, 'm1' as MessageId, 'one'))
    engine.push(result(), 0, { start: 0, end: 3 })
    engine.end(0)
    await flush()
    expect(storeA.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'playing', highlight: HL })
    const sourceA = FakeAudioContext.instances[0]!.sources[0]!

    director.startStream({ sessionId, key: 'node-key', store: storeB })
    director.append(sessionId, 'node-key', blockOf('two'))
    director.finish(sessionId, 'node-key')
    await flush()

    // The stream synthesizes; the previous voice keeps playing untouched.
    expect(sourceA.stopCalls).toBe(0)
    expect(storeA.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'playing', highlight: HL })
    expect(storeB.getSnapshot()).toEqual({ messageId: undefined, phase: 'synthesizing', highlight: HL })

    engine.push(result(), 1, { start: 0, end: 3 })
    await flush()

    // The streamed chunk starts: now the previous read hands over.
    expect(sourceA.stopCalls).toBe(1)
    expect(storeA.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(storeB.getSnapshot()).toEqual({ messageId: undefined, phase: 'playing', highlight: HL })
  })

  it('a stop retires both the streaming read and the deferred previous one', async () => {
    const engine = makeEngine()
    const storeA = makeStore()
    const storeB = makeStore()
    const director = makeDirector(engine)
    const sessionId = 's1' as SessionId

    director.speak(request(storeA, 'm1' as MessageId, 'one'))
    engine.push(result(), 0, { start: 0, end: 3 })
    engine.end(0)
    await flush()
    const sourceA = FakeAudioContext.instances[0]!.sources[0]!

    director.startStream({ sessionId, key: 'node-key', store: storeB })
    director.append(sessionId, 'node-key', blockOf('two'))
    director.finish(sessionId, 'node-key')
    await flush()
    expect(sourceA.stopCalls).toBe(0)

    director.stop()

    expect(sourceA.stopCalls).toBe(1)
    expect(storeA.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(storeB.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('settles a deferred previous read that ends on its own under a newer stream', async () => {
    const engine = makeEngine()
    const storeA = makeStore()
    const storeB = makeStore()
    const director = makeDirector(engine)
    const sessionId = 's1' as SessionId

    director.speak(request(storeA, 'm1' as MessageId, 'one'))
    engine.push(result(), 0, { start: 0, end: 3 })
    engine.end(0)
    await flush()

    director.startStream({ sessionId, key: 'node-key', store: storeB })
    FakeAudioContext.instances[0]!.sources[0]!.finish()
    await flush()

    expect(storeA.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)

    director.append(sessionId, 'node-key', blockOf('two'))
    director.finish(sessionId, 'node-key')
    await flush()
    engine.push(result(), 1, { start: 0, end: 3 })
    await flush()

    expect(storeB.getSnapshot()).toEqual({ messageId: undefined, phase: 'playing', highlight: HL })
  })

  it('settles a stream that finishes without ever producing text', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.startStream({ sessionId: 's1' as SessionId, key: 'node-key', store })
    director.finish('s1' as SessionId, 'node-key')
    await flush()

    expect(engine.calls).toEqual([])
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(FakeAudioContext.instances[0]!.sources).toHaveLength(0)
  })

  it('pauses where it is and resumes from the kept position', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const text = 'alpha beta gamma delta epsilon zeta eta theta'
    const highlight = { blockIndex: 0, ranges: [{ start: 0, end: text.length }] }

    director.speak(request(store, 'm1' as MessageId, text))
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: text.length })
    await flush()
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'playing', highlight })

    const context = FakeAudioContext.instances[0]!
    const source = context.sources[0]!
    context.currentTime = 0.75

    director.pause()
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'paused', highlight })
    expect(source.stopCalls).toBe(1)

    director.resume()
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'synthesizing', highlight })

    engine.end(0)
    await flush()

    expect(engine.calls).toHaveLength(2)
    const remainder = engine.calls[1]?.[0] ?? ''
    expect(remainder.length).toBeGreaterThan(0)
    expect(remainder.length).toBeLessThan(text.length)
    expect(text.endsWith(remainder)).toBe(true)
  })

  it('parks between utterances while paused and resumes the queue', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const sessionId = 's1' as SessionId

    director.startStream({ sessionId, key: 'node-key', store })
    director.append(sessionId, 'node-key', blockOf('one'))
    director.append(sessionId, 'node-key', blockOf('two', 1))
    director.finish(sessionId, 'node-key')
    await flush()
    engine.push(result(), 0, { start: 0, end: 3 })
    engine.end(0)
    await flush()
    await flush()
    expect(engine.calls).toHaveLength(2)

    // The first utterance already played out, so the resume goes to the second.
    FakeAudioContext.instances[0]!.sources[0]!.finish()
    await flush()
    director.pause()

    engine.end(1)
    await flush()
    expect(engine.calls).toHaveLength(2)

    director.resume()
    await flush()
    expect(engine.calls).toHaveLength(3)
    expect(engine.calls[2]?.[0]).toBe('two')
  })

  it('resumes inside the final word when no boundary follows the cut', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'one'))
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: 3 })
    await flush()

    FakeAudioContext.instances[0]!.currentTime = 0.75
    director.pause()
    expect(store.getSnapshot()).toEqual({
      messageId: 'm1' as MessageId, phase: 'paused', highlight: HL,
    })

    director.resume()
    engine.end(0)
    await flush()
    // The cut landed inside the word with no space after it: resume at the
    // cut rather than dropping the unplayed tail.
    expect(engine.calls[1]?.[0]).toBe('ne')

    engine.push(result(), 1, { start: 0, end: 2 })
    engine.end(1)
    await flush()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('resumes inside the sounding chunk by its span, not the block fraction', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa'

    director.speak(request(store, 'm1' as MessageId, text))
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: 22 })
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 23, end: text.length })
    await flush()

    // Halfway through the second chunk: offset 23 + 16 lands on a space.
    FakeAudioContext.instances[0]!.sources[0]!.finish()
    await flush()
    FakeAudioContext.instances[0]!.currentTime = 1.33 + 0.5
    director.pause()
    director.resume()
    engine.end(0)
    await flush()

    expect(engine.calls[1]?.[0]).toBe('theta iota kappa')
  })

  it('resumes the sounding block when synthesis already advanced to the next one', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak({
      sessionId: 's1' as SessionId,
      messageId: 'm1' as MessageId,
      blocks: [blockOf('alpha beta gamma delta epsilon', 0), blockOf('second block here', 1)],
      store,
    })
    engine.push(result(new Float32Array(16000), 8000), 0, { start: 0, end: 30 })
    engine.end(0)
    await flush()
    await flush()
    expect(engine.calls).toHaveLength(2)

    // The first block's chunk still sounds while the second block synthesizes.
    FakeAudioContext.instances[0]!.currentTime = 1.25
    director.pause()
    director.resume()

    // The in-flight second block is abandoned; its turn comes after the
    // remainder of the first.
    engine.push(result(), 1, { start: 0, end: 17 })
    await flush()
    expect(engine.calls).toHaveLength(3)
    expect(engine.calls[2]?.[0]).toBe('delta epsilon')

    engine.end(2)
    await flush()
    expect(engine.calls).toHaveLength(4)
    expect(engine.calls[3]?.[0]).toBe('second block here')
  })

  it('treats a remainder of trailing space as an exhausted block', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'done '))
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: 5 })
    engine.end(0)
    await flush()

    FakeAudioContext.instances[0]!.currentTime = 0.75
    director.pause()
    expect(store.getSnapshot().phase).toBe('paused')

    director.resume()
    await flush()
    expect(engine.calls).toHaveLength(1)
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('resumes a space-free run at the cut, not past it', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const text = '你好世界你好世界'

    director.speak(request(store, 'm1' as MessageId, text))
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: text.length })
    await flush()

    FakeAudioContext.instances[0]!.currentTime = 0.75
    director.pause()
    director.resume()
    engine.end(0)
    await flush()

    expect(engine.calls[1]?.[0]).toBe(text.slice(3))
  })

  it('resumes mid-run instead of skipping a long word to the next space', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const text = `${'a'.repeat(40)} b c`

    director.speak(request(store, 'm1' as MessageId, text))
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: text.length })
    await flush()

    FakeAudioContext.instances[0]!.currentTime = 0.25 + 0.2 * 1.08
    director.pause()
    director.resume()
    engine.end(0)
    await flush()

    expect(engine.calls[1]?.[0]).toBe(text.slice(8))
  })

  it('resumes from the end of the played audio when synthesis lags behind', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const text = 'alpha beta gamma delta'

    director.speak(request(store, 'm1' as MessageId, text))
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: 10 })
    await flush()

    // The scheduled chunk played out while the rest of the block is still
    // synthesizing: resume at the next word after its end.
    FakeAudioContext.instances[0]!.sources[0]!.finish()
    await flush()
    director.pause()
    director.resume()
    engine.end(0)
    await flush()

    expect(engine.calls[1]?.[0]).toBe('gamma delta')
  })

  it('pauses a stream that has not received an utterance yet', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const sessionId = 's1' as SessionId

    director.startStream({ sessionId, key: 'node-key', store })
    director.pause()
    expect(store.getSnapshot()).toEqual({
      messageId: undefined, phase: 'paused', highlight: undefined,
    })
    expect(director.isStreaming(sessionId, 'node-key')).toBe(true)

    director.resume()
    director.append(sessionId, 'node-key', blockOf('one'))
    director.finish(sessionId, 'node-key')
    await flush()
    engine.push(result(), 0, { start: 0, end: 3 })
    await flush()
    expect(store.getSnapshot()).toEqual({ messageId: undefined, phase: 'playing', highlight: HL })
  })

  it('keeps synthesized but unheard utterances behind the remainder on pause', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const sessionId = 's1' as SessionId

    director.startStream({ sessionId, key: 'node-key', store })
    director.append(sessionId, 'node-key', blockOf('first utterance', 0))
    director.append(sessionId, 'node-key', blockOf('second utterance', 1))
    director.append(sessionId, 'node-key', blockOf('third utterance', 2))
    director.finish(sessionId, 'node-key')
    await flush()
    // Synthesis runs ahead: all three utterances are synthesized and
    // scheduled while the first one is still sounding.
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: 15 })
    engine.end(0)
    await flush()
    engine.push(result(new Float32Array(8000), 8000), 1, { start: 0, end: 8 })
    engine.push(result(new Float32Array(8000), 8000), 1, { start: 9, end: 16 })
    engine.end(1)
    await flush()
    engine.push(result(new Float32Array(8000), 8000), 2, { start: 0, end: 15 })
    engine.end(2)
    await flush()

    // Pause early in the first utterance; the second and third were never
    // heard and must play after its remainder on resume.
    FakeAudioContext.instances[0]!.currentTime = 0.25 + 0.2 * 1.08
    director.pause()
    director.resume()
    await flush()
    expect(engine.calls[3]?.[0]).toBe('utterance')

    engine.end(3)
    await flush()
    expect(engine.calls[4]?.[0]).toBe('second utterance')

    engine.end(4)
    await flush()
    expect(engine.calls[5]?.[0]).toBe('third utterance')
  })

  it('replays from the sounding chunk when the clock jumped past scheduled audio', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const text = 'alpha beta gamma delta epsilon zeta'

    director.speak(request(store, 'm1' as MessageId, text))
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: 18 })
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 19, end: text.length })
    await flush()

    // The browser suspended the context and its clock jumped far past both
    // chunks; no end event fired. The pause must replay the sounding chunk,
    // not skip to the one scheduled after it.
    FakeAudioContext.instances[0]!.currentTime = 60
    director.pause()
    expect(store.getSnapshot().phase).toBe('paused')

    director.resume()
    engine.end(0)
    await flush()
    expect(engine.calls[1]?.[0]).toBe(text)
  })

  it('treats a fully played block still in synthesis as exhausted on pause', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'one two'))
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: 7 })
    await flush()
    FakeAudioContext.instances[0]!.sources[0]!.finish()
    await flush()

    // The block's audio played out, but its stream is still open; the pause
    // has nothing left in it to resume.
    director.pause()
    expect(store.getSnapshot().phase).toBe('paused')
  })

  it('settles when paused after the last chunk ended naturally', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'one'))
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: 3 })
    engine.end(0)
    await flush()
    FakeAudioContext.instances[0]!.sources[0]!.finish()
    await flush()

    // The natural end settled the read before the pause click landed.
    director.pause()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('rebases a resume inside a multi-segment utterance', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const text = 'alpha beta gamma'

    director.speak({
      sessionId: 's1' as SessionId,
      messageId: 'm1' as MessageId,
      blocks: [{
        blockIndex: 0,
        text,
        segments: [
          { start: 0, end: 6, sourceStart: 0, sourceEnd: 6 },
          { start: 6, end: text.length, sourceStart: 8, sourceEnd: 10 },
        ],
      }],
      store,
    })
    engine.push(result(new Float32Array(8000), 8000), 0, { start: 0, end: text.length })
    await flush()

    FakeAudioContext.instances[0]!.currentTime = 0.79
    director.pause()
    director.resume()
    engine.end(0)
    await flush()

    const remainder = engine.calls[1]?.[0] ?? ''
    expect(remainder).toBe('gamma')
  })

  it('resumes the whole utterance when paused before its first chunk lands', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const text = 'alpha beta gamma'

    director.speak(request(store, 'm1' as MessageId, text))
    director.pause()
    expect(store.getSnapshot()).toEqual({
      messageId: 'm1' as MessageId, phase: 'paused', highlight: undefined,
    })
    director.resume()

    // The stale pre-pause chunk is dropped; the utterance restarts whole.
    engine.push(result(), 0, { start: 0, end: text.length })
    await flush()
    expect(engine.calls).toHaveLength(2)
    expect(engine.calls[1]?.[0]).toBe(text)
  })

  it('stopping a paused read retires it and resume becomes a no-op', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'one'))
    engine.push(result(), 0, { start: 0, end: 3 })
    await flush()
    director.pause()
    director.stop()

    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)

    director.resume()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(director.isStreaming('s1' as SessionId, 'm1')).toBe(false)
  })

  it('binds a paused streaming read under the paused phase', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const sessionId = 's1' as SessionId

    director.startStream({ sessionId, key: 'node-key', store })
    director.append(sessionId, 'node-key', blockOf('one'))
    director.finish(sessionId, 'node-key')
    engine.push(result(), 0, { start: 0, end: 3 })
    await flush()
    expect(director.isStreaming(sessionId, 'node-key')).toBe(true)

    director.pause()
    director.bind(sessionId, 'node-key', 'm1' as MessageId)

    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'paused', highlight: HL })
  })

  it('pause and resume touch only the matching session and read', () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    const sessionId = 's1' as SessionId

    director.speak(request(store, 'm1' as MessageId, 'one'))
    director.pauseSession('s2' as SessionId)
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'synthesizing', highlight: undefined })

    director.pauseSession(sessionId)
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'paused', highlight: undefined })

    director.resume()
    director.resume()
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'synthesizing', highlight: undefined })
    expect(director.isStreaming(sessionId, 'm1')).toBe(true)
    expect(director.isStreaming(sessionId, 'other')).toBe(false)
  })

  it('pause and resume without a live read are no-ops', () => {
    const engine = makeEngine()
    const director = makeDirector(engine)

    director.pause()
    director.resume()
    director.pauseSession('s1' as SessionId)

    expect(director.isStreaming('s1' as SessionId, 'm1')).toBe(false)
  })

  it('truncates the scheduled audio at the five-minute cap and stops pulling chunks', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'endless'))
    engine.push(result(new Float32Array(400), 1))
    await flush()

    const context = FakeAudioContext.instances[0]!
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0]!.buffer!.length).toBe(300)
    expect(context.sources[0]!.startCalls).toEqual([0.25])
    expect(store.getSnapshot()).toEqual({ messageId: 'm1' as MessageId, phase: 'playing', highlight: HL })

    context.sources[0]!.finish()
    await flush()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('stops pulling chunks once the scheduled audio reaches the cap exactly', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'endless'))
    engine.push(result(new Float32Array(300), 1))
    await flush()
    engine.push(result(new Float32Array(10), 1))
    await flush()

    const context = FakeAudioContext.instances[0]!
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0]!.buffer!.length).toBe(300)

    context.sources[0]!.finish()
    await flush()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('a stream that ends after a stop publishes nothing', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)
    let notifications = 0
    store.subscribe(() => { notifications += 1 })

    director.speak(request(store, 'm1' as MessageId, 'hello'))
    director.stop()
    const settled = notifications

    engine.end(0)
    await flush()

    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(notifications).toBe(settled)
  })

  it('forwards the configured voice to the engine', () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine, 'heartnano')

    director.speak(request(store, 'm1' as MessageId, 'hello'))

    expect(engine.calls).toEqual([['hello', 'heartnano']])
  })

  it('dispose closes the context, cancels synthesis, and refuses further work', async () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'hello'))
    director.dispose()

    expect(engine.cancel).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(FakeAudioContext.instances[0]!.closed).toBe(true)

    engine.push(result())
    await flush()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(FakeAudioContext.instances[0]!.sources).toHaveLength(0)

    director.speak(request(store, 'm2' as MessageId, 'two'))
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(engine.calls).toHaveLength(1)

    director.stop()
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('dispose twice: the close rejection is not raised and close happens once', async () => {
    closeRejects = true
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.speak(request(store, 'm1' as MessageId, 'hello'))
    engine.push(result())
    await flush()

    director.dispose()
    await flush()
    director.dispose()
    await flush()

    expect(FakeAudioContext.instances[0]!.closeCalls).toBe(1)
    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
  })

  it('refuses to start a stream after dispose', () => {
    const engine = makeEngine()
    const store = makeStore()
    const director = makeDirector(engine)

    director.dispose()
    director.startStream({ sessionId: 's1' as SessionId, key: 'node-key', store })
    director.pause()
    director.resume()

    expect(store.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(FakeAudioContext.instances).toHaveLength(0)
  })

  it('dispose without ever speaking creates no context', () => {
    const engine = makeEngine()
    const director = makeDirector(engine)

    director.dispose()

    expect(FakeAudioContext.instances).toHaveLength(0)
  })
})
