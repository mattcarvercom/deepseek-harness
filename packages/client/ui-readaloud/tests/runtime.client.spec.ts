// @vitest-environment jsdom
/**
 * Worker-backed synthesis runtime: the Blob worker is created lazily from the
 * emitted source (and its URL revoked immediately); requests are correlated
 * by id; success replies resolve with the waveform and failure replies reject
 * with the runtime's name/kind marker reconstructed; a worker error rejects
 * every pending request and drops the worker so the next request starts a
 * fresh one; cancel terminates the worker and rejects what it owed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkerSynthesisRuntime } from '../src/client/runtime.ts'
import type { SanoSynthesizeOptions, SanoSynthesisResult } from '../src/client/sanotts-types.ts'
import type { SanottsWorkerReply, SanottsWorkerRequest } from '../src/client/worker.ts'

class FakeWorker {
  static created: FakeWorker[] = []
  readonly posted: SanottsWorkerRequest[] = []
  onmessage: ((event: MessageEvent<SanottsWorkerReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false

  constructor(readonly source: string) {
    FakeWorker.created.push(this)
  }

  postMessage(message: SanottsWorkerRequest): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  reply(reply: SanottsWorkerReply): void {
    this.onmessage?.({ data: reply } as MessageEvent<SanottsWorkerReply>)
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent)
  }
}

const OPTIONS: SanoSynthesizeOptions = {
  voice: 'heart',
  voiceBase: 'http://localhost:3000/sanotts/',
  maxSeconds: 300,
}

function makeRuntime() {
  return new WorkerSynthesisRuntime({ createWorker: source => new FakeWorker(source) as unknown as Worker })
}

function worker(): FakeWorker {
  return FakeWorker.created[FakeWorker.created.length - 1]!
}

function result(samples = new Float32Array(2)): SanoSynthesisResult {
  return { samples, sampleRate: 8000, phonemeCount: 1, elapsedMs: 3 }
}

afterEach(() => {
  FakeWorker.created.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WorkerSynthesisRuntime', () => {
  it('starts the Blob worker lazily from the emitted source and resolves a matching reply', async () => {
    const runtime = makeRuntime()
    expect(FakeWorker.created).toHaveLength(0)

    const pending = runtime.synthesize('http://localhost:3000/sanotts/', 'hello', OPTIONS)
    const source = worker()
    expect(source.source).toContain('importScripts(url)')
    expect(source.posted).toEqual([{
      id: 1, assetBase: 'http://localhost:3000/sanotts/', text: 'hello', options: OPTIONS,
    }])

    source.reply({ id: 1, ok: true, ...result() })
    await expect(pending).resolves.toEqual(result())

    void runtime.synthesize('http://localhost:3000/sanotts/', 'again', OPTIONS)
    expect(FakeWorker.created).toHaveLength(1)
    expect(worker().posted[1]).toMatchObject({ id: 2, text: 'again' })
  })

  it('rejects with the reconstructed runtime error marker', async () => {
    const runtime = makeRuntime()
    const pending = runtime.synthesize('http://localhost:3000/sanotts/', 'bad', OPTIONS)

    worker().reply({
      id: 1, ok: false, name: 'TrellisFrontendError', kind: 'too_long', message: 'phoneme sequence has 244 tokens',
    })

    const error = await pending.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: 'TrellisFrontendError', kind: 'too_long', message: 'phoneme sequence has 244 tokens',
    })
  })

  it('defaults a missing error name', async () => {
    const runtime = makeRuntime()
    const pending = runtime.synthesize('http://localhost:3000/sanotts/', 'bad', OPTIONS)

    worker().reply({ id: 1, ok: false, name: undefined, kind: undefined, message: 'failed' })

    await expect(pending).rejects.toMatchObject({ name: 'Error', kind: undefined, message: 'failed' })
  })

  it('ignores a reply for an unknown request id', async () => {
    const runtime = makeRuntime()
    const pending = runtime.synthesize('http://localhost:3000/sanotts/', 'hello', OPTIONS)

    worker().reply({ id: 99, ok: true, ...result() })
    worker().reply({ id: 1, ok: true, ...result() })

    await expect(pending).resolves.toEqual(result())
  })

  it('a worker error rejects every pending request and the next call starts a fresh worker', async () => {
    const runtime = makeRuntime()
    const first = runtime.synthesize('http://localhost:3000/sanotts/', 'one', OPTIONS)
    const second = runtime.synthesize('http://localhost:3000/sanotts/', 'two', OPTIONS)

    worker().fail('boom')

    await expect(first).rejects.toThrow('boom')
    await expect(second).rejects.toThrow('boom')
    expect(worker().terminated).toBe(true)

    const third = runtime.synthesize('http://localhost:3000/sanotts/', 'three', OPTIONS)
    expect(FakeWorker.created).toHaveLength(2)
    worker().reply({ id: 3, ok: true, ...result() })
    await expect(third).resolves.toEqual(result())
  })

  it('ignores a late error from a worker that was already dropped', async () => {
    const runtime = makeRuntime()
    const first = runtime.synthesize('http://localhost:3000/sanotts/', 'one', OPTIONS)
    const firstWorker = FakeWorker.created[0]!
    firstWorker.fail('boom')
    await expect(first).rejects.toThrow('boom')

    const second = runtime.synthesize('http://localhost:3000/sanotts/', 'two', OPTIONS)
    firstWorker.fail('late boom')
    worker().reply({ id: 2, ok: true, ...result() })
    await expect(second).resolves.toEqual(result())
  })

  it('names a blank worker error', async () => {
    const runtime = makeRuntime()
    const pending = runtime.synthesize('http://localhost:3000/sanotts/', 'one', OPTIONS)

    worker().fail('')

    await expect(pending).rejects.toThrow('read-aloud synthesis worker failed')
  })

  it('cancel terminates the worker and rejects what it owed', async () => {
    const runtime = makeRuntime()
    const pending = runtime.synthesize('http://localhost:3000/sanotts/', 'one', OPTIONS)
    const running = worker()

    runtime.cancel()

    await expect(pending).rejects.toThrow('read-aloud synthesis cancelled')
    expect(running.terminated).toBe(true)

    const next = runtime.synthesize('http://localhost:3000/sanotts/', 'two', OPTIONS)
    expect(FakeWorker.created).toHaveLength(2)
    worker().reply({ id: 2, ok: true, ...result() })
    await expect(next).resolves.toEqual(result())
  })

  it('cancel without a worker does nothing', () => {
    const runtime = makeRuntime()
    expect(() => { runtime.cancel() }).not.toThrow()
    expect(FakeWorker.created).toHaveLength(0)
  })

  it('the default factory builds a named Blob worker and revokes its URL', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:read-aloud')
    const revokeObjectURL = vi.fn((_url: string) => {})
    class StubURL extends URL {}
    Object.assign(StubURL, { createObjectURL, revokeObjectURL })
    vi.stubGlobal('URL', StubURL)
    vi.stubGlobal('Worker', FakeWorker)
    const runtime = new WorkerSynthesisRuntime()

    const pending = runtime.synthesize('http://localhost:3000/sanotts/', 'hello', OPTIONS)

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:read-aloud')
    const blob = createObjectURL.mock.calls[0]![0]
    expect(await blob.text()).toContain('importScripts(url)')
    const created = FakeWorker.created[0]!
    expect(created.source).toBe('blob:read-aloud')
    created.reply({ id: 1, ok: true, ...result() })
    await expect(pending).resolves.toEqual(result())
  })
})
