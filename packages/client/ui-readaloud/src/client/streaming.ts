/**
 * Incremental narration of a generating Assistant step. The running step's
 * blocks are re-projected on every update; this module emits each complete
 * sentence exactly once, cuts a run at a word boundary whenever the pending
 * text reaches the budget without an early sentence end, and flushes the
 * remainder when the step settles. Markdown delimiters reshape the
 * projection when they close (literal `**` becomes bold), so cuts stop
 * before any unclosed `**`, backtick, or link bracket, and only the text
 * already spoken must stay stable: a projection change behind the emitted
 * offset is a rewrite and reports divergence for the caller to abandon.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/streaming
 */

import type { SpeakableBlock } from './sanitizer.ts'

/**
 * Longest text held before emitting. A sentence end within this budget emits
 * immediately; otherwise the run is cut at a word boundary here, so a single
 * long sentence cannot delay the first audio until it finally ends.
 */
export const STREAM_PENDING_MAX_CHARS = 120

/**
 * Shortest piece a clause break may emit: a sentence that opens with a short
 * clause (``As always, ...``) should not chop into a sub-second fragment, so
 * a clause cut waits until the run before it stands on its own.
 */
export const STREAM_MIN_CLAUSE_CHARS = 40

/** Terminals that always end a sentence: CJK sentence-final marks, and the ellipsis. */
const STANDALONE_TERMINALS = new Set(['。', '！', '？', '…'])

/** Terminals that end a sentence when not inside a number or word. */
const SPACED_TERMINALS = new Set(['.', '!', '?'])

/** Closing quotes and brackets that stay attached to the sentence they close. */
const CLOSERS = new Set(['”', '’', ')', ']', '）', '］', '」', '』'])

/** Mid-sentence clause punctuation a long sentence may be cut after. */
const CLAUSE_TERMINALS = new Set([',', ';', ':', '—', '–', '、', '，', '；', '：'])

/** Clause terminals that need whitespace (or the end) after them to count. */
const SPACED_CLAUSE_TERMINALS = new Set([',', ';', ':'])

/** One complete (or capped) utterance to hand to the director. */
export interface StreamUtterance {
  /** The running step block the text came from. */
  readonly block: SpeakableBlock
  /** The utterance text, trimmed. */
  readonly text: string
  /** Start offset of the utterance in the block's speakable text. */
  readonly start: number
  /** End offset (exclusive) of the utterance in the block's speakable text. */
  readonly end: number
}

/** Per-block narration progress: how much projected text was already emitted. */
export interface StreamNarrationState {
  /** Projected-text length already emitted, by block index. */
  readonly emitted: ReadonlyMap<number, number>
  /** The projected text those offsets refer to, by block index. */
  readonly projected: ReadonlyMap<number, string>
}

/** One collection pass's outcome. */
export interface StreamNarrationResult {
  /** Progress to pass into the next pass. */
  readonly state: StreamNarrationState
  /** Utterances to append, in order. */
  readonly utterances: readonly StreamUtterance[]
  /** The projected text no longer extends the previous prefixes; abandon the stream. */
  readonly diverged: boolean
}

/** A fresh state with nothing emitted. */
export function initialStreamNarrationState(): StreamNarrationState {
  return { emitted: new Map(), projected: new Map() }
}

/**
 * Collect the utterances that became complete since the previous pass.
 * @param state - the previous pass's progress; absent starts fresh.
 * @param blocks - the running step's speakable blocks, re-projected.
 * @param flush - the step settled: emit every remaining character, not only complete sentences.
 * @returns the next state, the utterances in order, and whether the text diverged.
 */
export function collectStreamUtterances(
  state: StreamNarrationState | undefined,
  blocks: readonly SpeakableBlock[],
  flush: boolean,
): StreamNarrationResult {
  const emitted = new Map<number, number>()
  const projected = new Map<number, string>()
  const utterances: StreamUtterance[] = []
  for (const block of blocks) {
    const previous = state?.projected.get(block.blockIndex)
    const emittedAt = state?.emitted.get(block.blockIndex) ?? 0
    // Only the spoken prefix must survive: markdown that closes later in the
    // pending text may reshape it (literal asterisks becoming bold), but a
    // changed spoken prefix is a rewrite the stream cannot continue from.
    const spoken = previous === undefined ? '' : previous.slice(0, emittedAt)
    if (block.text.length < emittedAt || !block.text.startsWith(spoken)) {
      return { state: initialStreamNarrationState(), utterances: [], diverged: true }
    }
    projected.set(block.blockIndex, block.text)
    const pending = block.text.slice(emittedAt)
    const cut = flush ? pending.length : nextCut(pending)
    if (cut <= 0) {
      emitted.set(block.blockIndex, emittedAt)
      continue
    }
    const raw = pending.slice(0, cut)
    const leading = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text !== '') {
      utterances.push({
        block,
        text,
        start: emittedAt + leading,
        end: emittedAt + leading + text.length,
      })
    }
    emitted.set(block.blockIndex, emittedAt + cut)
  }
  return { state: { emitted, projected }, utterances, diverged: false }
}

