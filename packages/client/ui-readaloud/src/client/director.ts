/**
 * Page-global read-aloud director: one lazily created, shared AudioContext
 * and at most one live read at a time. Starting any read stops the previous
 * one, whatever Session it belongs to. Synthesis is worker-backed and
 * streamed: playback starts as soon as the first chunk is ready, each later
 * chunk is scheduled onto the shared AudioContext as it arrives, and a stop
 * cancels the in-flight synthesis as well as the scheduled sources. A
 * generation token discards a result whose request was superseded (a new
 * speak or a stop) before it landed. Scheduled audio is capped at the
 * five-minute output limit.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/director
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the per-message highlight shape ui-chat renders.
import type { ChatTextHighlight, ChatTextHighlightRange } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MarkdownPlainTextSegment } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SanottsEngine } from './engine.ts'
import type { SpeakableBlock } from './sanitizer.ts'
import type { SanoSynthesisResult } from './sanotts-types.ts'
import { DEFAULT_READALOUD_VOICE, type ReadAloudVoiceKey } from './voices.ts'

/** Playback phase of one message's read-aloud. */
export type ReadAloudPhase = 'idle' | 'synthesizing' | 'playing' | 'paused' | 'failed'

/** Per-session playback state published to that Session's message entries. */
export interface ReadAloudPlaybackState {
  /** The message the playback belongs to, if any. */
  messageId: MessageId | undefined
  phase: ReadAloudPhase
  /** The Markdown source ranges currently being spoken, when a read is live. */
  highlight: ChatTextHighlight | undefined
}

/** The resting state every store starts from. */
export const INITIAL_READALOUD_PLAYBACK: ReadAloudPlaybackState = {
  messageId: undefined,
  phase: 'idle',
  highlight: undefined,
}

/** One request to read a message aloud. */
export interface SpeakRequest {
  /** Session that owns the published playback store. */
  sessionId: SessionId
  /** The message being read. */
  messageId: MessageId
  /** The message's speakable blocks, in transcript order. */
  blocks: readonly SpeakableBlock[]
  /** The Session's playback store the state is published into. */
  store: SnapshotStore<ReadAloudPlaybackState>
}

/** Total scheduled audio cap in seconds; later chunks are dropped. */
const MAX_SECONDS = 300

/** Lead before a source's start time, so scheduling never races playback. */
const START_LEAD_SECONDS = 0.25

/** Silence prepended to the first scheduled source, so output start-up cannot clip the opening word. */
const START_PAD_SECONDS = 0.08

/**
 * Longest word a resume replays from its start. A cut inside a longer run —
 * a space-free script, or a path-like token — resumes there instead, so the
 * remainder never skips the rest of a long run to reach the next space.
 */
const MAX_RESUME_WORD_CHARS = 24

/**
 * How far past a chunk's scheduled end the clock may run before the chunk is
 * treated as suspicious rather than played out: a suspended browser clock can
 * jump past scheduled audio that never sounded, and a pause must replay that
 * audio instead of skipping it.
 */
const PAUSE_CLOCK_TOLERANCE_SECONDS = 0.25

/** One scheduled chunk, with everything a pause needs to resume inside it. */
interface ScheduledHighlight {
  /** The highlight this chunk publishes when it starts playing. */
  readonly highlight: ChatTextHighlight
  /** The block the chunk was cut from. */
  readonly block: SpeakableBlock
  /** The chunk's span in the block's speakable text. */
  readonly start: number
  readonly end: number
  /** The AudioContext time the source starts, and how long it plays. */
  readonly startAt: number
  readonly duration: number
  /** The chunk's source finished playing. */
  ended: boolean
  /** The highlight to publish when this chunk's source ends, if one is scheduled. */
  next: ScheduledHighlight | undefined
}

/** A read being assembled from streamed blocks; blocks arrive through append. */
export interface StreamReadRequest {
  /** Session that owns the published playback store. */
  sessionId: SessionId
  /** This read's routing key, distinct from a durable message id until bind. */
  key: string
  /** The Session's playback store the state is published into. */
  store: SnapshotStore<ReadAloudPlaybackState>
}

