/**
 * Chunked sanotts engine. The utterance is split into sentence-sized chunks
 * and `stream` yields each chunk's waveform as it lands, so playback can
 * start as soon as the first one is ready while the worker synthesizes the
 * rest. Synthesis itself runs in the worker runtime; `cancel` aborts it. The
 * nano voice's frontend accepts at most 207 phoneme tokens per call, and
 * character count alone cannot bound phonemes (digit runs, path-like tokens,
 * and symbol runs expand), so a chunk the runtime still rejects as over the
 * cap is split and retried.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/engine
 */

import { chunkSpeech, endsSentence } from './chunker.ts'
import { WorkerSynthesisRuntime, type SynthesisRuntime } from './runtime.ts'
import type { SanoSynthesisResult, SanoSynthesizeOptions } from './sanotts-types.ts'
import { DEFAULT_READALOUD_VOICE, type ReadAloudVoiceKey } from './voices.ts'

/** Resolved asset locations for one engine. */
export interface EngineAssetBases {
  /** Directory serving the G2P and voice wasm modules. */
  readonly assetBase: string
  /** Voice weights directory; an explicit base disables the CDN fallback. */
  readonly voiceBase: string
}

/** Per-call output buffer cap in seconds; one chunk stays far below it. */
const MAX_SECONDS = 300

/** Silence kept before a chunk's first audible sample, in seconds. */
const LEAD_SILENCE_KEEP_SECONDS = 0.03

/** Silence kept after a chunk's last audible sample when it ends a sentence, in seconds. */
const SENTENCE_TAIL_KEEP_SECONDS = 0.4

/** Silence kept after a chunk's last audible sample when the sentence continues, in seconds. */
const CONTINUATION_TAIL_KEEP_SECONDS = 0.15

/** A sample counts as audible above this fraction of the chunk's peak. */
const AUDIBLE_PEAK_FRACTION = 0.01

/**
 * Default bases: the served copy of the vendored assets, next to the page
 * document. `document.baseURI` resolves any `<base href>` the host mounts
 * the client under.
 * @returns both bases pointing at `<base>sanotts/`.
 */
function defaultBases(): EngineAssetBases {
  const dir = new URL('sanotts/', document.baseURI).toString()
  return { assetBase: dir, voiceBase: dir }
}

/** One synthesized chunk: the text that produced it, its span, and its waveform. */
export interface SanottsChunk {
  /** The chunk's speaker text, in utterance order. */
  readonly text: string
  /** Start offset of the chunk in the synthesized text, inclusive. */
  readonly start: number
  /** End offset of the chunk in the synthesized text, exclusive. */
  readonly end: number
  /** The chunk's waveform. */
  readonly result: SanoSynthesisResult
}

/** Engine construction options; both seams default to the production values. */
export interface SanottsEngineOptions {
  /** Synthesis transport; defaults to the worker runtime. */
  readonly runtime?: SynthesisRuntime
  /** Asset and weights bases; default to `<base>sanotts/`. */
  readonly bases?: EngineAssetBases
}

/**
 * Stream spoken audio from the vendored sanotts runtime, one chunk at a time.
 * The whole utterance is chunked up front; synthesis is demand-driven, so no
 * worker request is sent until the consumer asks for the next chunk.
 */
export class SanottsEngine {
  private readonly runtime: SynthesisRuntime
  private readonly bases: EngineAssetBases

  /**
   * @param options - construction seams; every member is optional.
   */
  constructor(options: SanottsEngineOptions = {}) {
    this.runtime = options.runtime ?? new WorkerSynthesisRuntime()
    this.bases = options.bases ?? defaultBases()
  }

  /**
   * Synthesize text to PCM with the given voice, yielding each chunk in
   * utterance order as soon as it is ready. The chunks are chunked sentence
   * boundaries; a chunk the runtime rejects as over its token cap is split in
   * half and retried before it is yielded. Whitespace-only text goes to the
   * runtime unsplit, which rejects it.
   * @param text - the utterance; the runtime rejects empty text.
   * @param voice - a registered read-aloud voice key; defaults to the default voice.
   * @yields each chunk's text and waveform, in order.
   * @throws when the runtime, a wasm asset, the voice weights, or a chunk synthesis fail.
   */
  async *stream(text: string, voice: ReadAloudVoiceKey = DEFAULT_READALOUD_VOICE): AsyncGenerator<SanottsChunk> {
    const options: SanoSynthesizeOptions = {
      voice,
      voiceBase: this.bases.voiceBase,
      maxSeconds: MAX_SECONDS,
    }
    const chunks = chunkSpeech(text)
    if (chunks.length === 0) {
      yield {
        text,
        start: 0,
        end: text.length,
        result: trimBoundarySilence(await this.synthesize(text, options), endsSentence(text)),
      }
      return
    }
    for (const chunk of chunks) {
      yield {
        text: chunk.text,
        start: chunk.start,
        end: chunk.end,
        result: trimBoundarySilence(await this.synthesize(chunk.text, options), endsSentence(chunk.text)),
      }
    }
  }

