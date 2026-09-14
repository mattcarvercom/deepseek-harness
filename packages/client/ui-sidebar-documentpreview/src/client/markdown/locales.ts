/** Markdown implementation labels and primitive chrome. */
export const zh = {
  'viewer.label': 'Markdown',
  'code.copy': '复制',
  'code.copied': '已复制',
  'footnotes': '脚注',
  'mermaid.renderError': 'Mermaid 图渲染失败',
  'mermaid.copyImage': '复制图片',
  'mermaid.copiedImage': '图片已复制',
} satisfies Record<string, string>

/** Markdown namespace keys. */
export type MarkdownPreviewKey = keyof typeof zh

/** English labels, paired with the Chinese key set. */
export const en = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copy',
  'code.copied': 'Copied',
  'footnotes': 'Footnotes',
  'mermaid.renderError': 'Could not render the Mermaid diagram',
  'mermaid.copyImage': 'Copy image',
  'mermaid.copiedImage': 'Image copied',
} satisfies Record<MarkdownPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Markdown document renderer and its code/footnote controls. */
    documentMarkdown: MarkdownPreviewKey
  }
}
