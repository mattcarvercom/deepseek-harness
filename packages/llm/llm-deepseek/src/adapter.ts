/** Select a DeepSeek wire implementation from one validated configuration generation. */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { isTokenDelta, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import { progressDeadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ProgressDeadline } from '@deepseek-ai/dsh-timeout'
import type { DeepSeekAdapterOptions } from './common/types.ts'
import { ChatCompletionsAdapter } from './protocols/chat-completions/adapter.ts'
import { DeepSeekFileStore } from './common/file-store.ts'
import { DeepSeekMessagesAdapter } from './protocols/messages/adapter.ts'

/** Abort reason code for a content-idle trip; the adapter maps it to a retryable `TIMEOUT`. */
const STREAM_CONTENT_IDLE_TIMEOUT_CODE = 'LLM_STREAM_CONTENT_IDLE_TIMEOUT'

/** One provider route with protocol-local transport and shared credentials and model configuration. */
export class DeepSeekAdapter extends LlmAdapter {
  private readonly files: DeepSeekFileStore

  constructor(private readonly dependencies: DeepSeekAdapterOptions) {
    super()
    this.files = dependencies.resolveFiles?.() ?? new DeepSeekFileStore()
  }

  private implementation(): LlmAdapter {
    const connection = this.dependencies.options()
    switch (connection.protocol) {
      case 'messages':
        return new DeepSeekMessagesAdapter({
          connection: () => connection,
          apiKey: this.dependencies.resolveApiKey,
          userId: this.dependencies.resolveUserId,
          attachments: () => this.dependencies.resolveAttachments?.(),
          imageAccess: (ref) => {
            const attachments = this.dependencies.resolveAttachments?.()
            return attachments === undefined ? undefined : this.dependencies.resolveImageAccess?.(attachments, ref)
          },
          files: () => this.files,
          prepareExtensions: this.dependencies.prepareExtensions,
          ...this.dependencies.onReplayDegrade === undefined ? {} : { onReplayDegrade: this.dependencies.onReplayDegrade },
        })
      case 'chat-completions':
        return new ChatCompletionsAdapter({ ...this.dependencies, options: () => connection, resolveFiles: () => this.files })
      /* v8 ignore next -- protocol is validated at configuration resolution. */
      default: return assertNever(connection.protocol, 'DeepSeek protocol')
    }
  }

  override providerInfo(provider: string) { return this.implementation().providerInfo(provider) }
  override providerRetryPolicy(provider: string) { return this.implementation().providerRetryPolicy(provider) }
  override listModels(provider: string) { return this.implementation().listModels(provider) }
  override resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return this.implementation().resolveModel(provider, model, signal)
  }
  override imageRequestPricing(provider: string, model: string) {
    return this.implementation().imageRequestPricing(provider, model)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await this.implementation().prepareCall(provider, model, signal)
    // Route the prepared call through this adapter's stream so the content-idle
    // bound covers the production path as well as direct `stream()` calls.
    return { ...prepared, stream: options => this.stream(options) }
  }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.dependencies.options()
    const progress = progressDeadline(
      options.signal,
      connection.streamContentIdleTimeoutMs,
      STREAM_CONTENT_IDLE_TIMEOUT_CODE,
    )
    const upstream = this.implementation().stream({ ...options, signal: progress.signal })
    return DeepSeekAdapter.boundByContentProgress(
      upstream,
      progress,
      connection.streamContentIdleTimeoutMs,
      options.signal,
    )
  }

  /**
   * Forward one protocol stream while re-arming the content deadline on every
   * model content chunk. A trip aborts the request signal and surfaces as a
   * `TIMEOUT` failure, so the configured retry policy engages; a caller abort
   * keeps its `ABORTED` classification.
   */
  private static async * boundByContentProgress(
    upstream: AsyncIterable<StreamChunk>,
    progress: ProgressDeadline,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): AsyncIterable<StreamChunk> {
    using deadline = progress
    try {
      for await (const chunk of upstream) {
        if (isTokenDelta(chunk)) deadline.progress()
        yield chunk
      }
    } catch (error: unknown) {
      if (timeoutOf(deadline.signal, STREAM_CONTENT_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `DeepSeek stream content idle timeout after ${timeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (callerSignal?.aborted) throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError('DeepSeek API stream failed', 'TRANSPORT', { cause: error })
    }
  }
}
