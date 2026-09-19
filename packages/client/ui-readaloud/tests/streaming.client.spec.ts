/**
 * Incremental narration collection: only complete sentences are emitted while
 * a step generates, an over-budget sentence is cut at its last clause break
 * (or at a word boundary at the pending cap when it has none), short runs wait
 * for a natural break, settling flushes the remainder, per-block offsets are
 * remembered so nothing is emitted twice, and a rewritten projection or a
 * shrunken text reports divergence.
 */
import { describe, expect, it } from 'vitest'
import type { SpeakableBlock } from '../src/client/sanitizer.ts'
import {
  STREAM_MIN_CLAUSE_CHARS, STREAM_PENDING_MAX_CHARS, collectStreamUtterances,
} from '../src/client/streaming.ts'

function block(text: string, blockIndex = 0): SpeakableBlock {
  return {
    blockIndex,
    text,
    segments: [{ start: 0, end: text.length, sourceStart: 0, sourceEnd: text.length }],
  }
}

/** Collect repeatedly over a growing text, returning every emitted utterance. */
function streamed(blocks: readonly SpeakableBlock[], flush = false) {
  const first = collectStreamUtterances(undefined, blocks, flush)
  return first
}

describe('collectStreamUtterances', () => {
  it('emits only complete sentences while the text grows', () => {
    const partial = streamed([block('The first sentence is here. The second is not yet')])
    expect(partial.utterances.map(utterance => utterance.text)).toEqual(['The first sentence is here.'])
    expect(partial.diverged).toBe(false)

    const grown = collectStreamUtterances(partial.state, [block('The first sentence is here. The second is not yet')], false)
    expect(grown.utterances).toEqual([])

    const completed = collectStreamUtterances(grown.state, [
      block('The first sentence is here. The second is not yet complete. Third'),
    ], false)
    expect(completed.utterances.map(utterance => utterance.text)).toEqual(['The second is not yet complete.'])
  })

  it('flushes the remaining partial sentence when the step settles', () => {
    const partial = streamed([block('One sentence. A trailing fragment')])
    const flushed = collectStreamUtterances(partial.state, [block('One sentence. A trailing fragment')], true)
    expect(flushed.utterances.map(utterance => utterance.text)).toEqual(['A trailing fragment'])

    const again = collectStreamUtterances(flushed.state, [block('One sentence. A trailing fragment')], true)
    expect(again.utterances).toEqual([])
  })

  it('keeps decimals intact and rides closing quotes with their sentence', () => {
    const decimals = streamed([block('Pi is 3.14 and that is that. Next')])
    expect(decimals.utterances.map(utterance => utterance.text)).toEqual(['Pi is 3.14 and that is that.'])

    const quoted = streamed([block('He said 「你好。」 Then')])
    expect(quoted.utterances.map(utterance => utterance.text)).toEqual(['He said 「你好。」'])
  })

  it('cuts a long first sentence at the budget instead of waiting for its terminal', () => {
    const prefix = 'word '.repeat(30).trim()
    const text = `${prefix}. tail`
    const result = streamed([block(text)])

    expect(result.utterances).toHaveLength(1)
    const [utterance] = result.utterances
    expect(utterance!.text.length).toBeLessThanOrEqual(STREAM_PENDING_MAX_CHARS)
    expect(utterance!.text.endsWith('word')).toBe(true)
    expect(utterance!.text).not.toContain('.')

    // The sentence end then fits the budget and arrives with the next pass.
    const rest = collectStreamUtterances(result.state, [block(text)], false)
    expect(rest.utterances.map(item => item.text)).toHaveLength(1)
    expect(rest.utterances[0]!.text.endsWith('.')).toBe(true)
  })

  it('starts emitting inside a long colon-led sentence from real model output', () => {
    const text = 'In practice this means I can handle things like: migrating a codebase, '
      + 'building a feature end-to-end, auditing a repo across many files, researching a topic. More.'
    const result = streamed([block(text)])

    expect(result.utterances.length).toBeGreaterThan(0)
    expect(result.utterances[0]!.text.length).toBeLessThanOrEqual(STREAM_PENDING_MAX_CHARS)
  })

  it('cuts a terminal-free run at a word boundary at the pending cap', () => {
    const text = 'word '.repeat(STREAM_PENDING_MAX_CHARS / 5)
    const result = streamed([block(text)])
    expect(result.utterances).toHaveLength(1)
    const [utterance] = result.utterances
    expect(utterance!.text.length).toBeLessThanOrEqual(STREAM_PENDING_MAX_CHARS)
    expect(text.startsWith(utterance!.text)).toBe(true)
    expect(utterance!.text.endsWith('word')).toBe(true)
  })

  it('hard-cuts a single unbroken run at the cap', () => {
    const text = 'x'.repeat(STREAM_PENDING_MAX_CHARS + 50)
    const result = streamed([block(text)])
    expect(result.utterances.map(utterance => utterance.text)).toEqual(['x'.repeat(STREAM_PENDING_MAX_CHARS)])
  })

  it('tracks each block independently', () => {
    const blocks = [block('First block done. Tail', 0), block('Second block done. More', 1)]
    const result = streamed(blocks)
    expect(result.utterances.map(utterance => [utterance.block.blockIndex, utterance.text])).toEqual([
      [0, 'First block done.'],
      [1, 'Second block done.'],
    ])
  })

  it('reports each utterance span inside the block text', () => {
    const result = streamed([block('Alpha done. Beta tail')])

    expect(result.utterances).toHaveLength(1)
    const [utterance] = result.utterances
    expect(utterance!.block.blockIndex).toBe(0)
    expect([utterance!.text, utterance!.start, utterance!.end]).toEqual(['Alpha done.', 0, 11])
  })

  it('emits nothing for a whitespace-only run while advancing past it', () => {
    const text = ' '.repeat(STREAM_PENDING_MAX_CHARS + 20)
    const result = streamed([block(text)])
    expect(result.utterances).toEqual([])

    const flushed = collectStreamUtterances(result.state, [block(text)], true)
    expect(flushed.utterances).toEqual([])
  })

  it('does not end a sentence at a period followed by a word character', () => {
    const result = streamed([block('Version 2.Release notes follow here')])
    expect(result.utterances).toEqual([])
  })

  it('keeps streaming when a markdown delimiter closes in the pending text', () => {
    const unclosed = 'Here is what I can do: pick a task. Work on **Code'
    const first = streamed([block(unclosed)])
    expect(first.diverged).toBe(false)
    expect(first.utterances.map(utterance => utterance.text)).toEqual(['Here is what I can do: pick a task.'])

    // The closing ** erases the literal asterisks from the projection.
    const closed = 'Here is what I can do: pick a task. Work on **Code & files** and more.'
    const second = collectStreamUtterances(first.state, [block(closed)], false)
    expect(second.diverged).toBe(false)
    expect(second.utterances.map(utterance => utterance.text).join(' '))
      .toContain('Code & files')
  })

  it('never emits past an unclosed delimiter', () => {
    const text = 'A full sentence here. Start of **bold that never closes yet'
    const result = streamed([block(text)])

    expect(result.utterances.map(utterance => utterance.text)).toEqual(['A full sentence here.'])
  })

  it('waits for the minimum run when a delimiter pins the stable region', () => {
    // Projected text while the delimiter is open, then after it closes.
    const first = streamed([block('short run **bold')])
    expect(first.utterances).toEqual([])

    const second = collectStreamUtterances(
      first.state,
      [block('short run bold rest of the sentence.')],
      false,
    )
    expect(second.utterances.map(utterance => utterance.text)).toEqual(['short run bold rest of the sentence.'])
  })

  it('treats an unclosed image alt as unstable too', () => {
    const text = 'Look here. Then ![a chart'
    const result = streamed([block(text)])
    expect(result.utterances.map(utterance => utterance.text)).toEqual(['Look here.'])
  })

  it('waits below the budget for a sentence or clause break', () => {
    const result = streamed([block('word '.repeat(15).trim())])

    expect(result.utterances).toEqual([])
  })

  it('cuts an over-budget sentence at its last clause break', () => {
    const text = `${'x'.repeat(50)}, ${'y'.repeat(100)}`
    const result = streamed([block(text)])

    expect(result.utterances).toHaveLength(1)
    expect(result.utterances[0]!.text).toBe(`${'x'.repeat(50)},`)
  })

  it('prefers the last clause break that fits the budget', () => {
    const text = `${'x'.repeat(50)}, ${'y'.repeat(30)}, ${'z'.repeat(60)}`
    const result = streamed([block(text)])

    expect(result.utterances).toHaveLength(1)
    expect(result.utterances[0]!.text).toBe(`${'x'.repeat(50)}, ${'y'.repeat(30)},`)
  })

  it('keeps closing brackets with the clause break it cuts at', () => {
    const text = `${'x'.repeat(50)}、」${'y'.repeat(60)}`
    const result = streamed([block(text)])

    expect(result.utterances[0]!.text).toBe(`${'x'.repeat(50)}、」`)
  })

  it('skips a clause break below the minimum and one between digits', () => {
    const early = `${'y'.repeat(STREAM_MIN_CLAUSE_CHARS - 2)}, ${'z'.repeat(60)}`
    expect(streamed([block(early)]).utterances).toEqual([])

    const clock = 'The meeting is at 12:30 and we keep talking a while longer'
    expect(streamed([block(clock)]).utterances).toEqual([])
  })

  it('cuts at a dash that stands without surrounding spaces', () => {
    const text = `${'x'.repeat(50)}—${'y'.repeat(80)}`
    const result = streamed([block(text)])

    expect(result.utterances[0]!.text).toBe(`${'x'.repeat(50)}—`)
  })

  it('waits when a long unbroken run has no boundary at all', () => {
    const result = streamed([block('x'.repeat(80))])

    expect(result.utterances).toEqual([])
  })

  it('tracks link brackets when deciding stability', () => {
    const closed = streamed([block('Read [the docs] then continue.')])
    expect(closed.utterances.map(utterance => utterance.text)).toEqual(['Read [the docs] then continue.'])

    const leading = streamed([block('[unfinished link label')])
    expect(leading.utterances).toEqual([])
  })

  it('reports divergence when the projection is rewritten', () => {
    const first = streamed([block('A sentence that was. Then more')])
    const rewritten = collectStreamUtterances(first.state, [block('Completely different text.')], false)

    expect(rewritten.diverged).toBe(true)
    expect(rewritten.utterances).toEqual([])
    expect(rewritten.state.emitted.size).toBe(0)
  })

  it('reports divergence when the text shrank below the emitted offset', () => {
    const first = streamed([block('A sentence that was. Then more')])
    const shrunken = collectStreamUtterances(first.state, [block('A sentence')], false)

    expect(shrunken.diverged).toBe(true)
    expect(shrunken.utterances).toEqual([])
  })
})