/** One live read and every source scheduled for it so far. */
interface LiveRead {
  sessionId: SessionId
  key: string
  /** Durable message id the state publishes under; absent until bound. */
  messageId: MessageId | undefined
  store: SnapshotStore<ReadAloudPlaybackState>
  sources: AudioBufferSourceNode[]
  /** Sources scheduled but not yet finished; when zero with the stream done, the read is over. */
  openSources: number
  /** Scheduled chunk highlights in playback order. */
  highlights: ScheduledHighlight[]
  /** The chunk whose source is sounding (or about to sound); absent between chunks. */
  playing: ScheduledHighlight | undefined
  /** How far playback actually got, as the last chunk that ended. */
  playedEnd: { readonly block: SpeakableBlock; readonly end: number } | undefined
  /** Blocks waiting for synthesis, in read order. */
  queue: SpeakableBlock[]
  /** No more blocks will arrive for this read. */
  finished: boolean
  /** Resolves the consume loop's wait for the next block. */
  wake: (() => void) | undefined
  /** The phase the store currently publishes. */
  phase: 'synthesizing' | 'playing' | 'paused'
  /** The most recently published highlight, re-published on a bind. */
  lastHighlight: ChatTextHighlight | undefined
  /** The block currently being synthesized, if any (shifted off the queue). */
  current: SpeakableBlock | undefined
  /** A pause retired the scheduled audio; the consume loop parks until resume. */
  paused: boolean
  /** The consume loop is running (a resume after it returned restarts it). */
  consumeActive: boolean
  /** Bumped on pause so an in-flight chunk from before the pause is dropped. */
  epoch: number
  /** The read this one will replace once its first chunk is scheduled. */
  takeover: LiveRead | undefined
  /** A stop or takeover retired this read; its consume loop and callbacks return. */
  superseded: boolean
  /** End of the last scheduled source, on the AudioContext clock. */
  nextStartTime: number
  scheduledSeconds: number
  /** The engine stream delivered every chunk it will deliver. */
  streamDone: boolean
}

/**
 * Own every read-aloud on the page. The AudioContext is created on the first
 * speak (inside a user gesture when the request came from one) and resumed on
 * each play; a context the autoplay policy keeps suspended stays silent until
 * the next gesture, which the browser then unlocks.
 */
export class ReadAloudDirector {
  private readonly engine: SanottsEngine
  private readonly voice: ReadAloudVoiceKey
  private audio: AudioContext | undefined
  private live: LiveRead | undefined
  private disposed = false

  /**
   * @param engine - the synthesis engine this director streams from.
   * @param voice - the voice every request is synthesized with.
   */
  constructor(engine: SanottsEngine, voice: ReadAloudVoiceKey = DEFAULT_READALOUD_VOICE) {
    this.engine = engine
    this.voice = voice
  }

  /**
   * Read a message aloud, stopping and cancelling whatever is live first.
   * Playback starts when the first chunk lands; every later chunk is
   * scheduled behind it as the stream delivers it.
   * @param request - the Session, message, text, and playback store of the request.
   */
  speak(request: SpeakRequest): void {
    const live = this.begin(
      request.sessionId, String(request.messageId), request.messageId, request.store, false,
    )
    if (live === undefined) return
    live.queue.push(...request.blocks)
    live.finished = true
    void this.consume(live)
  }

  /**
   * Begin a read that grows: blocks arrive through {@link append} until
   * {@link finish}, and {@link bind} attaches the durable message id once the
   * generating message has one. A streaming read lets whatever is already
   * playing run until its first chunk is scheduled, so the previous voice is
   * not cut off before the new one can speak.
   * @param request - the session, routing key, and playback store.
   */
  startStream(request: StreamReadRequest): void {
    const live = this.begin(request.sessionId, request.key, undefined, request.store, true)
    if (live === undefined) return
    void this.consume(live)
  }

