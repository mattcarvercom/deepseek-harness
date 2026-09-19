import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const assetRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sanotts')

interface ManifestRow {
  path: string
  sha256: string
  bytes: number
}

/** The exact names the vendored set ships, split for the line length limit. */
const ASSET_NAME = new RegExp(
  '^(sanotts-web-0\\.3\\.0\\.tgz|index\\.js|snt_[a-z0-9_]+\\.(js|wasm|data)|' +
  'trellis_frontend\\.js|' +
  'voices\\/(heart|heartnano)\\/(meta\\.json|front_(f32|q8)\\.bin|model_(f32|q8)\\.bin)|' +
  'LICENSE-(GPL|MIT))$',
)

/** The MANIFEST.md `## Per-file sha256` table, one row per vendored asset. */
function readManifest(): ManifestRow[] {
  const text = readFileSync(join(assetRoot, 'MANIFEST.md'), 'utf8')
  return [...text.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|\s*([\d,]+)\s*\|\s*$/gm)]
    .map(row => ({
      path: row[1]!,
      sha256: row[2]!,
      bytes: Number(row[3]!.replace(/,/g, '')),
    }))
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name)
    return entry.isDirectory() ? walk(absolute) : [relative(assetRoot, absolute).split(sep).join('/')]
  })
}

describe('sanotts asset manifest', () => {
  it('lists a well-formed per-file table for the complete vendored set', () => {
    const rows = readManifest()
    expect(rows).toHaveLength(20)
    expect(new Set(rows.map(row => row.path)).size).toBe(20)
    for (const row of rows) {
      expect(row.path, row.path).toMatch(ASSET_NAME)
    }
  })

  it('covers exactly the files on disk, with no missing and no extra entries', () => {
    const onDisk = walk(assetRoot).filter(path => path !== 'MANIFEST.md').sort()
    const listed = readManifest().map(row => row.path).sort()
    expect(onDisk).toEqual(listed)
    expect(readManifest().some(row => row.path === 'MANIFEST.md')).toBe(false)
  })

  it('pins every file by sha256 and byte size', () => {
    for (const row of readManifest()) {
      const bytes = readFileSync(join(assetRoot, row.path))
      const digest = createHash('sha256').update(bytes).digest('hex')
      expect(digest, row.path).toBe(row.sha256)
      expect(bytes.byteLength, row.path).toBe(row.bytes)
    }
  })
})
