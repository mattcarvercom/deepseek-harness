// @vitest-environment jsdom
// The mermaid-image DOM pipeline under jsdom: the SVG serialization contract
// (viewBox size pinning, mermaid's width="100%" and inline style stripped),
// the SVG-to-PNG rasterization chain (image decode, 2d canvas, PNG encoding)
// with each failure arm, and the download anchor flow. jsdom provides neither
// image decoding nor a canvas 2d context, so the spec stubs both at the
// platform level the module consumes them through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DIAGRAM_PNG_FILENAME, DIAGRAM_SVG_FILENAME, diagramPngBlob, diagramSvgText, downloadBlob,
} from '../src/markdown/mermaid-image.ts'

const SVG_SOURCE = '<svg id="d" width="100%" style="max-width: 492px" viewBox="0 0 492 217"><g><text>A</text></g></svg>'

/**
 * Platform image stub: resolves the decode on the microtask after `src` is
 * set, like a browser does, and reports the viewBox pixel size.
 */
class StubImage {
  private _src = ''
  private readonly fail: boolean
  onload: (() => void) | undefined
  onerror: (() => void) | undefined
  naturalWidth = 492
  naturalHeight = 217
  constructor(fail = false) {
    this.fail = fail
  }
  get src(): string {
    return this._src
  }
  set src(url: string) {
    this._src = url
    void Promise.resolve().then(() => {
      if (this.fail) this.onerror?.()
      else this.onload?.()
    })
  }
}

class BrokenImage extends StubImage {
  constructor() {
    super(true)
  }
}

function renderSvg(source: string): SVGSVGElement {
  const holder = document.createElement('div')
  holder.innerHTML = source
  const svg = holder.querySelector('svg')
  if (svg === null) throw new Error('the test svg is missing')
  return svg
}

const createObjectURL = vi.fn<(input: Blob | MediaSource) => string>(() => 'blob:stub')
const revokeObjectURL = vi.fn()
const drawImage = vi.fn()

beforeEach(() => {
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  drawImage.mockClear()
  vi.stubGlobal('Image', StubImage)
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback: BlobCallback) => {
    callback(new Blob(['png-bytes'], { type: 'image/png' }))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('diagramSvgText', () => {
  it('pins the viewBox pixel size and strips the inline size hints', () => {
    const text = diagramSvgText(renderSvg(SVG_SOURCE))
    expect(text).toContain('width="492"')
    expect(text).toContain('height="217"')
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(text).toContain('<text>A</text>')
    expect(text).not.toContain('width="100%"')
    expect(text).not.toContain('max-width')
  })

  it('falls back to the rendered box when the viewBox is empty', () => {
    const text = diagramSvgText(renderSvg('<svg id="d"><g></g></svg>'))
    expect(text).toContain('width="1"')
    expect(text).toContain('height="1"')
  })
})

describe('diagramPngBlob', () => {
  it('rasterizes the serialized svg to a png blob at the viewBox size', async () => {
    const blob = await diagramPngBlob(renderSvg(SVG_SOURCE))
    expect(blob.type).toBe('image/png')
    expect(await blob.text()).toBe('png-bytes')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const svgBlob = createObjectURL.mock.calls[0]![0] as Blob
    expect(svgBlob.type).toBe('image/svg+xml;charset=utf-8')
    expect(await svgBlob.text()).toContain('width="492"')
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:stub')
  })

  it('rejects when the svg does not decode as an image', async () => {
    vi.stubGlobal('Image', BrokenImage)
    await expect(diagramPngBlob(renderSvg(SVG_SOURCE))).rejects.toThrow('does not decode')
  })

  it('throws when the canvas has no 2d context', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
    await expect(diagramPngBlob(renderSvg(SVG_SOURCE))).rejects.toThrow('no 2d context')
  })

  it('rejects when the png encoding yields no blob', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback: BlobCallback) => {
      callback(null)
    })
    await expect(diagramPngBlob(renderSvg(SVG_SOURCE))).rejects.toThrow('no PNG')
  })
})

describe('downloadBlob', () => {
  it('clicks a detached download anchor and revokes the object url', () => {
    const anchors: Array<Pick<HTMLAnchorElement, 'href' | 'download'>> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push({ href: this.href, download: this.download })
    })
    downloadBlob(new Blob(['x'], { type: 'image/png' }), DIAGRAM_PNG_FILENAME)
    expect(anchors).toEqual([{ href: 'blob:stub', download: DIAGRAM_PNG_FILENAME }])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:stub')
    expect(document.body.querySelector('a')).toBeNull()
  })

  it('names the vector fallback download', () => {
    expect(DIAGRAM_SVG_FILENAME).toBe('mermaid-diagram.svg')
    expect(DIAGRAM_PNG_FILENAME).toBe('mermaid-diagram.png')
  })
})