  /**
   * Append one speakable block to the matching live read; ignored when the
   * read is gone or belongs to another session or key.
   * @param sessionId - the read's session.
   * @param key - the read's routing key.
   * @param block - the block to queue behind everything already queued.
   */
  append(sessionId: SessionId, key: string, block: SpeakableBlock): void {
    const live = this.matching(sessionId, key)
    if (live === undefined) return
    live.queue.push(block)
    // The first utterance marks as soon as it is queued: its synthesis takes
    // seconds, and the mark should track the generating text meanwhile. The
    // first scheduled chunk then replaces it with the exact playing range.
    if (live.sources.length === 0 && live.lastHighlight === undefined) {
      live.phase = 'synthesizing'
      live.lastHighlight = {
        blockIndex: block.blockIndex,
        ranges: block.segments.map(segment => ({
          start: segment.sourceStart,
          end: segment.sourceEnd,
        })),
      }
      live.store.set({
        messageId: live.messageId,
        phase: 'synthesizing',
        highlight: live.lastHighlight,
      })
    }
    this.wake(live)
  }

  /**
   * Declare that no more blocks will arrive for the matching read.
   * @param sessionId - the read's session.
   * @param key - the read's routing key.
   */
  finish(sessionId: SessionId, key: string): void {
    const live = this.matching(sessionId, key)
    if (live === undefined) return
    live.finished = true
    this.wake(live)
  }

  /**
   * Attach the durable message id to a streaming read, so playback state,
   * stop controls, and highlights address the message that now exists.
   * @param sessionId - the read's session.
   * @param key - the read's routing key.
   * @param messageId - the durable message id.
   */
  bind(sessionId: SessionId, key: string, messageId: MessageId): void {
    const live = this.matching(sessionId, key)
    if (live === undefined) return
    live.messageId = messageId
    live.store.set({
      messageId,
      phase: live.phase,
      highlight: live.lastHighlight,
    })
  }

  private begin(
    sessionId: SessionId,
    key: string,
    messageId: MessageId | undefined,
    store: SnapshotStore<ReadAloudPlaybackState>,
    defer: boolean,
  ): LiveRead | undefined {
    if (this.disposed) return undefined
    const previous = defer ? this.live : undefined
    if (!defer) this.stop()
    // The context is created inside this call, so a manual read resumes it
    // inside the user's gesture; auto-read resumes here too, best effort.
    this.ensureRunning()
    const live: LiveRead = {
      sessionId,
      key,
      messageId,
      store,
      sources: [],
      openSources: 0,
      highlights: [],
      playing: undefined,
      playedEnd: undefined,
      queue: [],
      current: undefined,
      paused: false,
      consumeActive: false,
      epoch: 0,
      finished: false,
      wake: undefined,
      phase: 'synthesizing',
      lastHighlight: undefined,
      takeover: previous,
      superseded: false,
      nextStartTime: 0,
      scheduledSeconds: 0,
      streamDone: false,
    }
    this.live = live
    store.set({ messageId, phase: 'synthesizing', highlight: undefined })
    return live
  }

  /** The live read matching one session and key, if it is the current read. */
  private matching(sessionId: SessionId, key: string): LiveRead | undefined {
    const live = this.live
    return live !== undefined && live.sessionId === sessionId && live.key === key ? live : undefined
  }

  /** Wake the consume loop that is waiting for its next block. */
  private wake(live: LiveRead): void {
    const wake = live.wake
    live.wake = undefined
    wake?.()
  }

  /**
   * Stop the live read: cancel the in-flight synthesis, stop every scheduled
   * source, and publish idle. Idempotent; a late stream result is discarded
   * by the generation bump.
   */
  stop(): void {
    if (this.disposed) return
    const live = this.live
    if (live === undefined) return
    this.live = undefined
    const takeover = live.takeover
    this.retire(live)
    if (takeover !== undefined) this.retire(takeover)
  }

