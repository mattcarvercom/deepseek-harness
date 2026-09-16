import type { SubagentActivityKind } from '@deepseek-ai/dsh-subagent/client'

/**
 * One durable `subagent/activity` observation of a child run, keyed by the
 * delegating call's id on the consumer's session. Built purely from the
 * session event log, so a replayed session reconstructs the same record.
 */
export interface SubagentActivityFact {
  /** Coarse phase observed from the child run. */
  readonly kind: SubagentActivityKind
  /** Unix epoch ms from the `subagent/activity` session event. */
  readonly at: number
  /** Recorder-derived activity marker; display text is owned by the consumer. */
  readonly label: string
  /** Subagent provider name that produced the observation. */
  readonly provider: string
}

/**
 * Per-session map from delegating call id to its latest activity fact. Call
 * ids are `tool/call` identities; the map prunes an entry when the call's
 * `tool/result` lands, so it holds only in-flight delegations.
 */
export type SubagentActivityMap = Record<string, SubagentActivityFact>
