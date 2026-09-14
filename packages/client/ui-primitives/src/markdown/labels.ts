import type { MarkdownLabels } from './render.tsx'

/** The common-namespace locale keys the Markdown chrome resolves. */
export type MarkdownLabelKey =
  | 'copy'
  | 'copied'
  | 'markdown.mermaid.renderError'
  | 'markdown.mermaid.copiedImage'
  | 'markdown.mermaid.copyImage'
  | 'markdown.footnotes'

/**
 * Build the complete Markdown chrome labels for one locale revision.
 * @param t - a locale seat resolving the common-namespace chrome keys.
 * @returns Labels for code fences, mermaid diagrams, and footnotes.
 */
export function markdownLabels(t: (key: MarkdownLabelKey) => string): MarkdownLabels {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    mermaid: {
      renderError: t('markdown.mermaid.renderError'),
      copiedImage: t('markdown.mermaid.copiedImage'),
      copyImage: t('markdown.mermaid.copyImage'),
    },
    footnotes: t('markdown.footnotes'),
  }
}
