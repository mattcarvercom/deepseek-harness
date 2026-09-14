/**
 * The slot scan's tolerance for files that die between the glob listing and
 * the read: a concurrent spec worker deletes its short-lived `.ts` probes from
 * package src directories (the oxlint contract spec) while catalog specs scan
 * the real workspace. ENOENT skips the vanished file; any other read error
 * still fails the scan.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { scanSlotFiles } from './slot-walk.ts'

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: vi.fn(),
}))

const root = mkdtempSync(join(tmpdir(), 'slot-walk-'))

const SLOTS_SOURCE = `declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** A seat the demo owns. */
    'demo.seat': { kind: 'single' }
  }
}
`

const REGISTER_SOURCE = `import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

export function occupy(slots: SlotsService): void {
  slots.register({ name: 'demo.seat' }, 'DemoSeat')
}
`

const PROBE_SOURCE = `export function probe(): void {}
`

/** Every file the scan can read, by absolute path — the mock's only truth. */
const contents: Record<string, string> = {
  [join(root, 'packages/client/demo/package.json')]: JSON.stringify({ name: '@deepseek-ai/dsh-client-demo' }),
  [join(root, 'packages/client/demo/src/slots.ts')]: SLOTS_SOURCE,
  [join(root, 'packages/client/demo/src/register.ts')]: REGISTER_SOURCE,
  [join(root, 'packages/client/demo/src/probe.ts')]: PROBE_SOURCE,
}

for (const [path, text] of Object.entries(contents)) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/**
 * A read that answers from the table, throws `failure` for `failing`, and
 * reports ENOENT for everything else — the same shape Node itself reports,
 * which is also how the scan's manifest walk skips levels without a manifest.
 */
function readFromTable(failing: string | undefined, failure: Error | undefined): (path: unknown) => string {
  return (path: unknown) => {
    if (failure !== undefined && path === failing) throw failure
    if (typeof path === 'string' && contents[path] !== undefined) return contents[path]
    const missing = new Error(`ENOENT: no such file or directory, open '${String(path)}'`) as NodeJS.ErrnoException
    missing.code = 'ENOENT'
    throw missing
  }
}

describe('scanSlotFiles when a listed file vanishes mid-scan', () => {
  afterEach(() => {
    vi.mocked(readFileSync).mockReset()
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps every listed file that still exists, with its owning package', () => {
    vi.mocked(readFileSync).mockImplementation(readFromTable(undefined, undefined))
    const scanned = scanSlotFiles(root, ['packages/**/*.ts'])
    expect(scanned.map(file => file.rel)).toEqual([
      'packages/client/demo/src/register.ts',
      'packages/client/demo/src/slots.ts',
    ])
    expect(scanned.every(file => file.package === '@deepseek-ai/dsh-client-demo')).toBe(true)
  })

  it('skips a file deleted between the listing and the read', () => {
    const path = join(root, 'packages/client/demo/src/slots.ts')
    const gone = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException
    gone.code = 'ENOENT'
    vi.mocked(readFileSync).mockImplementation(readFromTable(path, gone))
    const scanned = scanSlotFiles(root, ['packages/**/*.ts'])
    expect(scanned.map(file => file.rel)).toEqual(['packages/client/demo/src/register.ts'])
    expect(scanned[0]?.package).toBe('@deepseek-ai/dsh-client-demo')
  })

  it('fails the scan when a listed file is unreadable for any reason other than deletion', () => {
    const path = join(root, 'packages/client/demo/src/register.ts')
    const failure = new Error(`EACCES: permission denied, open '${path}'`) as NodeJS.ErrnoException
    failure.code = 'EACCES'
    vi.mocked(readFileSync).mockImplementation(readFromTable(path, failure))
    let caught: unknown
    try {
      scanSlotFiles(root, ['packages/**/*.ts'])
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
  })
})
