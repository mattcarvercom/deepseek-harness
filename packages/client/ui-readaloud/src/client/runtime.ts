/**
 * Main-thread transport to the synthesis worker. The worker is created lazily
 * from the stringified self-contained body, loads the vendored runtime on its
 * first request, and stays alive across reads; requests are correlated by id.
 * A worker-level error rejects every pending request and drops the worker so
 * the next request starts a fresh one, and `cancel` terminates the worker —
 * that is the abort primitive the director's stop uses to discard in-flight
 * synthesis instead of letting it finish unobserved.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/runtime
 */

import type { SanoSynthesizeOptions, SanoSynthesisResult } from './sanotts-types.ts'
import { sanottsWorkerSource, type SanottsWorkerReply, type SanottsWorkerRequest } from './worker.ts'

/** Synthesize one chunk off the main thread. */
export interface SynthesisRuntime {
  /**
   * Synthesize text with the named voices.
   * @param assetBase - directory serving the runtime and its assets.
   * @param text - the chunk to synthesize.
   * @param options - voice, weights base, and buffer cap.
   * @returns the synthesized waveform.
   * @throws when the runtime rejects the text or the worker fails.
   */
  synthesize: (assetBase: string, text: string, options: SanoSynthesizeOptions) => Promise<SanoSynthesisResult>
  /** Terminate the worker and reject every in-flight request. */
  cancel: () => void
}

/** Construction seams; the default uses Blob and the platform Worker. */
export interface WorkerSynthesisRuntimeOptions {
  /** Worker constructor seam; receives the Blob worker's JavaScript source. */
  readonly createWorker?: (source: string) => Worker
}

/** One in-flight request awaiting its worker reply. */
interface PendingRequest {
  resolve: (result: SanoSynthesisResult) => void
  reject: (error: Error) => void
}

/**
 * Worker-backed synthesis runtime. One worker per instance, started on the
 * first request and terminated by `cancel`.
 */
export class WorkerSynthesisRuntime implements SynthesisRuntime {
  private readonly createWorker: (source: string) => Worker
  private worker: Worker | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()

  /**
   * @param options - construction seams; every member is optional.
   */
  constructor(options: WorkerSynthesisRuntimeOptions = {}) {
    this.createWorker = options.createWorker ?? startBlobWorker
  }

  synthesize(assetBase: string, text: string, options: SanoSynthesizeOptions): Promise<SanoSynthesisResult> {
    const worker = this.worker ??= this.startWorker()
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ id, assetBase, text, options } satisfies SanottsWorkerRequest)
    })
  }

  cancel(): void {
    const worker = this.worker
    if (worker === undefined) return
    this.drop(worker, new Error('read-aloud synthesis cancelled'))
  }

  private startWorker(): Worker {
    const worker = this.createWorker(sanottsWorkerSource())
    worker.onmessage = (event: MessageEvent<SanottsWorkerReply>) => { this.settle(event.data) }
    worker.onerror = (event: ErrorEvent) => {
      this.drop(worker, new Error(event.message === '' ? 'read-aloud synthesis worker failed' : event.message))
    }
    return worker
  }

  private settle(reply: SanottsWorkerReply): void {
    const pending = this.pending.get(reply.id)
    if (pending === undefined) return
    this.pending.delete(reply.id)
    if (reply.ok) {
      pending.resolve({
        samples: reply.samples,
        sampleRate: reply.sampleRate,
        phonemeCount: reply.phonemeCount,
        elapsedMs: reply.elapsedMs,
      })
      return
    }
    const error = new Error(reply.message)
    error.name = reply.name ?? 'Error'
    ;(error as { kind?: string | undefined }).kind = reply.kind
    pending.reject(error)
  }

  /**
   * Terminate the worker and reject every request it still owes. An error
   * from a worker that was already dropped or replaced is ignored; it no
   * longer owns the pending requests.
   * @param worker - the worker the error belongs to.
   * @param error - the rejection delivered to every pending request.
   */
  private drop(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = undefined
    worker.terminate()
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

/**
 * Default worker factory: a classic Blob worker from the emitted source. The
 * object URL is revoked immediately — the worker keeps its own reference.
 * @param source - the worker body source.
 * @returns the live worker.
 */
function startBlobWorker(source: string): Worker {
  const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  const worker = new Worker(objectUrl, { name: 'dsh-read-aloud' })
  URL.revokeObjectURL(objectUrl)
  return worker
}
