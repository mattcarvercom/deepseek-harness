/**
 * Sentence-sized chunking for the vendored sanotts runtime. The nano voice's
 * 62-symbol trellis frontend rejects any utterance above 207 phoneme tokens
 * including BOS/EOS with a `TrellisFrontendError`, and measured text
 * phonemizes at roughly 1.1 tokens per character, so each chunk stays under
 * 120 characters to keep a wide margin inside the cap. Character count alone
 * cannot bound phonemes (path-like tokens and symbol runs expand), so the
 * engine splits and retries any chunk the runtime still rejects. The engine
 * synthesizes the chunks in order and concatenates the waveforms; the nano
 * runtime is seed-deterministic per chunk, so the combined audio is stable
 * for a given message. Every chunk carries the span it covers in the
 * utterance, which is what maps playback back to the spoken source.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/chunker
 */

/** Per-chunk character budget; a chunk at this size stays well under the 207-token cap. */
export const READALOUD_CHUNK_MAX_CHARS = 120

/** Terminals that always end a sentence: CJK sentence-final marks, and the ellipsis, which CJK prose writes without a trailing space. */
const STANDALONE_TERMINALS = new Set(['。', '！', '？', '…'])

/** Terminals that end a sentence only when not inside a number or word (`3.14`, `U.S.`). */
const SPACED_TERMINALS = new Set(['.', '!', '?'])

/** Closing quotes and brackets that stay attached to the sentence they close. */
const CLOSERS = new Set(['”', '’', ')', ']', '）', '］', '」', '』'])

/** Mid-sentence clause punctuation a long sentence may be split after. */
const CLAUSE_TERMINALS = new Set([',', ';', ':', '—', '–', '、', '，', '；', '：'])

/** Clause terminals that need whitespace (or the end) after them to count. */
const SPACED_CLAUSE_TERMINALS = new Set([',', ';', ':'])

/** One chunk of an utterance: its text and the span it covers in the input. */
export interface SpeechChunk {
  /** The chunk's text, safe for one runtime call. */
  readonly text: string
  /** Start offset of the chunk in the utterance, inclusive. */
  readonly start: number
  /** End offset of the chunk in the utterance, exclusive. */
  readonly end: number
}

/** A fragment of the utterance under construction, with its input offset. */
interface Fragment {
  readonly text: string
  readonly start: number
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch)
}

/**
 * Split an utterance into chunks of at most `maxChars` characters, each
 * carrying the span it covers in the utterance. Each line — a heading, a
 * list item, a paragraph row — is chunked on its own, so a structural
 * boundary always stays a chunk boundary and the voice pauses there.
 * Within a line, boundaries are chosen in preference order: sentence
 * terminals (kept with the sentence they end), clause punctuation (kept
 * with the clause it closes), word boundaries. A fragment that still
 * exceeds the budget — a run without terminals or a single long word — is
 * cut at the budget so every chunk is length-bounded; the engine retries a
 * chunk the runtime still rejects as over the token cap.
 * @param text - the utterance to split; surrounding whitespace is trimmed away.
 * @param maxChars - the per-chunk character budget; defaults to `READALOUD_CHUNK_MAX_CHARS`.
 * @returns the utterance in order, each chunk non-empty, at most `maxChars`
 * characters, and carrying its source span; no chunks for empty or
 * whitespace-only input.
 */
export function chunkSpeech(text: string, maxChars: number = READALOUD_CHUNK_MAX_CHARS): SpeechChunk[] {
  const chunks: SpeechChunk[] = []
  for (const fragments of lineFragments(text, maxChars)) {
    const pieces: Fragment[] = []
    for (const fragment of fragments) {
      if (fragment.text.length > maxChars) pieces.push(...breakLong(fragment, maxChars))
      else pieces.push(fragment)
    }
    pack(pieces, maxChars, chunks)
  }
  return chunks
}

/**
 * Pack fragments greedily into chunks of at most `maxChars` characters,
 * joining with a single space; a fragment that does not fit starts a chunk.
 * @param fragments - the fragments in order, each at most `maxChars`.
 * @param maxChars - the per-chunk character budget.
 * @param chunks - the output list the packed chunks are appended to.
 */