  /**
   * Pause the active read where it is: scheduled audio stops, synthesis parks
   * after the current utterance, and the position is kept so {@link resume}
   * continues instead of restarting. Pausing an idle or idle-ish read is a
   * no-op.
   */
  pause(): void {
    if (this.disposed) return
    const live = this.live
    if (live === undefined || live.paused) return
    live.paused = true
    live.epoch += 1
    // Rebuild the unplayed work in order: the sounding block's remainder,
    // then every block whose scheduled audio this pause discarded (synthesis
    // runs ahead of playback, so whole utterances can be synthesized but
    // never heard), then the block under synthesis, then the untouched queue.
    const point = this.pausePoint(live)
    const rebuild: SpeakableBlock[] = []
    const rebuilt = new Set<SpeakableBlock>()
    const push = (block: SpeakableBlock): void => {
      if (rebuilt.has(block)) return
      rebuilt.add(block)
      rebuild.push(block)
    }
    if (point.kind !== 'none') rebuilt.add(point.block)
    if (point.kind === 'remainder') rebuild.push(sliceSpeakable(point.block, point.from))
    let unplayed = point.kind === 'none'
    for (const entry of live.highlights) {
      if (!unplayed) {
        if (point.kind !== 'none' && entry.block === point.block) unplayed = true
        continue
      }
      push(entry.block)
    }
    if (live.current !== undefined) push(live.current)
    live.queue = [...rebuild, ...live.queue]
    live.current = undefined
    live.playing = undefined
    live.playedEnd = undefined
    for (const source of live.sources) this.stopSource(source)
    // Anything scheduled ahead was retired by the pause; the resume rebuilds
    // playback from the remainder, so the stopped sources leave no open
    // bookkeeping behind.
    live.sources = []
    live.openSources = 0
    live.highlights = []
    live.nextStartTime = 0
    live.phase = 'paused'
    live.store.set({
      messageId: live.messageId,
      phase: 'paused',
      highlight: live.lastHighlight,
    })
  }

  /** Resume the paused read from its kept position; a no-op otherwise. */
  resume(): void {
    if (this.disposed) return
    const live = this.live
    if (live === undefined || !live.paused) return
    live.paused = false
    // A pause that landed after the last utterance played out has nothing to
    // resume; settle instead of publishing a read that can never speak.
    if (live.finished && live.queue.length === 0) {
      live.superseded = true
      this.settle(live)
      return
    }
    // A browser may have suspended the context while the read was paused, and
    // a suspended context silently swallows every scheduled source; the
    // resume click is the gesture that brings it back.
    this.ensureRunning()
    live.phase = 'synthesizing'
    live.store.set({
      messageId: live.messageId,
      phase: 'synthesizing',
      highlight: live.lastHighlight,
    })
    // A read whose synthesis finished left no loop behind; the rebuilt queue
    // needs a consumer, or the resume would publish a phase and stay silent.
    if (live.consumeActive) this.wake(live)
    else void this.consume(live)
  }

  /**
   * Pause the active read only when it belongs to the given Session; used
   * when that Session's surfaces unmount (a session switch pauses instead of
   * losing the position).
   * @param sessionId - the Session whose surfaces are going away.
   */
  pauseSession(sessionId: SessionId): void {
    if (this.live?.sessionId === sessionId) this.pause()
  }

  /**
   * Whether a streaming read with this Session and key is live (playing,
   * synthesizing, or paused).
   * @param sessionId - the read's Session.
   * @param key - the read's routing key.
   * @returns true while the read exists.
   */
  isStreaming(sessionId: SessionId, key: string): boolean {
    return this.matching(sessionId, key) !== undefined
  }

