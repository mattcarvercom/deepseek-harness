import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/markdown-mermaid', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/markdown-mermaid/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'markdown-mermaid-web-e2e'
const DONE = 'MERMAID_RENDERING_DONE'

/** Build a settled assistant reply with one valid mermaid fence and one that does not parse. */
function mermaidFixture(): string {
  const session = Session.create(SessionId('markdown-mermaid-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', {
    turn: 1,
  })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Draw this flow as a diagram.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Mermaid rendering',
    messageSeqs: [user.seq],
    source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{
        type: 'text',
        text: [
          '## Mermaid diagrams',
          '',
          'A valid flowchart:',
          '',
          '```mermaid',
          'flowchart LR',
          '  A[Start] --> B{Decision}',
          '  B -->|yes| C[Done]',
          '```',
          '',
          'This one does not parse:',
          '',
          '```mermaid',
          'flowchart LR',
          '  A -->',
          '```',
          '',
          DONE,
        ].join('\n'),
      }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: '{{sessionId}}',
      createdAt: 0,
      isSeeded: false,
      delegationDepth: 0,
      cwd: '{{cwd}}',
    }),
    ...session.snapshotEvents().map(event => JSON.stringify({
      ...event,
      time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: settled Markdown mermaid rendering', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, mermaidFixture(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('renders the settled reply with a diagram and a parse failure', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-mermaid'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)

    // The valid fence draws as an SVG once the lazy mermaid chunk loads.
    await expect.poll(
      () => page.locator('svg[aria-roledescription^="flowchart"]').count(),
      { timeout: 30_000 },
    ).toBe(1)
    // The unparseable fence keeps its source in a code block with the failure line.
    await expect.poll(
      () => page.getByText('Could not render the Mermaid diagram', { exact: false }).count(),
      { timeout: 15_000 },
    ).toBe(1)
    expect(await page.locator('pre code').filter({ hasText: 'flowchart LR' }).count()).toBe(1)
    await expect.poll(
      () => page.getByText('1 turns · 1 steps', { exact: false }).count(),
      { timeout: 10_000 },
    ).toBe(1)

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 90_000)
})
