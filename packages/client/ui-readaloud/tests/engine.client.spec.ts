// @vitest-environment jsdom
/**
 * Chunked engine over a stubbed synthesis runtime: the stream is lazy and
 * demand-driven, yields one result per sentence-sized chunk in order with the
 * voice, explicit voice base (the no-network guarantee), and per-call buffer
 * cap forwarded beside the engine's asset base; a chunk the runtime rejects
 * as over the token cap is split at a word boundary (or the midpoint) and the
 * retries stitched; every other failure — other TrellisFrontendError kinds,
 * non-Error rejections, a single unsplittable character — propagates;
 * whitespace-only text goes to the runtime unsplit; cancel reaches the
 * runtime; and each result's dead air is trimmed to a short onset guard and
 * a sentence or continuation pause.
 */
import { describe, expect, it, vi } from 'vitest'
import { SanottsEngine, type SanottsChunk } from '../src/client/engine.ts'
import type { SynthesisRuntime } from '../src/client/runtime.ts'
import type { SanoSynthesizeOptions, SanoSynthesisResult } from '../src/client/sanotts-types.ts'
import { DEFAULT_READALOUD_VOICE } from '../src/client/voices.ts'

const ASSET_BASE = 'http://localhost:3000/sanotts/'

interface RuntimeCall {
  assetBase: string
  text: string
  options: SanoSynthesizeOptions
}

type StubSynthesizeImpl = (text: string, call: number) => SanoSynthesisResult

function makeRuntime(impl?: StubSynthesizeImpl) {
  let call = 0
  const calls: RuntimeCall[] = []
  const synthesize = vi.fn(async (
    assetBase: string,
    text: string,
    options: SanoSynthesizeOptions,
  ): Promise<SanoSynthesisResult> => {
    call += 1
    calls.push({ assetBase, text, options })
    return impl ? impl(text, call) : { samples: new Float32Array(2), sampleRate: 8000, phonemeCount: 1, elapsedMs: 0 }
  })
  const cancel = vi.fn()
  const runtime = { synthesize, cancel } as unknown as SynthesisRuntime & { synthesize: typeof synthesize }
  return { runtime, calls, synthesize, cancel }
}

/** The vendored frontend's over-the-token-cap rejection, as the worker relays it. */
function tokenLimitError(): Error {
  return Object.assign(
    new Error('phoneme sequence has 244 tokens including BOS/EOS; maximum is 207'),
    { name: 'TrellisFrontendError', kind: 'too_long' },
  )
}

/** Collect an engine stream into an array. */
async function collect(stream: AsyncGenerator<SanottsChunk>): Promise<SanottsChunk[]> {
  const parts: SanottsChunk[] = []
  for await (const part of stream) parts.push(part)
  return parts
}

