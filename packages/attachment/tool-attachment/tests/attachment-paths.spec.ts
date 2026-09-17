import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as toolAttachment from '../src/index.ts'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)

const signal = new AbortController().signal

/** Joined text of one executed tool result. */
function textOf(result: ToolExecutionResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
}

let home: string
let ctx: Context

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'tool-attachment-'))
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(toolAttachment)
})

afterAll(async () => {
  if (ctx !== undefined) await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
})

describe('attachment_paths', () => {
  it('registers only while the attachment store is mounted', async () => {
    expect(ctx.tools.get('attachment_paths')).toBeDefined()
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(ToolRuntime)
    await bare.plugin(toolAttachment)
    expect(bare.tools.get('attachment_paths')).toBeUndefined()
    await bare.fiber.dispose()
  })

  it('returns host paths for the latest human message carrying images and files', async () => {
    const [imageRef] = await ctx.attachments.saveImages([{
      data: PNG_1X1,
      mediaType: 'image/png',
      name: 'photo.png',
    }])
    const fileRef = await ctx.attachments.saveFile({ data: new Uint8Array([1, 2, 3]), name: 'clip.mp4' })
    const session = ctx.sessions.create(SessionId('s1'))
    session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: 'edit this' },
        { type: 'image', attachment: imageRef! },
        { type: 'file', attachment: fileRef },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const result = await ctx.tools.execute({
      signal,
      agent: { session } as never,
      callId: ToolCallId('c1'),
      name: 'attachment_paths',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    const imagePath = ctx.attachments.imageHostPath(imageRef!)
    const filePath = ctx.attachments.fileHostPath(fileRef)
    expect(imagePath).toBeDefined()
    expect(filePath).toBeDefined()
    const text = textOf(result)
    expect(text).toContain(imagePath!)
    expect(text).toContain(filePath!)
    expect(text).toContain('photo.png')
    expect(text).toContain('clip.mp4')
    expect(existsSync(imagePath!)).toBe(true)
    expect(existsSync(filePath!)).toBe(true)
  })

  it('reports no attachments when recent human messages carry none', async () => {
    const session = ctx.sessions.create(SessionId('s2'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'no attachments here' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const result = await ctx.tools.execute({
      signal,
      agent: { session } as never,
      callId: ToolCallId('c2'),
      name: 'attachment_paths',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('No attachments found')
  })
})