/**
 * How much of the pending text is safe to emit: through the last complete
 * sentence when one lands inside the budget; otherwise, inside a still-open
 * sentence, through its last clause break once the run before it stands on
 * its own; otherwise through the last word boundary once the pending run
 * reaches the budget; otherwise nothing. Cuts never cross an unclosed inline
 * delimiter, because the projection reshapes that text when the delimiter
 * closes.
 * @param pending - the projected text after the last emitted offset.
 * @returns the emit length, 0 while only a short incomplete sentence is pending.
 */
function nextCut(pending: string): number {
  const safe = stableLength(pending)
  if (safe <= 0) return 0
  const stable = pending.slice(0, safe)
  // A completed sentence emits as soon as it exists, however short; the
  // minimums only guard cuts inside a still-incomplete sentence.
  const sentence = lastSentenceEnd(stable)
  if (sentence > 0 && sentence <= STREAM_PENDING_MAX_CHARS) return sentence
  // A long sentence is cut where the voice can pause: after its last clause
  // punctuation, rather than at whatever word fills the budget.
  const clause = lastClauseEnd(stable)
  if (clause >= STREAM_MIN_CLAUSE_CHARS && clause <= STREAM_PENDING_MAX_CHARS) return clause
  // No natural break yet: wait for a clause, a sentence end, or the budget.
  if (safe < STREAM_PENDING_MAX_CHARS) return 0
  const boundary = pending.lastIndexOf(' ', STREAM_PENDING_MAX_CHARS)
  return boundary > 0 ? boundary : STREAM_PENDING_MAX_CHARS
}

/**
 * The end offset of the last clause break in the text: clause punctuation,
 * optionally followed by closing quotes or brackets. `,` `;` and `:` count
 * only when whitespace or the end follows, so `12:30` and `1,000` stay
 * inside one piece; CJK clause marks and dashes count wherever they stand.
 * @param text - the pending projected text.
 * @returns the offset after the last clause break, or 0.
 */
function lastClauseEnd(text: string): number {
  let last = 0
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index)
    if (!CLAUSE_TERMINALS.has(ch)) continue
    let end = index + 1
    while (CLOSERS.has(text.charAt(end))) end += 1
    if (SPACED_CLAUSE_TERMINALS.has(ch) && end !== text.length && !/\s/.test(text.charAt(end))) continue
    last = end
  }
  return last
}

/**
 * How much of the pending text is stable: everything before the last
 * unmatched `**`, backtick pair, or link bracket. Those characters are
 * projected literally until their construct closes, so emitting them would
 * bake text the projection later rewrites.
 * @param text - the pending projected text.
 * @returns the offset the stable prefix ends at.
 */
function stableLength(text: string): number {
  let stable = text.length
  for (const marker of ['**', '`']) {
    const unmatched = lastUnmatchedPair(text, marker)
    if (unmatched !== -1 && unmatched < stable) stable = unmatched
  }
  const bracket = lastUnclosedBracket(text)
  if (bracket !== -1 && bracket < stable) stable = bracket
  return stable
}

/**
 * The position of the last unmatched occurrence of a paired marker.
 * @param text - the scanned text.
 * @param marker - the marker whose occurrences pair up.
 * @returns the last unmatched marker's offset, or -1 when all pairs close.
 */
function lastUnmatchedPair(text: string, marker: string): number {
  let open = -1
  let index = 0
  for (;;) {
    const found = text.indexOf(marker, index)
    if (found === -1) return open
    open = open === -1 ? found : -1
    index = found + marker.length
  }
}

/**
 * The position of the last link bracket still awaiting its closing bracket.
 * @param text - the scanned text.
 * @returns the unmatched `[` offset, or -1 when every bracket closes.
 */
function lastUnclosedBracket(text: string): number {
  let open = -1
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index)
    if (ch === '[') open = index === 0 || text.charAt(index - 1) !== '!' ? index : index - 1
    else if (ch === ']') open = -1
  }
  return open
}

/**
 * The end offset of the last complete sentence in the text: a terminal
 * followed (after any closing quotes or brackets) by whitespace or the end.
 * A period between digits (`3.14`) never ends a sentence.
 * @param text - the pending projected text.
 * @returns the offset after the last complete sentence, or 0.
 */
function lastSentenceEnd(text: string): number {
  let last = 0
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index)
    if (!STANDALONE_TERMINALS.has(ch) && !SPACED_TERMINALS.has(ch)) continue
    if (ch === '.' && isDigit(text.charAt(index - 1)) && isDigit(text.charAt(index + 1))) continue
    let end = index + 1
    while (CLOSERS.has(text.charAt(end))) end += 1
    const next = text.charAt(end)
    if (next === '' || /\s/.test(next)) last = end
  }
  return last
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}
