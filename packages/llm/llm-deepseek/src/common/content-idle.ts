/** Content-idle bound shared by the DeepSeek wire protocols. */
import { isTokenDelta, LlmError } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { progressDeadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ProgressDeadline } from '@deepseek-ai/dsh-timeout'

/** Abort reason code for a content-idle trip; the protocols map it to a retryable `TIMEOUT`. */
export const STREAM_CONTENT_IDLE_TIMEOUT_CODE = 'LLM_STREAM_CONTENT_IDLE_TIMEOUT'

/**
 * Arm the content-idle bound for one stream: the returned deadline's signal
 * must travel with the request so a trip aborts the underlying read.
 */
export function contentIdleDeadline(
  callerSignal: AbortSignal | undefined,
  streamContentIdleTimeoutMs: number,
): ProgressDeadline {
  return progressDeadline(callerSignal, streamContentIdleTimeoutMs, STREAM_CONTENT_IDLE_TIMEOUT_CODE)
}

/**
 * Forward one protocol stream while re-arming the content deadline on every
 * model content chunk. A trip aborts the request signal and surfaces as a
 * `TIMEOUT` failure, so the configured retry policy engages; a caller abort
 * keeps its `ABORTED` classification.
 */
export async function* boundByContentProgress(
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
