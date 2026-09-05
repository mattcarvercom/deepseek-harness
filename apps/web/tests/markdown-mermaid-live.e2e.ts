// Keyless assembled-Web evidence that mermaid fences streamed live on an open
// page settle into drawn diagrams across a multi-turn session: each diagram
// turn — including every turn after the first — ends as an SVG, not a code
// block, with plain-text turns interleaved between them.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import {
  launchWebScaffold,
  watchConsole,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const PROVIDER = 'markdown-mermaid-live-test'
const MODEL = 'mermaid-live'

const REPLIES = [
  // Turn 1: plain text, no fences.
  'Just text, nothing fancy here.',
  // Turn 2: first diagram — flowchart.
  'Here you go:\n\n```mermaid\nflowchart TD\n    A([Start]) --> B[Check]\n    B --> C([Done])\n```\n\nThat is the first one.',
  // Turn 3: plain text between diagrams.
  'Understood. Ready for the next one.',
  // Turn 4: second diagram — sequence.
  'Here is the sequence:\n\n```mermaid\nsequenceDiagram\n    actor C as Client\n    participant S as Server\n    C->>S: hello\n    S-->>C: hi\n```\n\nSecond one done.',
  // Turn 5: third diagram — state.
  'And a state chart:\n\n```mermaid\nstateDiagram-v2\n    [*] --> Idle\n    Idle --> Busy : start\n    Busy --> Idle : stop\n    Idle --> [*]\n```\n\nAll done.',
]

/** Scripted deterministic reply per turn; holds mid-stream so the fence is
 *  observably a code block before the turn settles. */
class MermaidLiveAdapter extends LlmAdapter {
  private calls = 0

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    const reply = REPLIES[Math.min(this.calls - 1, REPLIES.length - 1)]
    if (reply === undefined) throw new Error(`markdown mermaid live adapter got an unplanned model call ${this.calls}`)
    const half = Math.max(1, Math.floor(reply.length / 2))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply.slice(0, half) }
    await new Promise<void>((resolve) => { setTimeout(resolve, 1_000) })
    if (options.signal?.aborted === true) throw options.signal.reason
    yield { type: 'text-delta', index: 0, text: reply.slice(half) }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('web e2e: live streamed mermaid fences settle into diagrams', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const adapter = new MermaidLiveAdapter()

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'markdown mermaid live adapter',
    )
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('draws every diagram turn, including the ones after the first and after plain-text turns', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-mermaid-live'))
    const input = page.locator('[data-composer-input]').first()
    const prompts = ['hi', 'give me a sample flowchart', 'ok', 'a sequence diagram now', 'and a state chart']

    for (const prompt of prompts) {
      const settled = scaffold.whenTurnSettled(30_000)
      await writeComposerDraft(page, input, prompt)
      await input.press('Enter')
      await settled
    }

    await expect.poll(() => page.locator('[data-streaming="true"]').count(), { timeout: 10_000 }).toBe(0)
    // Renders settle asynchronously after the projection clears; poll for the
    // final drawn state of each diagram type.
    await expect.poll(() => page.locator('svg[aria-roledescription^="flowchart"]').count(), { timeout: 20_000 }).toBe(1)
    await expect.poll(() => page.locator('svg[aria-roledescription^="sequence"]').count(), { timeout: 20_000 }).toBe(1)
    await expect.poll(() => page.locator('svg[aria-roledescription^="state"]').count(), { timeout: 20_000 }).toBe(1)
    expect(await page.locator('svg[aria-roledescription]').count()).toBe(3)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
