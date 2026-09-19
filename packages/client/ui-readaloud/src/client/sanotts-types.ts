/**
 * Typed surface of the vendored sanotts-web runtime (assets/sanotts/index.js,
 * GPL-3.0 — see the directory's MANIFEST.md and LICENSE files). The runtime
 * is deliberately outside the bundle graph: the engine reaches it through a
 * dynamic import of a URL, so this module declares the subset of its API the
 * engine consumes instead of importing the file.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/sanotts-types
 */

/** Result of one sanotts synthesis call. */
export interface SanoSynthesisResult {
  /** Mono-channel PCM in the voice's sample rate. */
  samples: Float32Array
  /** Sample rate of `samples` in hertz (24000 for the heart lineage). */
  sampleRate: number
  /** Phoneme ids the G2P step produced for the input text. */
  phonemeCount: number
  /** Wall-clock milliseconds the synthesis took. */
  elapsedMs: number
}

/** Loader options: where the wasm modules are served from. */
export interface SanoLoadOptions {
  /** Directory serving the G2P and voice wasm modules; must end with '/'. */
  assetBase: string
}

/** Options for one synthesis call. */
export interface SanoSynthesizeOptions {
  /** Voice key, resolved as `voices/<key>/` under `voiceBase`. */
  voice: string
  /** Weights directory; an explicit base disables the runtime's CDN fallback. */
  voiceBase: string
  /** Speech-rate multiplier overriding the voice's default. */
  lengthScale?: number
  /** Output buffer cap in seconds; longer utterances are truncated. */
  maxSeconds?: number
}

/** The sanotts instance as the engine consumes it. */
export interface SanoTTSInstance {
  /**
   * Synthesize text to PCM with the named voice.
   * @param text - non-empty utterance.
   * @param options - voice, weights base, rate, and buffer cap.
   * @returns the synthesized waveform.
   * @throws when the text is empty, the voice is missing, or a module fails to load.
   */
  synthesize: (text: string, options?: SanoSynthesizeOptions) => Promise<SanoSynthesisResult>
}

/** The runtime's module exports: the loader and the instance class. */
export interface SanoTTSModule {
  /** Load the wasm runtime against `assetBase`; await before synthesize. */
  SanoTTS: {
    load: (options?: SanoLoadOptions) => Promise<SanoTTSInstance>
  }
}