describe('SanottsEngine', () => {
  it('trims leading silence and caps a sentence tail at the sentence pause', async () => {
    const samples = new Float32Array(2000)
    samples.fill(0.5, 300, 1300)
    const { runtime } = makeRuntime(() => ({ samples, sampleRate: 1000, phonemeCount: 1, elapsedMs: 0 }))
    const engine = new SanottsEngine({ runtime })

    const parts = await collect(engine.stream('Done.'))

    // 30 ms of the 300 ms lead kept; 400 ms of the 700 ms tail kept.
    expect(parts[0]!.result.samples.length).toBe(1430)
    expect(parts[0]!.result.samples[30]).toBeCloseTo(0.5)
    expect(parts[0]!.result.samples[1029]).toBeCloseTo(0.5)
    expect(parts[0]!.result.samples[1030]).toBe(0)
  })

  it('caps a continuation tail at the shorter clause pause', async () => {
    const samples = new Float32Array(2000)
    samples.fill(0.5, 300, 1300)
    const { runtime } = makeRuntime(() => ({ samples, sampleRate: 1000, phonemeCount: 1, elapsedMs: 0 }))
    const engine = new SanottsEngine({ runtime })

    const parts = await collect(engine.stream(`and then, ${'tail '.repeat(40)}`))

    expect(parts[0]!.result.samples.length).toBe(1180)
  })

  it('leaves an all-silent or already-tight result untouched', async () => {
    const silent = new Float32Array(50)
    const silentRuntime = makeRuntime(() => ({ samples: silent, sampleRate: 1000, phonemeCount: 1, elapsedMs: 0 }))
    const silentParts = await collect(new SanottsEngine({ runtime: silentRuntime.runtime }).stream('hmm'))
    expect(silentParts[0]!.result.samples).toBe(silent)

    const tight = new Float32Array(40)
    tight.fill(0.5, 10, 30)
    const tightRuntime = makeRuntime(() => ({ samples: tight, sampleRate: 1000, phonemeCount: 1, elapsedMs: 0 }))
    const tightParts = await collect(new SanottsEngine({ runtime: tightRuntime.runtime }).stream('Done.'))
    expect(tightParts[0]!.result.samples).toBe(tight)
  })

  it('streams nothing until the consumer pulls, then yields one result per chunk', async () => {
    const { runtime, calls } = makeRuntime()
    const engine = new SanottsEngine({ runtime })

    const stream = engine.stream('hi')
    expect(calls).toEqual([])

    const parts = await collect(stream)
    expect(calls.map(call => call.text)).toEqual(['hi'])
    expect(parts).toHaveLength(1)
    expect(parts[0]!.result.sampleRate).toBe(8000)
  })

  it('forwards the asset base, voice, explicit voice base, and per-call buffer cap', async () => {
    const { runtime, calls } = makeRuntime()
    const engine = new SanottsEngine({ runtime })

    await collect(engine.stream('hello'))
    expect(calls[0]).toEqual({
      assetBase: ASSET_BASE,
      text: 'hello',
      options: { voice: DEFAULT_READALOUD_VOICE, voiceBase: ASSET_BASE, maxSeconds: 300 },
    })

    await collect(engine.stream('hello', 'heartnano'))
    expect(calls[1]!.options).toEqual({ voice: 'heartnano', voiceBase: ASSET_BASE, maxSeconds: 300 })
  })

  it('honors custom bases', async () => {
    const { runtime, calls } = makeRuntime()
    const engine = new SanottsEngine({
      runtime,
      bases: { assetBase: 'http://example.test/assets/', voiceBase: 'http://example.test/voices/' },
    })

    await collect(engine.stream('hi'))

    expect(calls[0]).toEqual({
      assetBase: 'http://example.test/assets/',
      text: 'hi',
      options: { voice: DEFAULT_READALOUD_VOICE, voiceBase: 'http://example.test/voices/', maxSeconds: 300 },
    })
  })

  it('yields each sentence-sized chunk in order', async () => {
    const { runtime, calls } = makeRuntime(text => ({
      samples: new Float32Array(text.length).fill(text.length),
      sampleRate: 100,
      phonemeCount: text.length,
      elapsedMs: 1,
    }))
    const engine = new SanottsEngine({ runtime })

    const text = ['a'.repeat(54) + '.', 'b'.repeat(54) + '.', 'c'.repeat(54) + '.'].join(' ')
    const parts = await collect(engine.stream(text))

    expect(calls.map(call => call.text)).toEqual([`${'a'.repeat(54)}. ${'b'.repeat(54)}.`, `${'c'.repeat(54)}.`])
    expect(parts).toHaveLength(2)
    expect(parts.map(part => part.text)).toEqual([`${'a'.repeat(54)}. ${'b'.repeat(54)}.`, `${'c'.repeat(54)}.`])
    expect(parts[0]!.result.samples).toHaveLength(111)
    expect(parts[1]!.result.samples).toHaveLength(55)
  })

  it('splits a chunk the runtime rejects as over the token cap and stitches the retries', async () => {
    const { runtime, calls } = makeRuntime((chunk) => {
      if (chunk.length > 8) throw tokenLimitError()
      return { samples: new Float32Array(chunk.length).fill(chunk.length), sampleRate: 100, phonemeCount: 1, elapsedMs: 1 }
    })
    const engine = new SanottsEngine({ runtime })

    const parts = await collect(engine.stream('aaaa bbbb cccc'))

    expect(calls.map(call => call.text)).toEqual(['aaaa bbbb cccc', 'aaaa', 'bbbb cccc', 'bbbb', 'cccc'])
    expect(parts).toHaveLength(1)
    expect(parts[0]!.text).toBe('aaaa bbbb cccc')
    expect(parts[0]!.result.samples).toHaveLength(12)
    expect([...parts[0]!.result.samples]).toEqual(new Array(12).fill(4))
    expect(parts[0]!.result.phonemeCount).toBe(3)
    expect(parts[0]!.result.elapsedMs).toBe(3)
  })

  it('hard-cuts an over-cap chunk with no word boundary', async () => {
    const { runtime, calls } = makeRuntime((chunk) => {
      if (chunk.length > 10) throw tokenLimitError()
      return { samples: new Float32Array(chunk.length).fill(1), sampleRate: 100, phonemeCount: 1, elapsedMs: 1 }
    })
    const engine = new SanottsEngine({ runtime })

    const parts = await collect(engine.stream('a'.repeat(18)))

    expect(calls.map(call => call.text)).toEqual(['a'.repeat(18), 'a'.repeat(9), 'a'.repeat(9)])
    expect(parts[0]!.result.samples).toHaveLength(18)
  })

  it('propagates a token-cap failure for a single character that cannot be split', async () => {
    const { runtime, calls } = makeRuntime(() => { throw tokenLimitError() })
    const engine = new SanottsEngine({ runtime })

    await expect(collect(engine.stream('x'))).rejects.toThrow('maximum is 207')
    expect(calls.map(call => call.text)).toEqual(['x'])
  })

  it('does not split other TrellisFrontendError kinds', async () => {
    const { runtime, calls } = makeRuntime(() => {
      throw Object.assign(new Error('phonemization produced no symbols in the packaged vocabulary'), {
        name: 'TrellisFrontendError', kind: 'empty',
      })
    })
    const engine = new SanottsEngine({ runtime })

    await expect(collect(engine.stream('hello'))).rejects.toThrow('no symbols')
    expect(calls.map(call => call.text)).toEqual(['hello'])
  })

  it('does not split a rejection that is not an Error', async () => {
    const rejection = { name: 'TrellisFrontendError', kind: 'too_long' }
    const { runtime } = makeRuntime(() => { throw rejection })
    const engine = new SanottsEngine({ runtime })

    const error = await collect(engine.stream('hello')).catch((reason: unknown) => reason)
    expect(error).toBe(rejection)
  })

  it('streams whitespace-only text as one unsplit call when the runtime accepts it', async () => {
    const { runtime, calls } = makeRuntime()
    const engine = new SanottsEngine({ runtime })

    const parts = await collect(engine.stream('   '))

    expect(calls.map(call => call.text)).toEqual(['   '])
    expect(parts).toHaveLength(1)
  })

  it('forwards whitespace-only text to the runtime unsplit', async () => {
    const { runtime, calls } = makeRuntime(() => { throw new Error('empty text') })
    const engine = new SanottsEngine({ runtime })

    await expect(collect(engine.stream('  \n\t '))).rejects.toThrow('empty text')
    expect(calls.map(call => call.text)).toEqual(['  \n\t '])
  })

  it('cancel reaches the runtime', () => {
    const { runtime, cancel } = makeRuntime()
    const engine = new SanottsEngine({ runtime })

    engine.cancel()

    expect(cancel).toHaveBeenCalledTimes(1)
  })
})
