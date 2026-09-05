/**
 * Image export for a settled mermaid diagram: serializes the rendered SVG at
 * a fixed pixel size, rasterizes it to a PNG blob, and offers the download
 * path the copy-image control uses when the clipboard rejects an image write
 * or the host cannot rasterize at all.
 */

/** Suggested file name for a rasterized diagram download. */
export const DIAGRAM_PNG_FILENAME = 'mermaid-diagram.png'

/** Suggested file name for the vector diagram fallback download. */
export const DIAGRAM_SVG_FILENAME = 'mermaid-diagram.svg'

/**
 * Serialize one rendered diagram SVG as standalone document text.
 *
 * Mermaid emits `width="100%"` plus an inline `style`, neither of which gives
 * the SVG an intrinsic size in an `<img>` context; this strips both and pins
 * explicit `width`/`height` attributes to the diagram's viewBox dimensions so
 * the image decodes at its natural pixel size.
 * @param svg - The rendered diagram element.
 * @returns The standalone SVG document text.
 */
export function diagramSvgText(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.removeAttribute('style')
  const box = svg.viewBox.baseVal
  const width = box.width > 0 ? box.width : Math.max(1, Math.round(svg.getBoundingClientRect().width))
  const height = box.height > 0 ? box.height : Math.max(1, Math.round(svg.getBoundingClientRect().height))
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return new XMLSerializer().serializeToString(clone)
}

/**
 * Rasterize one rendered diagram SVG into a PNG blob at its pixel size.
 * @param svg - The rendered diagram element.
 * @returns A promise for the PNG blob.
 * @throws When the SVG does not decode as an image, the canvas has no 2d
 *   context, or the PNG encoding yields no blob.
 */
export async function diagramPngBlob(svg: SVGSVGElement): Promise<Blob> {
  const objectUrl = URL.createObjectURL(new Blob([diagramSvgText(svg)], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const image = await loadImage(objectUrl)
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('the canvas has no 2d context')
    context.drawImage(image, 0, 0)
    return await canvasPngBlob(canvas)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Load a blob-URL SVG as an image element.
 * @param url - The object URL of the serialized SVG.
 * @returns A promise for the loaded image, rejecting when it does not decode.
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      resolve(image)
    }
    image.onerror = () => {
      reject(new Error('the diagram SVG does not decode as an image'))
    }
    image.src = url
  })
}

/**
 * Encode a canvas as a PNG blob.
 * @param canvas - The rasterized diagram.
 * @returns A promise for the PNG blob, rejecting when the host yields none.
 */
function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('the canvas encoded no PNG'))
      else resolve(blob)
    }, 'image/png')
  })
}

/**
 * Trigger a browser download of one blob under a file name.
 * @param blob - The content to download.
 * @param filename - The suggested file name.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