function pack(fragments: readonly Fragment[], maxChars: number, chunks: SpeechChunk[]): void {
  let current: SpeechChunk | undefined
  const push = (): void => {
    /* v8 ignore next -- pack is only called with fragment lists that produced a chunk. */
    if (current === undefined) return
    chunks.push(current)
    current = undefined
  }
  for (const fragment of fragments) {
    if (current !== undefined && current.text.length + 1 + fragment.text.length > maxChars) push()
    current = current === undefined
      ? { text: fragment.text, start: fragment.start, end: fragment.start + fragment.text.length }
      : {
        text: `${current.text} ${fragment.text}`,
        start: current.start,
        end: fragment.start + fragment.text.length,
      }
  }
  push()
}

/**
 * Break an utterance into per-line fragment groups with input offsets: one
 * fragment per line at or under the budget, and terminal-delimited sentences
 * for longer lines. Keeping the lines apart preserves the structural
 * boundaries the projection emitted (headings, list items, paragraphs).
 * @param text - the utterance.
 * @param maxChars - the per-fragment character budget.
 * @returns the fragment groups in order, each trimmed, empty lines dropped.
 */
function lineFragments(text: string, maxChars: number): Fragment[][] {
  const lines: Fragment[][] = []
  let lineStart = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') {
      const leading = line.length - line.trimStart().length
      const fragment: Fragment = { text: trimmed, start: lineStart + leading }
      lines.push(trimmed.length <= maxChars ? [fragment] : sentences(fragment))
    }
    lineStart += line.length + 1
  }
  return lines
}

/**
 * Break one over-budget fragment at its clause punctuation, so each piece
 * ends where the voice can pause naturally; a clause still over the budget
 * falls back to word boundaries.
 * @param fragment - a trimmed fragment longer than the budget.
 * @param maxChars - the per-piece character budget.
 * @returns the pieces in order, each non-empty and at most `maxChars` characters.
 */
function breakLong(fragment: Fragment, maxChars: number): Fragment[] {
  const clauses = clauseFragments(fragment)
  if (clauses.length <= 1) return splitWords(fragment, maxChars)
  const pieces: Fragment[] = []
  for (const clause of clauses) {
    if (clause.text.length > maxChars) pieces.push(...splitWords(clause, maxChars))
    else pieces.push(clause)
  }
  return pieces
}

/**
 * Split one fragment at clause punctuation. Clause terminals are kept with
 * the clause they close; `,` `;` and `:` count only when whitespace (or the
 * end) follows, so decimals like `3.14` and clock-like runs like `12:30`
 * stay intact, while CJK clause marks and dashes count wherever they stand.
 * @param fragment - a trimmed fragment longer than the budget.
 * @returns the clauses in order, each trimmed, each carrying its punctuation.
 */
function clauseFragments(fragment: Fragment): Fragment[] {
  const text = fragment.text
  const out: Fragment[] = []
  let start = 0
  let index = 0
  const push = (from: number, to: number): void => {
    const raw = text.slice(from, to)
    const trimmed = raw.trim()
    /* v8 ignore next -- trimmed fragments cannot yield an empty clause slice. */
    if (trimmed === '') return
    out.push({ text: trimmed, start: fragment.start + from + (raw.length - raw.trimStart().length) })
  }
  while (index < text.length) {
    const ch = text.charAt(index)
    if (!CLAUSE_TERMINALS.has(ch)) {
      index += 1
      continue
    }
    let end = index + 1
    while (CLOSERS.has(text.charAt(end))) end += 1
    if (SPACED_CLAUSE_TERMINALS.has(ch) && end !== text.length && !isSpace(text.charAt(end))) {
      index += 1
      continue
    }
    push(start, end)
    index = end
    start = end
  }
  if (start < text.length) push(start, text.length)
  return out
}

/**
 * Whether a chunk ends a sentence: after trailing whitespace and any closing
 * quotes or brackets, a sentence terminal stands last.
 * @param text - the chunk's text.
 * @returns true when the text closes a sentence.
 */
