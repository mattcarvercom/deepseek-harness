// @vitest-environment jsdom
// The MermaidDiagram state machine with the mermaid loader stubbed: jsdom has
// neither the CSSStyleSheet constructor nor the SVG geometry (getBBox) that
// mermaid's real renderer needs, so this spec pins the promise contract — the
// theme handshake, the load and render failure fallbacks, and the renderCode
// fence arms, and the copy actions on the drawn card. The real module load
// and renderer run in their own specs and the web e2e; the image-export seam
// is mocked here (its DOM pipeline has its own spec).
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Md from 'mdast'
import { MermaidDiagram } from '../src/markdown/MermaidDiagram.tsx'
import { createReferenceTargets, renderBlocks } from '../src/markdown/render.tsx'
import type { MarkdownRenderContext } from '../src/markdown/render.tsx'
import { markdownLabels } from './labels.client.ts'

interface MermaidStub {
  initialize: (options: Record<string, unknown>) => void
  render: (id: string, source: string) => Promise<{ svg: string }>
}

const mockState = {
  load: vi.fn<() => Promise<MermaidStub>>(),
  initialize: vi.fn<(options: Record<string, unknown>) => void>(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(),
}

vi.mock('../src/markdown/mermaid.ts', () => ({
  loadMermaid: () => mockState.load(),
}))

// vi.hoisted: the mock factory runs while the import chain still evaluates,
// so the state it returns must exist before the spec body's consts.
const imageState = vi.hoisted(() => ({
  diagramPngBlob: vi.fn<(svg: SVGSVGElement) => Promise<Blob>>(),
  diagramSvgText: vi.fn<(svg: SVGSVGElement) => string>(),
  downloadBlob: vi.fn<(blob: Blob, filename: string) => void>(),
  DIAGRAM_PNG_FILENAME: 'mermaid-diagram.png',
  DIAGRAM_SVG_FILENAME: 'mermaid-diagram.svg',
}))

vi.mock('../src/markdown/mermaid-image.ts', () => imageState)

/** The clipboard image write the copy-image control calls; text writes go through the real writeClipboard. */
const clipWrite = vi.fn<(items: readonly ClipboardItem[]) => Promise<void>>()

const SOURCE = 'graph TD\n  A-->B'
const DIAGRAM_SVG = '<svg id="mermaid-diagram-svg" xmlns="http://www.w3.org/2000/svg"><g></g></svg>'

function diagram(code: string) {
  return (
    <MermaidDiagram
      code={code}
      errorLabel={markdownLabels.mermaid.renderError}
      copyLabel={markdownLabels.code.copyLabel}
      copiedLabel={markdownLabels.code.copiedLabel}
      copyImageLabel={markdownLabels.mermaid.copyImage}
      copiedImageLabel={markdownLabels.mermaid.copiedImage}
    />
  )
}

/** Flush microtasks and the mutation-observer queue inside act so promise-driven renders settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function settleUntil(container: HTMLElement, probe: (container: HTMLElement) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !probe(container); attempt += 1) await settle()
  expect(probe(container)).toBe(true)
}

function makeContext(streaming: boolean): MarkdownRenderContext {
  return {
    streaming,
    labels: markdownLabels,
    fileMentions: undefined,
    targets: createReferenceTargets(),
    footnoteOrder: [],
    footnoteCounts: new Map(),
  }
}

beforeEach(() => {
  vi.useRealTimers()
  document.body.removeAttribute('data-ds-dark-theme')
  mockState.load.mockReset()
  mockState.initialize.mockReset()
  mockState.render.mockReset()
  mockState.load.mockResolvedValue({
    initialize: (options) => {
      mockState.initialize(options)
    },
    render: (id, source) => mockState.render(id, source),
  })
  mockState.render.mockResolvedValue({ svg: DIAGRAM_SVG })
  imageState.diagramPngBlob.mockReset()
  imageState.diagramSvgText.mockReset()
  imageState.downloadBlob.mockReset()
  imageState.diagramPngBlob.mockResolvedValue(new Blob(['png-bytes'], { type: 'image/png' }))
  imageState.diagramSvgText.mockReturnValue('<svg></svg>')
  clipWrite.mockReset()
  clipWrite.mockResolvedValue(undefined)
  vi.stubGlobal('ClipboardItem', class ClipboardItemStub {
    private readonly parts: Record<string, Blob>
    constructor(parts: Record<string, Blob>) {
      this.parts = parts
    }
    async getType(type: string): Promise<Blob | undefined> {
      return this.parts[type]
    }
  })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: clipWrite } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MermaidDiagram', () => {
  it('draws the settled source as an SVG once the lazy module resolves', async () => {
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => root.querySelector('svg') !== null)
    expect(mockState.initialize).toHaveBeenCalledTimes(1)
    expect(mockState.initialize).toHaveBeenCalledWith(
      { startOnLoad: false, securityLevel: 'strict', theme: 'default' },
    )
    const [id, source] = mockState.render.mock.calls[0]!
    expect(id).toMatch(/^dsh-mermaid-\d+$/)
    expect(source).toBe(SOURCE)
    expect(container.querySelector('pre')).toBeNull()
  })

  it('keeps the fenced source visible while the module loads', async () => {
    let resolveLoad: ((stub: MermaidStub) => void) | undefined
    mockState.load.mockImplementation(() => new Promise((resolve) => {
      resolveLoad = resolve
    }))
    const { container } = render(diagram(SOURCE))
    await settle()
    expect(container.querySelector('svg')).toBeNull()
    expect(screen.getByText('mermaid')).toBeTruthy()
    expect(container.querySelector('pre')?.textContent).toBe(SOURCE)
    await act(async () => {
      resolveLoad?.({
        initialize: (options) => {
          mockState.initialize(options)
        },
        render: (id, source) => mockState.render(id, source),
      })
    })
    await settleUntil(container, root => root.querySelector('svg') !== null)
  })

  it("shows the failure line with mermaid's message and keeps the source", async () => {
    mockState.render.mockRejectedValue(new Error('Parse error on line 2'))
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => (root.textContent ?? '').includes('Parse error on line 2'))
    expect(container.textContent).toContain(markdownLabels.mermaid.renderError)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe(SOURCE)
  })

  it('stringifies a non-Error rejection into the failure line', async () => {
    mockState.render.mockRejectedValue('chunk failed')
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => (root.textContent ?? '').includes('chunk failed'))
    expect(container.textContent).toContain(markdownLabels.mermaid.renderError)
    expect(container.querySelector('pre')?.textContent).toBe(SOURCE)
  })

  it('shows the failure line when the lazy module load rejects', async () => {
    mockState.load.mockRejectedValueOnce(new Error('failed to fetch the mermaid chunk'))
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => (root.textContent ?? '').includes('failed to fetch the mermaid chunk'))
    expect(container.textContent).toContain(markdownLabels.mermaid.renderError)
    expect(mockState.render).not.toHaveBeenCalled()
    expect(container.querySelector('pre')?.textContent).toBe(SOURCE)
  })

  it('renders with the dark theme when the dark palette is active', async () => {
    document.body.setAttribute('data-ds-dark-theme', '')
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => root.querySelector('svg') !== null)
    expect(mockState.initialize).toHaveBeenCalledWith(
      { startOnLoad: false, securityLevel: 'strict', theme: 'dark' },
    )
  })

  it('re-renders the diagram when the presenter flips the palette', async () => {
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => root.querySelector('svg') !== null)
    mockState.initialize.mockClear()
    mockState.render.mockClear()
    await act(async () => {
      document.body.setAttribute('data-ds-dark-theme', '')
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await settleUntil(container, () => mockState.render.mock.calls.length >= 1)
    expect(mockState.render).toHaveBeenCalledTimes(1)
    expect(mockState.initialize).toHaveBeenCalledTimes(1)
    expect(mockState.initialize).toHaveBeenCalledWith(
      { startOnLoad: false, securityLevel: 'strict', theme: 'dark' },
    )
  })

  it('drops the render result when the component unmounts first', async () => {
    let resolveLoad: ((stub: MermaidStub) => void) | undefined
    mockState.load.mockImplementation(() => new Promise((resolve) => {
      resolveLoad = resolve
    }))
    const view = render(diagram(SOURCE))
    await settle()
    view.unmount()
    await act(async () => {
      resolveLoad?.({
        initialize: (options) => {
          mockState.initialize(options)
        },
        render: (id, source) => mockState.render(id, source),
      })
    })
    expect(mockState.render).toHaveBeenCalledTimes(1)
  })

  it('settles once under StrictMode despite the double effect', async () => {
    const { container } = render(<StrictMode>{diagram(SOURCE)}</StrictMode>)
    await settleUntil(container, root => root.querySelector('svg') !== null)
    expect(mockState.render).toHaveBeenCalledTimes(2)
    expect(container.querySelectorAll('svg')).toHaveLength(1)
  })
})

describe('diagram card copy actions', () => {
  it('copies the fenced source from the drawn card with confirmation feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: clipWrite, writeText } })
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => root.querySelector('svg') !== null)
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.code.copyLabel }))
    expect(writeText).toHaveBeenCalledWith(SOURCE)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole('button', { name: markdownLabels.code.copiedLabel })).toBeTruthy()
    // While the ok label is showing, further clicks are no-ops.
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.code.copiedLabel }))
    expect(writeText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(screen.getByRole('button', { name: markdownLabels.code.copyLabel })).toBeTruthy()
    vi.useRealTimers()
  })

  it('shows no confirmation when the host refuses the source copy', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: clipWrite, writeText } })
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => root.querySelector('svg') !== null)
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.code.copyLabel }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByRole('button', { name: markdownLabels.code.copyLabel })).toBeTruthy()
    vi.useRealTimers()
  })

  it('copies the drawn diagram to the clipboard as a png image', async () => {
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => root.querySelector('svg') !== null)
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.mermaid.copyImage }))
    expect(imageState.diagramPngBlob).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(clipWrite).toHaveBeenCalledTimes(1)
    const [items] = clipWrite.mock.calls[0]!
    const item = items[0]!
    const png = await item.getType('image/png')
    expect(png?.type).toBe('image/png')
    expect(screen.getByRole('button', { name: markdownLabels.mermaid.copiedImage })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.mermaid.copiedImage }))
    expect(clipWrite).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(screen.getByRole('button', { name: markdownLabels.mermaid.copyImage })).toBeTruthy()
    vi.useRealTimers()
  })

  it('downloads the png when the clipboard rejects the image write', async () => {
    clipWrite.mockRejectedValueOnce(new Error('denied'))
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => root.querySelector('svg') !== null)
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.mermaid.copyImage }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(imageState.downloadBlob).toHaveBeenCalledTimes(1)
    const [blob, filename] = imageState.downloadBlob.mock.calls[0]!
    expect(filename).toBe('mermaid-diagram.png')
    expect(blob.type).toBe('image/png')
    expect(screen.queryByRole('button', { name: markdownLabels.mermaid.copiedImage })).toBeNull()
    vi.useRealTimers()
  })

  it('downloads the svg source when rasterization fails', async () => {
    imageState.diagramPngBlob.mockRejectedValueOnce(new Error('no canvas'))
    imageState.diagramSvgText.mockReturnValueOnce('<svg id="d"></svg>')
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => root.querySelector('svg') !== null)
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.mermaid.copyImage }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(imageState.downloadBlob).toHaveBeenCalledTimes(1)
    const [blob, filename] = imageState.downloadBlob.mock.calls[0]!
    expect(filename).toBe('mermaid-diagram.svg')
    expect(blob.type).toBe('image/svg+xml')
    expect(await blob.text()).toBe('<svg id="d"></svg>')
    expect(clipWrite).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('ignores the image copy when the card holds no svg', async () => {
    mockState.render.mockResolvedValueOnce({ svg: '<div class="no-svg"></div>' })
    const { container } = render(diagram(SOURCE))
    await settleUntil(container, root => root.querySelector('.no-svg') !== null)
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: markdownLabels.mermaid.copyImage }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(imageState.diagramPngBlob).not.toHaveBeenCalled()
    expect(imageState.downloadBlob).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('shows no copy-image action while the diagram is still loading', async () => {
    mockState.load.mockImplementation(() => new Promise(() => undefined))
    render(diagram(SOURCE))
    await settle()
    expect(screen.queryByRole('button', { name: markdownLabels.mermaid.copyImage })).toBeNull()
    // The source fallback keeps its own CodeBlock copy button.
    expect(screen.queryByRole('button', { name: markdownLabels.code.copyLabel })).toBeTruthy()
  })
})

describe('renderCode mermaid fence arms', () => {
  it('draws a settled mermaid fence as a diagram and a streaming one as a code block', async () => {
    const node: Md.Code = { type: 'code', lang: 'mermaid', value: SOURCE }
    const settled = render(<div>{renderBlocks([{ node, key: 0 }], makeContext(false))}</div>)
    await settleUntil(settled.container, root => root.querySelector('svg') !== null)

    const streaming = render(<div>{renderBlocks([{ node, key: 0 }], makeContext(true))}</div>)
    await settle()
    expect(streaming.container.querySelector('svg')).toBeNull()
    expect(streaming.container.querySelector('pre')?.textContent).toBe(SOURCE)
  })
})
