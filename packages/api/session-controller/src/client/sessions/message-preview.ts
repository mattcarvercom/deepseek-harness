/** Shared preview derivation for queue and in-flight inbox presentation. */
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

const PREVIEW_CHARS = 200

// Attachment blocks are excluded: presentation renders them from
// `content`, so the text preview covers only what has no visual form.
/**
 * One-line preview of a content block list: text blocks joined, other
 * blocks as type markers, image and file blocks excluded, capped at 200
 * characters with a trailing ellipsis.
 * @param content - the message content blocks.
 * @returns the capped single-line preview (empty for attachment-only content).
 */
export function previewOf(content: readonly ContentBlock[]): string {
  const flat = content
    .filter(block => block.type !== 'image' && block.type !== 'file')
    .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join(' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : flat
}

/**
 * Full joined text of an all-text content list.
 * @param content - the message content blocks.
 * @returns the joined text, or null when any block is not plain text.
 */
export function textOf(content: readonly ContentBlock[]): string | null {
  if (!content.every(block => block.type === 'text')) return null
  return content.map(block => block.text).join('')
}
