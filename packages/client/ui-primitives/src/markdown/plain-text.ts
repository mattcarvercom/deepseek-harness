/**
 * Markdown-to-plain-text projection for compact summaries and labels.
 * Parsing shares the renderer's streaming GFM grammar ({@link parseGfm}), so
 * the projection strips exactly the markup the renderer would draw; raw HTML
 * stays literal, links keep their labels, images keep alt text, and code
 * keeps its source text. The same walk reports the Markdown source range of
 * every projected span ({@link extractMarkdownPlainTextSegments}), which is
 * what lets a reader highlight the source of the sentence it speaks.
 */

import { parseGfm } from './parse.ts'

/** Amount of parsed Markdown content returned by the extractor. */
export type MarkdownPlainTextMode = 'all' | 'first-line' | 'first-paragraph'

/** Options for {@link extractMarkdownPlainText}. */
export interface MarkdownPlainTextOptions {
  /** Projection boundary; defaults to the complete document. */
  mode?: MarkdownPlainTextMode
}

/** One projected span and the Markdown source range it came from. */
export interface MarkdownPlainTextSegment {
  /** Start offset of the span in the projected text. */
  readonly start: number
  /** End offset (exclusive) of the span in the projected text. */
  readonly end: number
  /** Start offset of the span in the Markdown source. */
  readonly sourceStart: number
  /** End offset (exclusive) of the span in the Markdown source. */
  readonly sourceEnd: number
}

/** A projected plain text and the source mapping of its spans. */
export interface MarkdownPlainTextProjection {
  /** The projected text, identical to {@link extractMarkdownPlainText}. */
  readonly text: string
  /**
   * Contiguous spans of the projected text whose characters map 1:1 to a
   * contiguous Markdown source range, in text order. Separators the
   * projection inserted (collapsed whitespace, joined blocks, line breaks
   * folded into newlines) carry no source range and leave gaps between the
   * segments' `start`/`end` offsets.
   */
  readonly segments: readonly MarkdownPlainTextSegment[]
}

interface MarkdownNode {
  type: string
  value?: string
  alt?: string
  children?: MarkdownNode[]
  /** Absent on text nodes the GFM autolink transform splits off around a bare `www.`. */
  position?: {
    start: { offset: number }
    end: { offset: number }
  }
}

/** One projected character and, when known, its Markdown source offset. */
interface MappedChar {
  readonly ch: string
  readonly at: number | undefined
}

function inlineText(node: MarkdownNode): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
      return node.value ?? ''
    case 'image':
    case 'imageReference':
      return node.alt ?? ''
    case 'break':
      return '\n'
    case 'html':
      return node.value ?? ''
    default:
      return node.children?.map(inlineText).join('') ?? ''
  }
}

function compactInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function findFirstParagraph(node: MarkdownNode): string | undefined {
  if (node.type === 'paragraph') {
    const text = compactInline(inlineText(node))
    if (text !== '') return text
  }
  for (const child of node.children ?? []) {
    const text = findFirstParagraph(child)
    if (text !== undefined) return text
  }
  return undefined
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch)
}

/** Map a node's literal value onto its source range, one character per code unit; a node without a position maps to no source. */
function valueChars(value: string, node: MarkdownNode): MappedChar[] {
  const start = node.position?.start.offset
  const chars: MappedChar[] = []
  for (let index = 0; index < value.length; index += 1) {
    chars.push({ ch: value.charAt(index), at: start === undefined ? undefined : start + index })
  }
  return chars
}

function separatorChars(separator: string): MappedChar[] {
  const chars: MappedChar[] = []
  for (let index = 0; index < separator.length; index += 1) {
    chars.push({ ch: separator.charAt(index), at: undefined })
  }
  return chars
}

function inlineChars(node: MarkdownNode): MappedChar[] {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
      return valueChars(node.value ?? '', node)
    case 'image':
    case 'imageReference':
      return valueChars(node.alt ?? '', node)
    case 'break':
      return [{ ch: '\n', at: undefined }]
    case 'html':
      return valueChars(node.value ?? '', node)
    default:
      return (node.children ?? []).flatMap(child => inlineChars(child))
  }
}

/** Collapse whitespace runs to single spaces and trim, keeping source offsets. */
function compactChars(chars: readonly MappedChar[]): MappedChar[] {
  const out: MappedChar[] = []
  let pendingSpace: MappedChar | undefined
  for (const item of chars) {
    if (isSpace(item.ch)) {
      pendingSpace ??= { ch: ' ', at: item.at }
      continue
    }
    if (pendingSpace !== undefined) {
      out.push(pendingSpace)
      pendingSpace = undefined
    }
    out.push(item)
  }
  return out
}

/** Drop leading and trailing whitespace without moving the kept characters. */
function trimChars(chars: readonly MappedChar[]): MappedChar[] {
  const first = chars.findIndex(item => !isSpace(item.ch))
  if (first === -1) return []
  let last = first
  for (const [index, item] of chars.entries()) {
    if (index >= first && !isSpace(item.ch)) last = index
  }
  return chars.slice(first, last + 1)
}

