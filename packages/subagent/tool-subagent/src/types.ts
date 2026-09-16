/**
 * Browser-safe durable subagent-activity event written by the model-facing
 * subagent tool into its calling parent Session. It records the throttled
 * coarse activity phase of a live child run for in-flight UI phase display;
 * the event is not model-visible.
 *
 * @module @deepseek-ai/dsh-tool-subagent/types
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SubagentActivityKind } from '@deepseek-ai/dsh-subagent/client'

/** One throttled observation of a live child's coarse activity phase. */
export interface SubagentActivityData {
  /** The calling tool call that owns this record stream. */
  readonly callId: ToolCallId
  /** The `ctx.subagents` provider name that produced the observation. */
  readonly provider: string
  /** The coarse phase: streamed model output, tool use, or unclassified. */
  readonly kind: SubagentActivityKind
  /** The delegation's short description, truncated to its display bound. */
  readonly label: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records one throttled observation of a live child's coarse activity
     * phase against the calling tool call. UI-only; never model-visible.
     * @param data - the record payload.
     */
    'subagent/activity': SubagentActivityData
  }
}
