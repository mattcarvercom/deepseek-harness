import { describe, expect, it } from 'vitest'
import {
  extractMarkdownPlainText, extractMarkdownPlainTextSegments,
  type MarkdownPlainTextProjection,
} from '@deepseek-ai/dsh-client-ui-primitives'

const MARKDOWN = [
  '# Release notes',
  '',
  'First **paragraph** with [a link](https://example.com) and ![diagram](diagram.png).',
  '',
  '- shipped',
  '- `verified`',
  '',
  '```ts',
  'const ready = true',
  '```',
].join('\n')

describe('extractMarkdownPlainText', () => {
  it('projects the complete GFM document without presentation syntax', () => {
    expect(extractMarkdownPlainText(MARKDOWN)).toBe([
      'Release notes',
      '',
      'First paragraph with a link and diagram.',
      '',
      'shipped',
      'verified',
      '',
      'const ready = true',
    ].join('\n'))
  })

  it('selects the first visible line or first semantic paragraph', () => {
    expect(extractMarkdownPlainText(MARKDOWN, { mode: 'first-line' })).toBe('Release notes')
    expect(extractMarkdownPlainText(MARKDOWN, { mode: 'first-paragraph' }))
      .toBe('First paragraph with a link and diagram.')
  })

  it('preserves raw HTML while removing Markdown presentation markup', () => {
    const block = [
      '<background-job-complete id="trajectory-ui-watch">',
      'Command: pnpm test',
      'Exit code: 0',
      '</background-job-complete>',
    ].join('\n')
    expect(extractMarkdownPlainText(block)).toBe(block)
    expect(extractMarkdownPlainText('**Status:** <span data-state="ok">ready</span>'))
      .toBe('Status: <span data-state="ok">ready</span>')
    expect(extractMarkdownPlainText(block, { mode: 'first-paragraph' }))
      .toBe('<background-job-complete id="trajectory-ui-watch">')
  })

  it('projects GFM tables, references, hard breaks, and block structure', () => {
    const markdown = [
      '> first\\',
      '> second with ![diagram][asset] and <span>visible</span>',
      '',
      '---',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| alpha | `1` |',
      '',
      '[asset]: diagram.png',
    ].join('\n')
    expect(extractMarkdownPlainText(markdown)).toBe([
      'first second with diagram and <span>visible</span>',
      '',
      'Name\tValue',
      'alpha\t1',
    ].join('\n'))
  })
})

/** Source slices covering the projected range of the first occurrence of `needle`. */
function sourceAround(projection: MarkdownPlainTextProjection, needle: string): string {
  const start = projection.text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = start + needle.length
  const covering = projection.segments.filter(segment => segment.start < end && segment.end > start)
  const first = covering[0]
  const last = covering[covering.length - 1]
  expect(first).toBeDefined()
  expect(last).toBeDefined()
  return MARKDOWN.slice(first!.sourceStart, last!.sourceEnd)
}

describe('extractMarkdownPlainTextSegments', () => {
  it('maps a plain document 1:1', () => {
    const projection = extractMarkdownPlainTextSegments('Hello world.')
    expect(projection.text).toBe('Hello world.')
    expect(projection.segments).toEqual([
      { start: 0, end: 12, sourceStart: 0, sourceEnd: 12 },
    ])
  })

  it('maps projected spans inside emphasized and linked text to their source', () => {
    const projection = extractMarkdownPlainTextSegments(MARKDOWN)
    expect(projection.text).toBe(extractMarkdownPlainText(MARKDOWN))
    expect(sourceAround(projection, 'paragraph')).toBe('paragraph')
    expect(sourceAround(projection, 'a link')).toBe('a link')
    expect(sourceAround(projection, 'shipped')).toBe('shipped')
    expect(sourceAround(projection, 'Release notes')).toBe('Release notes')
  })

  it('leaves inserted separators unmapped', () => {
    const projection = extractMarkdownPlainTextSegments('- a\n- b')
    expect(projection.text).toBe('a\nb')
    const separator = projection.text.indexOf('\n')
    expect(projection.segments.some(segment => segment.start <= separator && separator < segment.end))
      .toBe(false)
    expect(projection.segments.map(segment => (
      projection.text.slice(segment.start, segment.end)
    ))).toEqual(['a', 'b'])
  })

  it('collapses blank runs and drops structure that projects nothing', () => {
    const projection = extractMarkdownPlainTextSegments('one\n\n\n\ntwo\n\n---')
    expect(projection.text).toBe('one\n\ntwo')
    expect(projection.segments.map(segment => (
      projection.text.slice(segment.start, segment.end)
    ))).toEqual(['one', 'two'])
    expect(extractMarkdownPlainTextSegments('---').segments).toEqual([])
  })

  it('projects a bare www. the autolink transform splits without positions', () => {
    // A streamed prefix such as "foo.www." makes the GFM autolink transform
    // split the text into nodes that carry no source position; they project
    // with no source mapping instead of throwing.
    for (const markdown of ['see www.', 'foo.www.bar', 'remote `mattcarvercom/www.']) {
      expect(() => extractMarkdownPlainTextSegments(markdown)).not.toThrow()
      expect(extractMarkdownPlainTextSegments(markdown).text).toBe(markdown)
    }
    const projection = extractMarkdownPlainTextSegments('see www.')
    expect(projection.text).toBe('see www.')
    expect(projection.segments).toEqual([])
  })
})