/** Join non-empty block runs with an unmapped separator, mirroring the text projection's filters. */
function joinBlocks(nodes: readonly MarkdownNode[], separator: string): MappedChar[] {
  const out: MappedChar[] = []
  let first = true
  for (const node of nodes) {
    const chars = blockChars(node)
    if (chars.length === 0) continue
    if (!first) out.push(...separatorChars(separator))
    first = false
    out.push(...chars)
  }
  return out
}

function blockChars(node: MarkdownNode): MappedChar[] {
  switch (node.type) {
    case 'root':
    case 'blockquote':
      return joinBlocks(node.children ?? [], '\n\n')
    case 'paragraph':
    case 'heading':
      return compactChars(inlineChars(node))
    case 'code':
      return trimChars(valueChars(node.value ?? '', node))
    case 'list':
      return joinBlocks(node.children ?? [], '\n')
    case 'listItem':
      return joinBlocks(node.children ?? [], ' ')
    case 'table':
      return joinBlocks(node.children ?? [], '\n')
    case 'tableRow':
      return (node.children ?? []).flatMap((child, index) => index === 0
        ? blockChars(child)
        : [...separatorChars('\t'), ...blockChars(child)])
    case 'tableCell':
      return compactChars(inlineChars(node))
    case 'html':
      return valueChars(node.value ?? '', node)
    case 'thematicBreak':
    case 'definition':
      return []
    default:
      return compactChars(inlineChars(node))
  }
}

function splitLines(chars: readonly MappedChar[]): MappedChar[][] {
  const lines: MappedChar[][] = []
  let line: MappedChar[] = []
  for (const item of chars) {
    if (item.ch === '\n') {
      lines.push(line)
      line = []
      continue
    }
    line.push(item)
  }
  lines.push(line)
  return lines
}

/** Collapse a run of three or more newlines to two, mirroring the text projection. */
function collapseBlankRuns(chars: readonly MappedChar[]): MappedChar[] {
  const out: MappedChar[] = []
  let run = 0
  for (const item of chars) {
    if (item.ch === '\n') {
      run += 1
      if (run <= 2) out.push(item)
      continue
    }
    run = 0
    out.push(item)
  }
  return out
}

/** The projected document with per-character source offsets, before mode slicing. */
function fullChars(root: MarkdownNode): MappedChar[] {
  const joined: MappedChar[] = []
  splitLines(blockChars(root)).forEach((line, index) => {
    if (index > 0) joined.push({ ch: '\n', at: undefined })
    joined.push(...trimChars(line))
  })
  return trimChars(collapseBlankRuns(joined))
}

/**
 * Parse GFM Markdown, remove its presentation markup, and preserve raw HTML
 * literally — the same walk as {@link extractMarkdownPlainText}, additionally
 * reporting where each projected span came from.
 * @param markdown - Markdown source.
 * @returns the projected text and its source-mapped spans.
 */
export function extractMarkdownPlainTextSegments(markdown: string): MarkdownPlainTextProjection {
  const root = parseGfm(markdown) as MarkdownNode
  const chars = fullChars(root)
  const segments: MarkdownPlainTextSegment[] = []
  // One streaming scan: a run continues while consecutive projected
  // characters map to consecutive source offsets; every break (an inserted
  // separator, a collapsed-run gap) closes the run and leaves a gap.
  let runStart = -1
  let runSource = -1
  let previousSource = -1
  const close = (end: number): void => {
    if (runStart === -1) return
    segments.push({
      start: runStart,
      end,
      sourceStart: runSource,
      sourceEnd: previousSource + 1,
    })
    runStart = -1
  }
  for (const [cursor, item] of chars.entries()) {
    const at = item.at
    if (at !== undefined && runStart !== -1 && at === previousSource + 1) {
      previousSource = at
      continue
    }
    close(cursor)
    if (at !== undefined) {
      runStart = cursor
      runSource = at
      previousSource = at
    }
  }
  close(chars.length)
  return { text: chars.map(item => item.ch).join(''), segments }
}

/**
 * Parse GFM Markdown, remove its presentation markup, and preserve raw HTML literally.
 * @param markdown - Markdown source.
 * @param options - Optional extraction boundary.
 * @returns Plain text for the whole document, first visible line, or first semantic paragraph.
 */
export function extractMarkdownPlainText(
  markdown: string,
  options: MarkdownPlainTextOptions = {},
): string {
  const { mode = 'all' } = options
  const all = extractMarkdownPlainTextSegments(markdown).text
  switch (mode) {
    case 'all':
      return all
    case 'first-line':
      return all.split('\n').find(line => line !== '') ?? ''
    case 'first-paragraph':
      return findFirstParagraph(parseGfm(markdown) as MarkdownNode)
        ?? all.split('\n').find(line => line !== '') ?? ''
  }
}
