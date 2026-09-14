// Web e2e scenario: a `settings.yaml` left in the harness home by earlier releases is imported into the
// scaffold profile at start, through the shipped entries, and the imported values reach the page.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

// Opaque legacy value: the removed GUI testing notice validated this field
// against a current version, but the retained ui-settings-general field is
// now an unvalidated passthrough, so any imported string proves the migration.
const LEGACY_WELCOME_NOTICE_VERSION = '2026-08-13.1'

it('imports settings.yaml into the profile once and applies the imported values', async () => {
  const harnessHome = mkdtempSync(join(tmpdir(), 'dsh-settings-import-'))
  writeFileSync(join(harnessHome, 'settings.yaml'), [
    'ui-theme:', '  fontSize: 16',
    'ui-developer-tools:', '  enabled: false',
    'ui-onboarding:', `  welcomeNoticeVersion: '${LEGACY_WELCOME_NOTICE_VERSION}'`,
    '',
  ].join('\n'))
  const scaffold = await launchWebScaffold({ harnessHome })
  const browser = await chromium.launch()
  try {
    const patchPath = join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
    type Row = { id?: string; config?: Record<string, unknown> }
    const config = (id: string): Record<string, unknown> | undefined =>
      (yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema }) as Row[]).find(row => row.id === id)?.config
    await expect.poll(() => config('ui-theme')?.['fontSize'], { timeout: 10_000 }).toBe(16)
    expect(config('ui-settings')?.['enabled']).toBe(false)
    expect(config('ui-settings-general')?.['welcomeNoticeVersion']).toBe(LEGACY_WELCOME_NOTICE_VERSION)
    expect(existsSync(join(harnessHome, 'settings.yaml'))).toBe(false)
    expect(readFileSync(join(harnessHome, 'settings.yaml.imported'), 'utf8')).toContain('fontSize: 16')

    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size')), { timeout: 10_000 }).toBe('16px')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
