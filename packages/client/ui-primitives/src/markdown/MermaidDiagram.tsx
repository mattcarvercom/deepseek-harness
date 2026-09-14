/**
 * Settled mermaid fence: draws the diagram as an inline SVG once the lazy
 * mermaid chunk arrives, and falls back to the fenced source in a CodeBlock
 * when the source does not render. The SVG follows the app palette: the theme
 * presenter projects the active scheme onto `body[data-ds-dark-theme]`, and a
 * mutation observer re-renders the diagram when that attribute flips, so a
 * light/dark switch recolors every diagram without a reload. Mermaid runs at
 * its default `strict` security level, which sanitizes the SVG and disables
 * diagram click handlers — untrusted model output never reaches the DOM
 * interactive. The drawn card carries two copy actions: the fenced source,
 * and the rendered image as a PNG (clipboard write, with a file download as
 * the host fallback).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { writeClipboard } from '../clipboard.ts'
import { CodeBlock } from './CodeBlock.tsx'
import { diagramPngBlob, diagramSvgText, downloadBlob, DIAGRAM_PNG_FILENAME, DIAGRAM_SVG_FILENAME } from './mermaid-image.ts'
import { loadMermaid } from './mermaid.ts'
import css from './MermaidDiagram.module.css'

export interface MermaidDiagramProps {
  /** The diagram source exactly as fenced (no fence markers). */
  code: string
  /** Localized line shown above the source when the diagram fails to render. */
  errorLabel: string
  /** Copy-button idle label for the source fallback and the diagram's copy action. */
  copyLabel: string
  /** Copy-button label during the post-copy confirmation window. */
  copiedLabel: string
  /** Copy-image-button idle label on the drawn card. */
  copyImageLabel: string
  /** Copy-image-button label during the post-copy confirmation window. */
  copiedImageLabel: string
}

/** The theme presenter projects the active palette through this body attribute (ui-theme owns the token). */
const DARK_THEME_ATTRIBUTE = 'data-ds-dark-theme'

/** Post-copy confirmation window for both actions, in milliseconds. */
const COPIED_FEEDBACK_MS = 1000

/** Unique per render call: mermaid keys its SVG and its temporary DOM by the id. */
let renderSequence = 0

/** One render outcome: the SVG string, or a failure with mermaid's diagnostic when it has one. */
type MermaidOutcome =
  | { status: 'svg'; svg: string }
  | { status: 'error'; detail?: string }

/**
 * Load the mermaid module and render one diagram for the given palette.
 * @param code - The diagram source.
 * @param dark - Whether the dark palette is active.
 * @returns The SVG, or the failure with mermaid's message when rendering threw one.
 */
async function renderMermaidSvg(code: string, dark: boolean): Promise<MermaidOutcome> {
  try {
    const mermaid = await loadMermaid()
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
    const { svg } = await mermaid.render(`dsh-mermaid-${String(++renderSequence)}`, code)
    return { status: 'svg', svg }
  } catch (error) {
    // mermaid rejects parse and render failures with Error; a plain string is
    // the only non-Error shape this promise chain can carry.
    return { status: 'error', detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Whether the dark palette is currently projected onto the document body.
 * @returns True while body carries the theme attribute.
 */
function isDarkPalette(): boolean {
  return document.body.hasAttribute(DARK_THEME_ATTRIBUTE)
}

/**
 * Subscribe to palette flips on `document.body`.
 * @returns The current dark-palette state, updating when the presenter flips it.
 */
function useDarkPalette(): boolean {
  const subscribe = useCallback((onStoreChange: () => void): (() => void) => {
    const observer = new MutationObserver(onStoreChange)
    observer.observe(document.body, { attributes: true, attributeFilter: [DARK_THEME_ATTRIBUTE] })
    return () => {
      observer.disconnect()
    }
  }, [])
  return useSyncExternalStore(subscribe, isDarkPalette, isDarkPalette)
}

/**
 * Draw one settled mermaid fence as an inline SVG, or its source in a
 * CodeBlock with the failure line when the diagram does not render. The drawn
 * card carries copy actions for the source and for the rendered image.
 * @param props - The fenced source and the localized chrome.
 * @returns The diagram, or the source fallback while the chunk loads or after a failure.
 */
export function MermaidDiagram({ code, errorLabel, copyLabel, copiedLabel, copyImageLabel, copiedImageLabel }: MermaidDiagramProps) {
  const dark = useDarkPalette()
  const [outcome, setOutcome] = useState<MermaidOutcome | undefined>(undefined)
  const [sourceCopied, setSourceCopied] = useState(false)
  const [imageCopied, setImageCopied] = useState(false)
  const diagramRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    void renderMermaidSvg(code, dark).then((result) => {
      if (!cancelled) setOutcome(result)
    })
    return () => { cancelled = true }
  }, [code, dark])

  // The copy actions only exist on the drawn card; the source fallback keeps
  // its own CodeBlock copy button.
  const onCopySource = useCallback(() => {
    if (sourceCopied) return
    void writeClipboard(code).then((ok) => {
      if (!ok) return
      setSourceCopied(true)
      window.setTimeout(() => { setSourceCopied(false) }, COPIED_FEEDBACK_MS)
    })
  }, [code, sourceCopied])

  // Copy the drawn SVG as a PNG image; a clipboard that rejects image writes
  // gets the PNG as a file download, and a host that cannot rasterize at all
  // gets the vector source as an SVG download.
  const onCopyImage = useCallback(() => {
    const svg = diagramRef.current?.querySelector('svg')
    if (!svg || imageCopied) return
    void (async () => {
      let png: Blob | undefined
      try {
        png = await diagramPngBlob(svg)
      } catch {
        // No 2d context (or a decode failure): the vector form always travels.
        downloadBlob(new Blob([diagramSvgText(svg)], { type: 'image/svg+xml' }), DIAGRAM_SVG_FILENAME)
        return
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
        setImageCopied(true)
        window.setTimeout(() => { setImageCopied(false) }, COPIED_FEEDBACK_MS)
      } catch {
        downloadBlob(png, DIAGRAM_PNG_FILENAME)
      }
    })()
  }, [imageCopied])

  if (outcome?.status === 'svg') {
    // mermaid's SVG is generated from its own parsed model and sanitized at
    // strict security level (no user HTML passes through), the same trust the
    // CodeBlock shiki HTML arm gets. The actions overlay sits outside the
    // innerHTML element because React allows children or __html, not both.
    return (
      <div className={css.diagramWrap}>
        <div ref={diagramRef} className={css.diagram} dangerouslySetInnerHTML={{ __html: outcome.svg }} />
        <div className={css.actions}>
          <button type="button" className={css.actionButton} onClick={onCopySource}>
            {sourceCopied ? copiedLabel : copyLabel}
          </button>
          <button type="button" className={css.actionButton} onClick={onCopyImage}>
            {imageCopied ? copiedImageLabel : copyImageLabel}
          </button>
        </div>
      </div>
    )
  }
  const sourceBlock = (
    <CodeBlock
      // The synthetic trailing newline mirrors the CodeBlock call in
      // renderCode: its display trim removes it instead of eating a real
      // trailing blank line inside the fence.
      code={`${code}\n`}
      lang="mermaid"
      copyLabel={copyLabel}
      copiedLabel={copiedLabel}
    />
  )
  if (outcome?.status === 'error') {
    return (
      <div className={css.fallback}>
        <div className={css.error}>
          {errorLabel}
          {outcome.detail !== undefined && <span className={css.detail}>: {outcome.detail}</span>}
        </div>
        {sourceBlock}
      </div>
    )
  }
  return sourceBlock
}