  /**
   * Where a pause left off: the block the listener is hearing and the offset
   * in it to resume from. The target is the chunk whose source is sounding —
   * tracked through the playback chain, never picked by comparing the clock
   * to scheduled start times, because a suspended browser clock can run past
   * audio that never sounded. The offset comes from that chunk's own span;
   * when the clock is not credible for the chunk, it is replayed from its
   * start rather than skipped.
   * @param live - the read being paused.
   * @returns the resume point for the pending work rebuild.
   */
  private pausePoint(live: LiveRead): PausePoint {
    const entry = live.playing
    if (entry !== undefined) {
      const block = entry.block
      const now = this.context().currentTime
      const end = entry.startAt + entry.duration
      const credible = now < end + PAUSE_CLOCK_TOLERANCE_SECONDS
      const fraction = credible ? Math.max(0, Math.min(1, (now - entry.startAt) / entry.duration)) : 0
      const span = Math.max(1, entry.end - entry.start)
      const at = Math.min(block.text.length, entry.start + Math.floor(fraction * span))
      const from = nextWordStart(block.text, at)
      if (from >= block.text.length) return { kind: 'exhausted', block }
      return { kind: 'remainder', block, from }
    }
    // Between chunks: resume where the last ended, or the block in synthesis.
    const played = live.playedEnd
    if (played !== undefined) {
      const from = nextWordStart(played.block.text, played.end)
      if (from < played.block.text.length) return { kind: 'remainder', block: played.block, from }
      if (played.block === live.current) return { kind: 'exhausted', block: played.block }
    }
    return live.current === undefined
      ? { kind: 'none' }
      : { kind: 'remainder', block: live.current, from: 0 }
  }

  /**
   * Retire one read: reject further synthesis, stop its scheduled audio, and
   * publish the resting state. Its consume loop and late callbacks observe
   * `superseded` and do nothing further.
   * @param live - the read to retire.
   */
  private retire(live: LiveRead): void {
    live.superseded = true
    // A consumer waiting for its next block must wake to observe the stop.
    this.wake(live)
    this.engine.cancel()
    for (const source of live.sources) this.stopSource(source)
    live.store.set({ messageId: undefined, phase: 'idle', highlight: undefined })
  }

  /** Stop playback, close the AudioContext, and refuse further requests. */
  dispose(): void {
    this.stop()
    this.disposed = true
    if (this.audio !== undefined) {
      void this.audio.close().catch(() => {
        // A context already closed rejects a second close; the director is
        // being torn down, so the rejection has nowhere to go.
      })
      this.audio = undefined
    }
  }

  /**
   * Drain the engine's chunk stream, scheduling each chunk behind the last.
   * A rejected chunk stops the scheduled audio and publishes failed; a
   * superseded read simply returns, its result already discarded.
   * @param live - the read this loop belongs to.
   */
  /**
   * Whether a pause or a later resume pass abandoned the chunks still coming
   * from one synthesis pass.
   * @param live - the read being synthesized.
   * @param epoch - the pass's epoch, bumped by every pause.
   * @returns true when the pass's chunks must be dropped.
   */
  private abandonedPass(live: LiveRead, epoch: number): boolean {
    return live.paused || epoch !== live.epoch
  }

  private async consume(live: LiveRead): Promise<void> {
    live.consumeActive = true
    try {
      blocks:
      for (;;) {
        if (live.paused) {
          await new Promise<void>((resolve) => { live.wake = resolve })
          continue
        }
        const block = live.queue.shift()
        if (block === undefined) {
          if (live.finished) break blocks
          await new Promise<void>((resolve) => { live.wake = resolve })
          if (live.superseded) return
          continue
        }
        live.current = block
        const epoch = live.epoch
        for await (const chunk of this.engine.stream(block.text, this.voice)) {
          if (live.superseded) return
          // A pause abandons the rest of this utterance's chunks; the pause
          // itself already queued the unplayed remainder, and a resume starts
          // a fresh pass whose chunks are the only ones that may play.
          if (this.abandonedPass(live, epoch)) break
          const remaining = MAX_SECONDS - live.scheduledSeconds
          if (remaining <= 0) break blocks
          const length = Math.min(chunk.result.samples.length, Math.floor(remaining * chunk.result.sampleRate))
          this.schedule(live, chunk.result, length, { block, start: chunk.start, end: chunk.end }, {
            blockIndex: block.blockIndex,
            ranges: sourceRanges(block.segments, chunk.start, chunk.end),
          })
          // The output cap was reached inside this chunk; drop the tail.
          if (length < chunk.result.samples.length) break blocks
        }
        live.current = undefined
      }
      // A stream that ended after a stop or a takeover must not touch the
      // retired read's state even though it produced no further chunk.
      if (live.superseded) return
      live.streamDone = true
      if (live.openSources === 0) this.settle(live)
    } catch {
      if (live.superseded) return
      this.fail(live)
    } finally {
      live.consumeActive = false
    }
  }