  /**
   * Abort any in-flight synthesis and discard the worker, so a stopped read
   * leaves no work running; the next read starts a fresh worker.
   */
  cancel(): void {
    this.runtime.cancel()
  }

  /**
   * Synthesize one chunk. A chunk the runtime rejects as over the token cap
   * is split in half and both halves retried. Any other failure propagates
   * unchanged, and a single character cannot be split further, so the
   * recursion terminates.
   * @param text - the chunk to synthesize.
   * @param options - voice, weights base, and buffer cap for every call.
   * @returns the chunk's waveform, stitched from any split retries.
   * @throws when the runtime fails for any reason other than the token cap.
   */
  private async synthesize(text: string, options: SanoSynthesizeOptions): Promise<SanoSynthesisResult> {
    try {
      return await this.runtime.synthesize(this.bases.assetBase, text, options)
    } catch (error) {
      if (!isTokenLimitError(error) || text.length < 2) throw error
      const [head, tail] = splitChunk(text)
      return combineParts([await this.synthesize(head, options), await this.synthesize(tail, options)])
    }
  }
}

/**
 * Recognize the vendored frontend's token-cap rejection. The runtime crosses
 * the worker boundary as plain JSON, so its marker is validated here; the
 * same error name covers other kinds (for example `empty` for text with no
 * phonemizable symbols), which must not be split.
 * @param error - the value a synthesis call rejected with.
 * @returns true when splitting the text can bring it under the token cap.
 */
function isTokenLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'TrellisFrontendError'
    && (error as { kind?: unknown }).kind === 'too_long'
}

/**
 * Split a chunk the runtime rejected as too long: at the last word boundary
 * at or before the midpoint, or at the midpoint when the chunk holds no
 * word boundary. The caller only splits text of at least two characters, so
 * both pieces are non-empty.
 * @param text - the over-budget chunk.
 * @returns the two pieces in order.
 */
function splitChunk(text: string): [string, string] {
  const middle = Math.floor(text.length / 2)
  const boundary = text.lastIndexOf(' ', middle)
  return boundary > 0
    ? [text.slice(0, boundary).trimEnd(), text.slice(boundary + 1).trimStart()]
    : [text.slice(0, middle), text.slice(middle)]
}

/**
 * Stitch the waveforms of one chunk's split retries into one result. The
 * first part's sample rate is used — all parts share it — and the phoneme
 * counts and elapsed times are summed.
 * @param parts - the per-retry results, in order, at least one.
 * @returns one result carrying the concatenated waveform.
 */
function combineParts(parts: SanoSynthesisResult[]): SanoSynthesisResult {
  // parts is never empty here: each retry piece resolves to exactly one part.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const sampleRate = parts[0]!.sampleRate
  const total = parts.reduce((sum, part) => sum + part.samples.length, 0)
  const samples = new Float32Array(total)
  let offset = 0
  let phonemeCount = 0
  let elapsedMs = 0
  for (const part of parts) {
    phonemeCount += part.phonemeCount
    elapsedMs += part.elapsedMs
    samples.set(part.samples, offset)
    offset += part.samples.length
  }
  return { samples, sampleRate, phonemeCount, elapsedMs }
}

/**
 * Trim the dead air the runtime pads every synthesis with. Each call carries
 * roughly 300 ms of leading and 400-500 ms of trailing silence, so untreated
 * chunks butt together with an unnatural ~700 ms gap; the leading silence is
 * trimmed to a short onset guard, and the trailing silence to a sentence
 * pause when the chunk closes a sentence or to a shorter clause pause when
 * the sentence continues into the next chunk.
 * @param result - the raw synthesis result.
 * @param closesSentence - whether the chunk's text ends a sentence.
 * @returns the result with trimmed samples; the input unchanged when nothing is audible.
 */
function trimBoundarySilence(result: SanoSynthesisResult, closesSentence: boolean): SanoSynthesisResult {
  const { samples, sampleRate } = result
  let peak = 0
  for (const sample of samples) {
    const amplitude = Math.abs(sample)
    if (amplitude > peak) peak = amplitude
  }
  const threshold = Math.max(peak * AUDIBLE_PEAK_FRACTION, 1e-4)
  const first = samples.findIndex(sample => Math.abs(sample) > threshold)
  if (first === -1) return result
  const last = samples.findLastIndex(sample => Math.abs(sample) > threshold)
  const tail = closesSentence ? SENTENCE_TAIL_KEEP_SECONDS : CONTINUATION_TAIL_KEEP_SECONDS
  const from = Math.max(0, first - Math.round(LEAD_SILENCE_KEEP_SECONDS * sampleRate))
  const to = Math.min(samples.length, last + 1 + Math.round(tail * sampleRate))
  if (from === 0 && to === samples.length) return result
  return { ...result, samples: samples.subarray(from, to) }
}
