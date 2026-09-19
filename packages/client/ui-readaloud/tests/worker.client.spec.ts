// @vitest-environment jsdom
/**
 * The self-contained synthesis worker body: the emitted source invokes the
 * body with worker globals; the body installs a document/window shim whose
 * appendChild maps to importScripts (resolving the runtime's script loads);
 * and each onmessage request loads the runtime once — retried after a failed
 * load and replaced for a different asset base — then posts the waveform, or
 * the runtime's name/kind/message error marker, back.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  sanottsWorker, sanottsWorkerSource,
  type SanottsWorkerDeps, type SanottsWorkerRequest, type SanottsWorkerReply, type SanottsWorkerScope,
} from '../src/client/worker.ts'
import type { SanoSynthesizeOptions, SanoSynthesisResult, SanoTTSInstance } from '../src/client/sanotts-types.ts'

interface ScriptElement {
  src: string
  async: boolean
  onload: (() => void) | null
  onerror: ((error: unknown) => void) | null
}

interface ScopeDocument {
  createElement(): ScriptElement
  head: { appendChild(element: ScriptElement): void }
}

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

function result(samples = new Float32Array(3)): SanoSynthesisResult {
  return { samples, sampleRate: 8000, phonemeCount: 2, elapsedMs: 5 }
}

function makeScope() {
  const replies: SanottsWorkerReply[] = []
  const scope: SanottsWorkerScope = {
    onmessage: null,
    postMessage: (message) => { replies.push(message) },
  }
  return { scope, replies }
}

function makeDeps(tts?: Partial<SanoTTSInstance>) {
  const instance: SanoTTSInstance = {
    synthesize: vi.fn(async () => result()),
    ...tts,
  }
  const load = vi.fn(async () => instance)
  const importModule = vi.fn(async (_url: string) => ({ SanoTTS: { load } }))
  const importScript = vi.fn((_url: string) => {})
  const deps: SanottsWorkerDeps = { importModule, importScript }
  return { deps, importModule, importScript, load, instance }
}

function request(id: number, text: string, assetBase = 'http://localhost:3000/sanotts/'): SanottsWorkerRequest {
  const options: SanoSynthesizeOptions = { voice: 'heart', voiceBase: assetBase, maxSeconds: 300 }
  return { id, assetBase, text, options }
}

function send(scope: SanottsWorkerScope, message: SanottsWorkerRequest): void {
  scope.onmessage?.({ data: message } as MessageEvent<SanottsWorkerRequest>)
}

describe('sanottsWorkerSource', () => {
  it('invokes the body with the real worker globals', () => {
    const source = sanottsWorkerSource()
    expect(source).toContain('importModule: url => import(url)')
    expect(source).toContain('importScript: url => importScripts(url)')
  })
})

describe('sanottsWorker', () => {
  it('installs the window/document shim and maps appendChild to importScript', async () => {
    const { scope } = makeScope()
    const { deps, importScript } = makeDeps()
    sanottsWorker(scope, deps)

    expect(scope.window).toBe(scope)
    const doc = scope.document as ScopeDocument
    const element = doc.createElement()
    element.onload = vi.fn()
    element.src = 'http://localhost:3000/sanotts/snt_g2p.js'
    doc.head.appendChild(element)

    await flush()
    expect(importScript).toHaveBeenCalledWith('http://localhost:3000/sanotts/snt_g2p.js')
    expect(element.onload).toHaveBeenCalledTimes(1)
  })

  it('reports a failed classic-script load through onerror', async () => {
    const { scope } = makeScope()
    const { deps, importScript } = makeDeps()
    importScript.mockImplementation(() => { throw new Error('blocked') })
    sanottsWorker(scope, deps)

    const element = (scope.document as ScopeDocument).createElement()
    element.onerror = vi.fn()
    element.src = 'http://localhost:3000/sanotts/sentinel.js'
    ;(scope.document as ScopeDocument).head.appendChild(element)

    await flush()
    expect(element.onerror).toHaveBeenCalledWith(expect.objectContaining({ message: 'blocked' }))
  })

  it('loads the runtime once and answers each request with the waveform', async () => {
    const { scope, replies } = makeScope()
    const { deps, importModule, load, instance } = makeDeps()
    sanottsWorker(scope, deps)

    send(scope, request(7, 'hello'))
    await flush()

    expect(importModule).toHaveBeenCalledWith('http://localhost:3000/sanotts/index.js')
    expect(load).toHaveBeenCalledWith({ assetBase: 'http://localhost:3000/sanotts/' })
    expect(instance.synthesize).toHaveBeenCalledWith('hello', {
      voice: 'heart',
      voiceBase: 'http://localhost:3000/sanotts/',
      maxSeconds: 300,
    })
    expect(replies).toEqual([{ id: 7, ok: true, ...result() }])

    send(scope, request(8, 'again'))
    await flush()
    expect(importModule).toHaveBeenCalledTimes(1)
    expect(replies).toHaveLength(2)
  })

  it('retries a failed load on the next request without re-importing the module', async () => {
    const { scope, replies } = makeScope()
    const { deps, importModule, load } = makeDeps()
    load.mockRejectedValueOnce(new Error('weights missing'))
    sanottsWorker(scope, deps)

    send(scope, request(1, 'first'))
    await flush()
    expect(replies).toEqual([{
      id: 1, ok: false, name: 'Error', kind: undefined, message: 'weights missing',
    }])

    send(scope, request(2, 'second'))
    await flush()
    expect(importModule).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledTimes(2)
    expect(replies[1]).toMatchObject({ id: 2, ok: true })
  })

  it('retries a failed module import on the next request', async () => {
    const { scope, replies } = makeScope()
    const { deps, importModule } = makeDeps()
    importModule.mockRejectedValueOnce(new Error('offline'))
    sanottsWorker(scope, deps)

    send(scope, request(1, 'first'))
    await flush()
    expect(replies[0]).toMatchObject({ id: 1, ok: false, message: 'offline' })

    send(scope, request(2, 'second'))
    await flush()
    expect(replies[1]).toMatchObject({ id: 2, ok: true })
  })

  it('replaces the runtime when the asset base changes', async () => {
    const { scope } = makeScope()
    const { deps, importModule } = makeDeps()
    sanottsWorker(scope, deps)

    send(scope, request(1, 'one', 'http://a.test/sanotts/'))
    await flush()
    send(scope, request(2, 'two', 'http://b.test/sanotts/'))
    await flush()

    expect(importModule.mock.calls.map(call => call[0])).toEqual([
      'http://a.test/sanotts/index.js',
      'http://b.test/sanotts/index.js',
    ])
  })

  it('keeps a newer load when a superseded load fails late', async () => {
    const { scope, replies } = makeScope()
    const { deps, importModule } = makeDeps()
    let rejectFirst: ((error: unknown) => void) | undefined
    importModule.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
    sanottsWorker(scope, deps)

    send(scope, request(1, 'first', 'http://a.test/sanotts/'))
    await flush()
    send(scope, request(2, 'second', 'http://b.test/sanotts/'))
    await flush()
    rejectFirst?.(new Error('a failed'))
    await flush()
    await flush()

    expect(replies).toHaveLength(2)
    expect(replies).toContainEqual({ id: 1, ok: false, name: 'Error', kind: undefined, message: 'a failed' })
    expect(replies).toContainEqual({ id: 2, ok: true, ...result() })
  })

  it('carries the runtime error marker across the worker boundary', async () => {
    const { scope, replies } = makeScope()
    const { deps, instance } = makeDeps()
    vi.mocked(instance.synthesize).mockRejectedValueOnce(Object.assign(new Error('too long'), {
      name: 'TrellisFrontendError', kind: 'too_long',
    }))
    sanottsWorker(scope, deps)

    send(scope, request(3, 'pathological'))
    await flush()

    expect(replies).toEqual([{
      id: 3, ok: false, name: 'TrellisFrontendError', kind: 'too_long', message: 'too long',
    }])
  })

  it('stringifies a rejection that is not an Error', async () => {
    const { scope, replies } = makeScope()
    const { deps, instance } = makeDeps()
    vi.mocked(instance.synthesize).mockRejectedValueOnce('not an error')
    sanottsWorker(scope, deps)

    send(scope, request(4, 'weird'))
    await flush()

    expect(replies).toEqual([{
      id: 4, ok: false, name: undefined, kind: undefined, message: 'not an error',
    }])
  })
})