  /**
   * Schedule one chunk's waveform behind the last scheduled source and
   * publish playing for the first one.
   * @param live - the read the chunk belongs to.
   * @param part - the synthesized chunk.
   * @param length - samples to schedule (`part` may be truncated by the cap).
   * @param highlight - the Markdown source ranges this chunk covers.
   */
  private schedule(
    live: LiveRead,
    part: SanoSynthesisResult,
    length: number,
    chunk: ScheduledChunk,
    highlight: ChatTextHighlight,
  ): void {
    const context = this.ensureRunning()
    // The first source of a read starts after a short silence pad: a freshly
    // started output pipeline can drop the first milliseconds of a buffer,
    // which would clip the opening word.
    const padSamples = live.sources.length === 0 ? Math.round(START_PAD_SECONDS * part.sampleRate) : 0
    const buffer = context.createBuffer(1, length + padSamples, part.sampleRate)
    buffer.copyToChannel(new Float32Array(part.samples.subarray(0, length)), 0, padSamples)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const startAt = Math.max(context.currentTime + START_LEAD_SECONDS, live.nextStartTime)
    live.nextStartTime = startAt + buffer.duration
    live.scheduledSeconds += buffer.duration
    live.openSources += 1
    const entry: ScheduledHighlight = {
      highlight,
      block: chunk.block,
      start: chunk.start,
      end: chunk.end,
      startAt,
      duration: buffer.duration,
      ended: false,
      next: undefined,
    }
    if (live.playing === undefined) live.playing = entry
    const previous = live.highlights.at(-1)
    if (previous === undefined) {
      // The first chunk starts now: its highlight goes up with the read, and
      // a deferred previous read hands the voice over at this same moment.
      this.publish(live, highlight)
      const takeover = live.takeover
      if (takeover !== undefined) {
        live.takeover = undefined
        this.retire(takeover)
      }
    } else {
      // Later chunks highlight when the chunk before them ends, so the mark
      // tracks the voice instead of the synthesizer's lead. A chunk landing
      // after a synthesis gap has no predecessor left to end.
      previous.next = entry
      if (previous.ended) this.publish(live, highlight)
    }
    live.highlights.push(entry)
    source.onended = () => { this.finishSource(live, entry) }
    live.sources.push(source)
    source.start(startAt)
  }

  /**
   * Publish the chunk now being spoken — the playback phase and the block's
   * Markdown source ranges that cover the chunk's span.
   * @param live - the read the chunk belongs to.
   * @param highlight - the scheduled chunk's source ranges.
   */
  private publish(live: LiveRead, highlight: ChatTextHighlight): void {
    live.phase = 'playing'
    live.lastHighlight = highlight
    live.store.set({
      messageId: live.messageId,
      phase: 'playing',
      highlight,
    })
  }

  /**
   * One scheduled chunk ended naturally: highlight the chunk scheduled after
   * it (their playback is gapless), and when the stream is done and it was
   * the last open source, settle the read back to idle.
   * @param live - the read the chunk belongs to.
   * @param entry - the ended chunk's schedule entry.
   */
  private finishSource(live: LiveRead, entry: ScheduledHighlight): void {
    if (live.superseded || live.paused) return
    entry.ended = true
    live.playedEnd = { block: entry.block, end: entry.end }
    live.playing = entry.next
    if (entry.next !== undefined) this.publish(live, entry.next.highlight)
    live.openSources -= 1
    if (live.streamDone && live.openSources === 0) this.settle(live)
  }

  /**
   * Publish the resting state for a naturally finished read.
   * @param live - the read that finished.
   */
  private settle(live: LiveRead): void {
    if (this.live === live) this.live = undefined
    live.store.set({ messageId: undefined, phase: 'idle', highlight: undefined })
  }

