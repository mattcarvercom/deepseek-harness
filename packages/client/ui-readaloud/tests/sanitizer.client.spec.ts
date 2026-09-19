import { describe, expect, it } from 'vitest'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'

import { speakableBlocks, stripFencedCode } from '../src/client/sanitizer.ts'

const text = (content: string): AssistantBlock => ({ kind: 'text', text: content })

/** The spoken texts of a message's blocks, in order. */
const spoken = (blocks: readonly AssistantBlock[]): string[] =>
  speakableBlocks(blocks).map(block => block.text)

describe('stripFencedCode', () => {
  it('drops triple-backtick fences and keeps the surrounding lines', () => {
    expect(stripFencedCode('before\n```\ncode\n```\nafter').text).toBe('before\nafter')
  })

  it('maps every kept character back to its source offset', () => {
    const stripped = stripFencedCode('before\n```\ncode\n```\nafter')
    expect(stripped.sourceOffsets).toHaveLength(stripped.text.length)
    expect(stripped.text).toBe('before\nafter')
    // 'before' is verbatim at the start; 'after' starts at its source offset.
    expect(stripped.sourceOffsets.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5])
    expect(stripped.sourceOffsets[7]).toBe(20)
  })

  it('keeps the blank lines around a fence (the GFM projection collapses them later)', () => {
    expect(stripFencedCode('before\n\n```\ncode\n```\n\nafter').text).toBe('before\n\n\nafter')
  })

  it('drops tilde fences the same way', () => {
    expect(stripFencedCode('a\n~~~\n~b~\n~~~\nb').text).toBe('a\nb')
  })

  it('keeps a shorter fence line inside a longer fence', () => {
    expect(stripFencedCode('````\n```\ninner```\n````\nend').text).toBe('end')
  })

  it('does not close a fence on a line of a different character', () => {
    expect(stripFencedCode('```\n``~\n```').text).toBe('')
  })

  it('allows up to three leading spaces on a fence line', () => {
    expect(stripFencedCode('   ```\ncode\n   ```\nkeep').text).toBe('keep')
  })

  it('leaves a four-space-indented fence alone (a GFM indented code block is not a fence)', () => {
    const source = '    ```\n    code\n    ```'
    expect(stripFencedCode(source).text).toBe(source)
  })

  it('drops everything from a trailing unclosed fence to the end', () => {
    expect(stripFencedCode('intro\n```\nstill generating').text).toBe('intro')
  })

  it('returns text without fences unchanged', () => {
    const source = 'plain\n\n*emphasis* and **strong**'
    expect(stripFencedCode(source).text).toBe(source)
  })
})

describe('speakableBlocks', () => {
  it('keeps one entry per text block', () => {
    expect(spoken([text('one'), text('two')])).toEqual(['one', 'two'])
  })

  it('returns nothing when the only text is a fenced block', () => {
    expect(spoken([text('```\ncode\n```')])).toEqual([])
  })

  it('returns nothing for whitespace-only text', () => {
    expect(spoken([text('   '), text('')])).toEqual([])
  })

  it('reads links as their labels and images as alt text', () => {
    expect(spoken([text('[docs](https://example.com) and ![a chart](chart.png)')]))
      .toEqual(['docs and a chart'])
  })

  it('keeps inline code as its source text', () => {
    expect(spoken([text('use `pkg install` now')])).toEqual(['use pkg install now'])
  })

  it('compacts a heading to its text', () => {
    expect(spoken([text('# Title')])).toEqual(['Title'])
  })

  it('reads list items one per line', () => {
    expect(spoken([text('- one\n- two')])).toEqual(['one\ntwo'])
  })

  it('reads table cells tab-separated on line rows', () => {
    expect(spoken([text('| a | b |\n| - | - |\n| c | d |')])).toEqual(['a\tb\nc\td'])
  })

  it('keeps raw HTML literal', () => {
    expect(spoken([text('hi <em>there</em>')])).toEqual(['hi <em>there</em>'])
  })

  it('removes a fenced block from the middle of the text and maps the kept spans', () => {
    const source = 'before\n\n```\ncode\n```\n\nafter'
    const [block] = speakableBlocks([text(source)])

    expect(block!.text).toBe('before\n\nafter')
    expect(block!.segments.map(segment => [segment.sourceStart, segment.sourceEnd]))
      .toEqual([[0, 6], [source.indexOf('after'), source.indexOf('after') + 5]])
  })

  it('reports the block index of a later text block', () => {
    const [block] = speakableBlocks([
      { kind: 'reasoning', text: 'thinking out loud' },
      text('answer'),
    ])

    expect(block!.blockIndex).toBe(1)
    expect(block!.text).toBe('answer')
  })

  it('ignores reasoning, tool calls, image attachments, and other blocks', () => {
    const blocks: readonly AssistantBlock[] = [
      { kind: 'reasoning', text: 'thinking out loud' },
      text('answer'),
      { kind: 'tool-call', callId: 'call-1', name: 'bash', argsRaw: '{"command":"ls"}' },
      { kind: 'image', attachment: 'chart.png' as never },
      { kind: 'other', block: { type: 'custom' } },
    ]
    expect(spoken(blocks)).toEqual(['answer'])
  })

  it('speaks a GFM indented code block as trimmed source text (documented pass-through)', () => {
    expect(spoken([text('    indented code')])).toEqual(['indented code'])
  })
})
