/**
 * chunkSpeech boundaries: empty or whitespace-only input yields no chunks;
 * short utterances stay verbatim (trimmed); each line — heading, list item,
 * paragraph row — chunks on its own so structural boundaries stay chunk
 * boundaries; within a line, sentences pack greedily to the budget — the
 * terminal stays with its sentence, closing quotes and brackets ride along,
 * CJK and ellipsis terminals split without a trailing space, decimals stay
 * intact, consecutive terminals stay together — an over-budget sentence
 * splits at its clause punctuation (kept with the clause), and a clause that
 * still exceeds the budget splits at word boundaries; a single word longer
 * than the budget is hard-cut; every chunk is non-empty, at most the budget,
 * and carries the span it covers in the utterance.
 */
import { describe, expect, it } from 'vitest'
import { READALOUD_CHUNK_MAX_CHARS, chunkSpeech, endsSentence } from '../src/client/chunker.ts'

const repeated = (text: string, count: number): string => Array.from({ length: count }, () => text).join(' ')
const texts = (input: string, maxChars?: number): string[] =>
  chunkSpeech(input, maxChars).map(chunk => chunk.text)

describe('chunkSpeech', () => {
  it('returns no chunks for empty or whitespace-only input', () => {
    expect(chunkSpeech('')).toEqual([])
    expect(chunkSpeech(' \n\t ')).toEqual([])
  })

  it('keeps a short utterance as one verbatim chunk with its trimmed span', () => {
    expect(chunkSpeech('Hello world.')).toEqual([{ text: 'Hello world.', start: 0, end: 12 }])
    expect(chunkSpeech('  padded  ')).toEqual([{ text: 'padded', start: 2, end: 8 }])
  })

  it('keeps each line a chunk of its own, with the input span', () => {
    expect(chunkSpeech('line one\n\nline two')).toEqual([
      { text: 'line one', start: 0, end: 8 },
      { text: 'line two', start: 10, end: 18 },
    ])
  })

  it('keeps short bullets and headings as their own chunks', () => {
    expect(chunkSpeech('Heading\nItem one. Item one tail.\nItem two.')).toEqual([
      { text: 'Heading', start: 0, end: 7 },
      { text: 'Item one. Item one tail.', start: 8, end: 32 },
      { text: 'Item two.', start: 33, end: 42 },
    ])
  })

  it('splits a long line at sentence terminals, keeps the terminal with its sentence, and packs greedily', () => {
    const s1 = 'a'.repeat(54) + '.'
    const s2 = 'b'.repeat(54) + '.'
    const s3 = 'c'.repeat(54) + '.'
    const s4 = 'd'.repeat(54) + '.'
    const s5 = 'e'.repeat(54) + '.'

    const chunks = chunkSpeech([s1, s2, s3, s4, s5].join(' '))

    expect(chunks.map(chunk => chunk.text)).toEqual([`${s1} ${s2}`, `${s3} ${s4}`, s5])
    expect(chunks.every(chunk => chunk.text.length <= READALOUD_CHUNK_MAX_CHARS)).toBe(true)
    expect(chunks.every(chunk => chunk.text.endsWith('.'))).toBe(true)
    expect(chunks[0]).toMatchObject({ start: 0 })
    expect(chunks[1]!.end).toBeGreaterThan(chunks[1]!.start)
  })

  it('splits CJK clauses at their sentence-final marks without a trailing space', () => {
    const clause = '好'.repeat(20) + '。'

    const chunks = chunkSpeech(clause.repeat(8))

    expect(chunks.map(chunk => chunk.text)).toEqual([repeated(clause, 5), repeated(clause, 3)])
    expect(chunks.map(chunk => chunk.text.length)).toEqual([109, 65])
    expect(chunks.every(chunk => chunk.text.endsWith('。'))).toBe(true)
  })

  it('keeps a closing quote or bracket attached to the sentence it closes', () => {
    const clause = '他说：「你好。」'

    const chunks = chunkSpeech(clause.repeat(16))

    expect(chunks.map(chunk => chunk.text)).toEqual([repeated(clause, 13), repeated(clause, 3)])
    expect(chunks.map(chunk => chunk.text.length)).toEqual([116, 26])
    expect(chunks.every(chunk => chunk.text.endsWith('」'))).toBe(true)
  })

  it('does not split inside decimals, and keeps consecutive terminals together', () => {
    const pre = 'x'.repeat(80)
    const s1 = ' The value is 3.14 and 2.718.'
    const s2 = ' Next sentence ends.'

    const chunks = chunkSpeech(`${pre}${s1}${s2}`)

    expect(chunks.map(chunk => chunk.text)).toEqual([`${pre}${s1}`.trim(), s2.trim()])
    expect(chunks[0]!.text).toContain('3.14')
    expect(chunks[0]!.text).toContain('2.718.')

    const exclaimPre = 'y'.repeat(90)
    const exclaim = `${exclaimPre} Are you sure?! The answer is no.`
    expect(texts(exclaim)).toEqual([`${exclaimPre} Are you sure?!`, 'The answer is no.'])
  })

  it('splits a terminal-free sentence at word boundaries', () => {
    const text = 'ab '.repeat(100).trim()

    const chunks = chunkSpeech(text)

    expect(chunks.map(chunk => chunk.text.length)).toEqual([119, 119, 59])
    expect(chunks.every(chunk => chunk.text.length <= READALOUD_CHUNK_MAX_CHARS)).toBe(true)
    expect(chunks.map(chunk => chunk.text).join(' ')).toBe(text)
  })

  it('hard-cuts a single word longer than the budget and keeps its offsets', () => {
    expect(texts('x'.repeat(250))).toEqual(['x'.repeat(120), 'x'.repeat(120), 'x'.repeat(10)])
    expect(chunkSpeech('x'.repeat(250)).map(chunk => [chunk.start, chunk.end]))
      .toEqual([[0, 120], [120, 240], [240, 250]])
    expect(texts('x'.repeat(121))).toEqual(['x'.repeat(120), 'x'])

    const mixed = `xy ${'x'.repeat(250)}`
    expect(texts(mixed)).toEqual(['xy', 'x'.repeat(120), 'x'.repeat(120), 'x'.repeat(10)])
  })

  it('keeps a word exactly at the budget as its own chunk', () => {
    expect(texts(`${'x'.repeat(120)} y`)).toEqual(['x'.repeat(120), 'y'])
  })

  it('word-splits a long line without merging it into the line before', () => {
    const short = 'short fragment'
    const long = `${'x'.repeat(90)} ${'y'.repeat(40)}`

    const chunks = chunkSpeech(`${short}\n${long}`)

    expect(chunks.map(chunk => chunk.text)).toEqual([short, 'x'.repeat(90), 'y'.repeat(40)])
  })

  it('splits a long sentence at its clause punctuation, keeping it with the clause', () => {
    const first = 'a'.repeat(80)
    const second = 'b'.repeat(80)
    const chunks = chunkSpeech(`${first}, ${second}.`)

    expect(chunks.map(chunk => chunk.text)).toEqual([`${first},`, `${second}.`])
    expect(chunks.every(chunk => chunk.text.length <= READALOUD_CHUNK_MAX_CHARS)).toBe(true)
  })

  it('prefers clause breaks over word breaks and word-splits an over-budget clause', () => {
    const lead = 'Head clause'
    const long = 'c'.repeat(150)
    const tail = 'd'.repeat(20)
    const chunks = chunkSpeech(`${lead}, ${long}, ${tail}.`)

    expect(chunks.map(chunk => chunk.text)).toEqual([
      `${lead},`,
      'c'.repeat(READALOUD_CHUNK_MAX_CHARS),
      `${'c'.repeat(30)}, ${tail}.`,
    ])
    expect(chunks.every(chunk => chunk.text.length <= READALOUD_CHUNK_MAX_CHARS)).toBe(true)
  })

  it('keeps closing brackets and a trailing clause mark with their clause', () => {
    const quoted = `${'x'.repeat(130)}、」`
    expect(texts(quoted)).toEqual(['x'.repeat(120), `${'x'.repeat(10)}、」`])

    const mid = `${'x'.repeat(110)}、」 tail more words`
    expect(texts(mid)).toEqual([`${'x'.repeat(110)}、」`, 'tail more words'])
  })

  it('does not split at a comma between digits or inside a word', () => {
    const text = `${'x'.repeat(100)} then 1,000 more words here to pass the budget.`
    const chunks = chunkSpeech(text)

    expect(chunks.map(chunk => chunk.text).join(' ')).toBe(text)
    expect(chunks.every(chunk => chunk.text.length <= READALOUD_CHUNK_MAX_CHARS)).toBe(true)
    expect(chunks.some(chunk => chunk.text.includes('1,000'))).toBe(true)
  })

  it('recognizes sentence-final chunks across closing quotes and whitespace', () => {
    expect(endsSentence('A complete sentence.')).toBe(true)
    expect(endsSentence('A question?')).toBe(true)
    expect(endsSentence('「你好。」')).toBe(true)
    expect(endsSentence('A sentence.   ')).toBe(true)
    expect(endsSentence('A clause,')).toBe(false)
    expect(endsSentence('A list item:')).toBe(false)
    expect(endsSentence('Version 3.14')).toBe(false)
    expect(endsSentence('')).toBe(false)
  })

  it('drops a whitespace-only tail after a sentence terminal', () => {
    const sentence = 'x'.repeat(119) + '。   '
    expect(chunkSpeech(sentence)).toEqual([
      { text: 'x'.repeat(119) + '。', start: 0, end: 120 },
    ])
  })

  it('honors a custom budget', () => {
    expect(texts('ab cd ef', 3)).toEqual(['ab', 'cd', 'ef'])
    expect(texts('abcd', 3)).toEqual(['abc', 'd'])
    expect(READALOUD_CHUNK_MAX_CHARS).toBe(120)
  })
})
