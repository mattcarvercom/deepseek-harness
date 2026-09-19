/**
 * Turn an assistant message's content blocks into the text TTS speaks.
 * Fenced code blocks are skipped entirely (no announcement); the remaining
 * Markdown is reduced to plain text with the renderer's own GFM projection,
 * so the spoken form matches what the transcript draws — links as their
 * labels, images as alt text, tables as cell rows — minus code. Reasoning,
 * tool calls, and standalone image attachments are never spoken. Every
 * spoken span keeps the Markdown source range it came from, so the reader
 * can highlight the sentence being spoken.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/sanitizer
 */

import {
  extractMarkdownPlainTextSegments, type MarkdownPlainTextSegment,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: the assistant block union the transcript renders.
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-chat/client'

/** One text block reduced to the utterance it speaks, with its source map. */
export interface SpeakableBlock {
  /** Index of the block in the message's block list (the renderer's key). */
  readonly blockIndex: number
  /** The block's speakable text. */
  readonly text: string
  /** Spoken-text spans mapped to ranges in the block's original Markdown. */
  readonly segments: readonly MarkdownPlainTextSegment[]
}

/** Fenced-code-stripped Markdown and the original offset of every kept character. */
export interface StrippedMarkdown {
  /** The Markdown with every fence block removed. */
  readonly text: string
  /** One original source offset per character of {@link text}. */
  readonly sourceOffsets: readonly number[]
}

/**
 * Remove fenced code blocks from Markdown, keeping each surviving character's
 * offset in the original source. A fence opens with three or more backticks
 * or tildes (up to three leading spaces) and closes with a line of the same
 * character at least as long, so a 3-backtick line inside a 4-backtick fence
 * stays in the fence. A trailing unclosed fence (an interrupted stream)
 * drops everything from its opener.
 * @param markdown - raw message text.
 * @returns the text without fences and the per-character source offsets.
 */
export function stripFencedCode(markdown: string): StrippedMarkdown {
  const chars: string[] = []
  const sourceOffsets: number[] = []
  let fence: { char: '`' | '~'; len: number } | undefined
  let offset = 0
  for (const line of markdown.split('\n')) {
    const lineStart = offset
    offset += line.length + 1
    const opener = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
    if (fence === undefined) {
      if (opener === undefined) {
        if (chars.length > 0) {
          // The join newline stands for the original line break.
          chars.push('\n')
          sourceOffsets.push(lineStart - 1)
        }
        for (let index = 0; index < line.length; index += 1) {
          chars.push(line.charAt(index))
          sourceOffsets.push(lineStart + index)
        }
      } else {
        fence = { char: opener.charAt(0) as '`' | '~', len: opener.length }
      }
    } else if (opener !== undefined && opener.charAt(0) === fence.char && opener.length >= fence.len) {
      fence = undefined
    }
  }
  return { text: chars.join(''), sourceOffsets }
}

/**
 * Reduce the message's text blocks to the utterances TTS speaks, one entry
 * per text block that has anything speakable, with each spoken span mapped
 * back to the block's Markdown source.
 * @param blocks - the message's content blocks, in transcript order.
 * @returns the speakable blocks in order; blocks with nothing speakable are omitted.
 */
export function speakableBlocks(blocks: readonly AssistantBlock[]): readonly SpeakableBlock[] {
  const speakable: SpeakableBlock[] = []
  blocks.forEach((block, blockIndex) => {
    if (block.kind !== 'text') return
    const stripped = stripFencedCode(block.text)
    const projection = extractMarkdownPlainTextSegments(stripped.text)
    if (projection.text === '') return
    speakable.push({
      blockIndex,
      text: projection.text,
      segments: projection.segments.map((segment) => {
        // The projection's segment offsets index its projected text while its
        // sourceStart/sourceEnd index the stripped text; re-map those source
        // bounds through the keep table. Each surviving character has exactly
        // one table entry, so the lookups are exact.
        // oxlint-disable-next-line typescript/no-non-null-assertion
        const sourceStart = stripped.sourceOffsets[segment.sourceStart]!
        // oxlint-disable-next-line typescript/no-non-null-assertion
        const lastSource = stripped.sourceOffsets[segment.sourceEnd - 1]!
        return { ...segment, sourceStart, sourceEnd: lastSource + 1 }
      }),
    })
  })
  return speakable
}