export function endsSentence(text: string): boolean {
  let end = text.length
  while (end > 0 && isSpace(text.charAt(end - 1))) end -= 1
  while (end > 0 && CLOSERS.has(text.charAt(end - 1))) end -= 1
  if (end === 0) return false
  const ch = text.charAt(end - 1)
  return STANDALONE_TERMINALS.has(ch) || SPACED_TERMINALS.has(ch)
}

/**
 * Split a long line at sentence terminals. Standalone terminals (CJK
 * sentence-final marks, the ellipsis) always end the sentence; `.` `!` and
 * `?` do so only when the next character is whitespace or line end, so
 * decimals like `3.14` stay intact. Closing quotes and brackets ride along
 * with the sentence they close, as do consecutive terminals such as `?!`.
 * @param fragment - a trimmed line longer than the chunk budget.
 * @returns the sentences in order, each trimmed, each carrying its terminal and any closing quotes.
 */
function sentences(fragment: Fragment): Fragment[] {
  const line = fragment.text
  const out: Fragment[] = []
  let start = 0
  let i = 0
  const push = (from: number, to: number): void => {
    const raw = line.slice(from, to)
    const text = raw.trim()
    /* v8 ignore next -- trimmed fragments cannot yield an empty sentence slice. */
    if (text === '') return
    out.push({ text, start: fragment.start + from + (raw.length - raw.trimStart().length) })
  }
  while (i < line.length) {
    const ch = line.charAt(i)
    if (!isTerminal(ch)) {
      i += 1
      continue
    }
    // Extend across consecutive terminals and the closing quotes/brackets
    // they close, e.g. `?!”` or `。」`.
    let j = i
    let standalone = STANDALONE_TERMINALS.has(ch)
    for (;;) {
      const cj = line.charAt(j)
      if (isTerminal(cj)) {
        if (STANDALONE_TERMINALS.has(cj)) standalone = true
        j += 1
        continue
      }
      if (CLOSERS.has(cj)) {
        j += 1
        continue
      }
      break
    }
    if (standalone || j === line.length || isSpace(line.charAt(j))) {
      push(start, j)
      i = j
      start = j
      continue
    }
    i += 1
  }
  if (start < line.length) push(start, line.length)
  return out
}

/**
 * Split a terminal-free fragment at word boundaries so each piece fits the
 * budget; a single word longer than the budget is hard-cut into budget-sized
 * slices as a last resort.
 * @param fragment - a trimmed fragment longer than the budget.
 * @param maxChars - the per-piece character budget.
 * @returns the pieces in order, each non-empty and at most `maxChars` characters.
 */
function splitWords(fragment: Fragment, maxChars: number): Fragment[] {
  const words: Fragment[] = []
  let index = 0
  while (index < fragment.text.length) {
    while (index < fragment.text.length && isSpace(fragment.text.charAt(index))) index += 1
    /* v8 ignore next -- fragments are trimmed before word splitting. */
    if (index >= fragment.text.length) break
    const wordStart = index
    while (index < fragment.text.length && !isSpace(fragment.text.charAt(index))) index += 1
    words.push({ text: fragment.text.slice(wordStart, index), start: fragment.start + wordStart })
  }
  const pieces: Fragment[] = []
  let current: SpeechChunk | undefined
  const push = (): void => {
    if (current === undefined) return
    pieces.push({ text: current.text, start: current.start })
    current = undefined
  }
  for (const word of words) {
    if (word.text.length > maxChars) {
      push()
      for (let k = 0; k < word.text.length; k += maxChars) {
        pieces.push({ text: word.text.slice(k, k + maxChars), start: word.start + k })
      }
      continue
    }
    if (current !== undefined && current.text.length + 1 + word.text.length > maxChars) push()
    current = current === undefined
      ? { text: word.text, start: word.start, end: word.start + word.text.length }
      : {
        text: `${current.text} ${word.text}`,
        start: current.start,
        end: word.start + word.text.length,
      }
  }
  push()
  return pieces
}

function isTerminal(ch: string): boolean {
  return STANDALONE_TERMINALS.has(ch) || SPACED_TERMINALS.has(ch)
}
