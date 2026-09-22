import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantMessage, AssistantMessageEvent, TextContent } from '@earendil-works/pi-ai'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const streamSimple = vi.hoisted(() => vi.fn())

// The content-idle deadline is armed at construction and reset only by real
// model content, so it can fire while the per-read idle watchdog is being
// re-armed by non-content wire traffic (pi-ai surfaces any SDK value as
// activity). The mock-server lane cannot isolate that tier: a comment-only
// stream yields no SDK values, so the idle tier trips first there. This spec
// mocks the SDK boundary directly, where a value stream without content is
// observable.
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const textContent = (text: string): TextContent => ({ type: 'text', text })

function assistantStub(content: TextContent[]): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'local-gateway',
    model: 'local-model',
    usage: {
      input: 1,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  }
}

/**
 * A pi-ai value stream that yields `delta` every `tickMs` until the signal
 * aborts, which rejects the pending yield. An empty `delta` models the
 * keep-alive-only wire traffic: values that carry no model content.
 */
async function* valueOnly(signal: AbortSignal, tickMs: number, delta: string): AsyncGenerator<AssistantMessageEvent> {
  for (;;) {
    await raceAbort(signal, tickMs)
    yield { type: 'text_delta', contentIndex: 0, delta, partial: assistantStub([]) }
  }
}

/** The same stream, emitting real content for `ticks` then terminating. */
async function* chatty(signal: AbortSignal, tickMs: number, ticks: number): AsyncGenerator<AssistantMessageEvent> {
  let text = ''
  for (let i = 0; i < ticks; i += 1) {
    await raceAbort(signal, tickMs)
    text += 'x'
    yield { type: 'text_delta', contentIndex: 0, delta: 'x', partial: assistantStub([textContent(text)]) }
  }
  yield { type: 'done', reason: 'stop', message: assistantStub([textContent(text)]) }
}

/** Resolves after `ms` or rejects immediately if the signal aborts first. */
async function raceAbort(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) throw new Error('pi-ai stream aborted')
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('pi-ai stream aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** A hand-declared OpenAI-compatible route with one fully described model. */
function gatewayAdapter(contentMs: number): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'local-gateway': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
        streamContentIdleTimeoutMs: contentMs,
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

async function drain(adapter: PiAiAdapter, signal?: AbortSignal): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'local-gateway',
    model: 'local-model',
    messages: [],
    ...signal === undefined ? {} : { signal },
  })) chunks.push(chunk)
  return chunks
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  streamSimple.mockReset()
})

describe('pi-ai stream content idle deadline', () => {
  it('fails a keep-alive-only stream when no content arrives before the content deadline', async () => {
    streamSimple.mockImplementation((_model, _context, options: { signal: AbortSignal }) => valueOnly(options.signal, 10, ''))
    const adapter = gatewayAdapter(33)

    const promise = drain(adapter)
    const rejection = expect(promise).rejects.toMatchObject({
      message: 'pi-ai stream content idle timeout after 33ms',
      code: 'TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(50)

    await rejection
  })

  it('keeps a stream alive past the content deadline while it keeps producing content', async () => {
    streamSimple.mockImplementation((_model, _context, options: { signal: AbortSignal }) => chatty(options.signal, 10, 5))
    const adapter = gatewayAdapter(30)

    const promise = drain(adapter)
    await vi.advanceTimersByTimeAsync(60)
    const chunks = await promise

    expect(chunks.slice(0, 5)).toEqual(
      Array.from({ length: 5 }, () => ({ type: 'text-delta', index: 0, text: 'x' })),
    )
    expect(chunks[5]).toMatchObject({ type: 'usage', usage: { inputTokens: 1, outputTokens: 5, totalTokens: 6 } })
    expect(chunks[6]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks).toHaveLength(7)
  })

  it('treats zero as opt-out and ends a caller-aborted stream with an aborted finish', async () => {
    streamSimple.mockImplementation((_model, _context, options: { signal: AbortSignal }) => valueOnly(options.signal, 10, ''))
    const adapter = gatewayAdapter(0)
    const caller = new AbortController()

    const promise = drain(adapter, caller.signal)
    await vi.advanceTimersByTimeAsync(5_000)
    caller.abort('test abort')
    const chunks = await promise

    // The stream streamed keep-alive values right up to the abort (one per
    // 10ms tick), then pi-ai delivered the termination in-band as an aborted
    // error event — never as a content-timeout failure.
    expect(chunks).toHaveLength(502)
    expect(chunks[0]).toMatchObject({ type: 'text-delta', index: 0, text: '' })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'ABORTED' } },
    })
  })
})
