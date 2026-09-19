/**
 * Self-contained synthesis worker body. The main-thread runtime stringifies
 * this function into a Blob and runs it as a classic dedicated worker, so the
 * body must reference nothing but its parameters and worker globals. The
 * vendored runtime injects its Emscripten modules as `<script>` tags, which a
 * worker does not have, so the body installs a minimal `document` (and
 * `window`) shim whose `appendChild` maps to `importScripts`; the runtime's
 * own global checks then resolve exactly as they do in the page. The runtime
 * loads once per worker and each request synthesizes one chunk; the caller
 * owns chunking, so replies arrive in request order.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/worker
 */

import type {
  SanoSynthesizeOptions, SanoSynthesisResult, SanoTTSInstance, SanoTTSModule,
} from './sanotts-types.ts'

/** One chunk synthesis request from the main thread. */
export interface SanottsWorkerRequest {
  /** Correlation id echoed on the reply. */
  id: number
  /** Directory serving the runtime and its assets; must end with '/'. */
  assetBase: string
  /** The chunk to synthesize. */
  text: string
  /** Voice, weights base, and buffer cap for this call. */
  options: SanoSynthesizeOptions
}

/**
 * One synthesis reply: the waveform, or the runtime failure's marker
 * (`TrellisFrontendError` carries `name` and `kind` across the boundary).
 */
export type SanottsWorkerReply =
  | ({ id: number; ok: true } & SanoSynthesisResult)
  | { id: number; ok: false; name: string | undefined; kind: string | undefined; message: string }

/** Worker loading seams; the emitted bootstrap supplies the real globals. */
export interface SanottsWorkerDeps {
  /** Import the runtime module URL. */
  importModule: (url: string) => Promise<SanoTTSModule>
  /** Load a classic Emscripten script URL into the worker global, synchronously. */
  importScript: (url: string) => void
}

/** The self-like global the body runs against; extras are installed by the body. */
export interface SanottsWorkerScope {
  onmessage: ((event: MessageEvent<SanottsWorkerRequest>) => void) | null
  postMessage(message: SanottsWorkerReply): void
  /** Installed by the body: `window` and `document` for the vendored runtime. */
  [installed: string]: unknown
}

/** The element shape the runtime's loader fills in before appending. */
interface WorkerScriptElement {
  src: string
  async: boolean
  onload: (() => void) | null
  onerror: ((error: unknown) => void) | null
}

/**
 * Source of the Blob worker: the body invoked with the real worker globals.
 * The bootstrap stays a plain string so bundling never rewrites the dynamic
 * `import` the way it would inside a bundled module.
 * @returns JavaScript source for one synthesis worker.
 */
export function sanottsWorkerSource(): string {
  return `(${sanottsWorker.toString()})(self, {
    importModule: url => import(url),
    importScript: url => importScripts(url),
  })`
}

/**
 * Serve chunk synthesis requests until the worker is terminated. The first
 * request loads the runtime; a failed load is retried by the next request,
 * and a load for a different asset base replaces the cached instance.
 * @param scope - the worker global (`self`).
 * @param deps - module and classic-script loading seams.
 */
export function sanottsWorker(scope: SanottsWorkerScope, deps: SanottsWorkerDeps): void {
  scope.window = scope
  scope.document = {
    head: {
      appendChild: (element: WorkerScriptElement) => {
        try {
          deps.importScript(element.src)
          queueMicrotask(() => { element.onload?.() })
        } catch (error) {
          queueMicrotask(() => { element.onerror?.(error) })
        }
      },
    },
    createElement: (): WorkerScriptElement => ({ src: '', async: false, onload: null, onerror: null }),
    currentScript: null,
  }

  let loadedBase: string | undefined
  let instance: Promise<SanoTTSInstance> | undefined
  const runtime = (assetBase: string): Promise<SanoTTSInstance> => {
    if (instance === undefined || loadedBase !== assetBase) {
      loadedBase = assetBase
      const pending = deps.importModule(new URL('index.js', assetBase).toString())
        .then(module => module.SanoTTS.load({ assetBase }))
      instance = pending
      // A transient load failure should not poison the worker: drop the
      // rejected promise so the next request retries from scratch.
      pending.catch(() => {
        if (instance === pending) {
          instance = undefined
          loadedBase = undefined
        }
      })
    }
    return instance
  }

  scope.onmessage = (event) => { void synthesize(event.data) }

  async function synthesize(request: SanottsWorkerRequest): Promise<void> {
    try {
      const tts = await runtime(request.assetBase)
      scope.postMessage({ id: request.id, ok: true, ...await tts.synthesize(request.text, request.options) })
    } catch (error) {
      scope.postMessage({
        id: request.id,
        ok: false,
        name: error instanceof Error ? error.name : undefined,
        kind: error instanceof Error ? (error as { kind?: unknown }).kind as string | undefined : undefined,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
