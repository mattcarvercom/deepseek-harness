/**
 * Browser-safe subagent projection and control vocabulary.
 *
 * @module @deepseek-ai/dsh-subagent/client
 */

export type * from './control-types.ts'
export type {
  SubagentCatalogEntry, SubagentIdentityProjection, SubagentTimingProjection,
} from './projection-types.ts'
/** Coarse activity phase of a running child, for durable UI phase display. */
export type { SubagentActivityKind } from './projection-types.ts'