  /**
   * Publish failed for a read whose chunk rejected, stopping the audio that
   * was already scheduled.
   * @param live - the failed read.
   */
  private fail(live: LiveRead): void {
    this.live = undefined
    for (const source of live.sources) this.stopSource(source)
    live.store.set({ messageId: live.messageId, phase: 'failed', highlight: undefined })
  }

  /**
   * Stop one scheduled source, swallowing the rejection an already-ended
   * source raises.
   * @param source - the source to stop.
   */
  private stopSource(source: AudioBufferSourceNode): void {
    try {
      source.stop()
    } catch {
      // A source whose playback already ended rejects stop(); the live
      // read's bookkeeping is already done.
    }
  }

  /** The shared AudioContext, created on first use. */
  private context(): AudioContext {
    this.audio ??= new window.AudioContext()
    return this.audio
  }

  /**
   * The shared context with a running clock: a context the browser suspended
   * (an idle tab, a paused read) plays nothing until it is resumed, so every
   * play path kicks it back inside its own user gesture.
   * @returns the shared AudioContext.
   */
  private ensureRunning(): AudioContext {
    const context = this.context()
    if (context.state === 'suspended') void context.resume()
    return context
  }
}

/** Where a pause left the read: an unplayed remainder, a spent block, or nothing yet. */
type PausePoint =
  | { readonly kind: 'remainder'; readonly block: SpeakableBlock; readonly from: number }
  | { readonly kind: 'exhausted'; readonly block: SpeakableBlock }
  | { readonly kind: 'none' }

/** One chunk's span inside its block, as scheduling records it. */
interface ScheduledChunk {
  readonly block: SpeakableBlock
  readonly start: number
  readonly end: number
}

/**
 * The offset to resume speaking at, at or just after the given offset:
 * whitespace the cut landed in is skipped, and a cut inside a word replays
 * that word from its start unless the word runs long, in which case the
 * offset stands so the remainder never skips a whole long run.
 * @param text - the block's speakable text.
 * @param at - the offset playback reached.
 * @returns the offset the remainder starts at, at most the text length.
 */
function nextWordStart(text: string, at: number): number {
  let from = Math.min(at, text.length)
  while (from < text.length && /\s/.test(text.charAt(from))) from += 1
  if (from === 0 || from === text.length) return from
  if (/\s/.test(text.charAt(from - 1))) return from
  let space = from
  while (space < text.length && !/\s/.test(text.charAt(space))) space += 1
  if (space === text.length || space - from > MAX_RESUME_WORD_CHARS) return from
  while (space < text.length && /\s/.test(text.charAt(space))) space += 1
  return space
}

/**
 * Rebase one block onto its text from the given offset, clipping and shifting
 * its source segments the same way; a pause resumes with this remainder.
 * @param block - the block to slice.
 * @param from - the offset in the block's text the remainder starts at.
 * @returns a standalone speakable block for the remainder.
 */
function sliceSpeakable(block: SpeakableBlock, from: number): SpeakableBlock {
  const segments = []
  for (const segment of block.segments) {
    const start = Math.max(segment.start, from)
    if (segment.end <= start) continue
    segments.push({
      start: start - from,
      end: segment.end - from,
      sourceStart: segment.sourceStart + (start - segment.start),
      sourceEnd: segment.sourceEnd,
    })
  }
  return { blockIndex: block.blockIndex, text: block.text.slice(from), segments }
}

/**
 * Map one spoken-text span to the block's Markdown source ranges.
 * @param segments - the block's spoken-span → source mapping.
 * @param start - span start in the block's speakable text.
 * @param end - span end (exclusive) in the block's speakable text.
 * @returns the intersecting source ranges, in order; empty when nothing overlaps.
 */
function sourceRanges(
  segments: readonly MarkdownPlainTextSegment[],
  start: number,
  end: number,
): ChatTextHighlightRange[] {
  const ranges: ChatTextHighlightRange[] = []
  for (const segment of segments) {
    const from = Math.max(segment.start, start)
    const to = Math.min(segment.end, end)
    if (to <= from) continue
    ranges.push({
      start: segment.sourceStart + (from - segment.start),
      end: segment.sourceStart + (to - segment.start),
    })
  }
  return ranges
}
