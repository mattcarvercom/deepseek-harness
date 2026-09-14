import { describe, expect, it } from 'vitest'
import { markdownLabels, type MarkdownLabelKey } from '../src/markdown/labels.ts'

describe('markdownLabels', () => {
  it('resolves exactly the chrome key set through the supplied locale seat', () => {
    const seen: string[] = []
    const labels = markdownLabels((key: MarkdownLabelKey) => {
      seen.push(key)
      return `t:${key}`
    })

    expect(labels).toEqual({
      code: { copyLabel: 't:copy', copiedLabel: 't:copied' },
      mermaid: {
        renderError: 't:markdown.mermaid.renderError',
        copiedImage: 't:markdown.mermaid.copiedImage',
        copyImage: 't:markdown.mermaid.copyImage',
      },
      footnotes: 't:markdown.footnotes',
    })
    expect(seen.sort()).toEqual([
      'copied',
      'copy',
      'markdown.footnotes',
      'markdown.mermaid.copiedImage',
      'markdown.mermaid.copyImage',
      'markdown.mermaid.renderError',
    ])
  })
})
