/**
 * Shared classification of child session events into the coarse
 * {@link SubagentActivityKind} that consumers record for UI phase display.
 * Kept apart from the service so session-event providers can map their
 * events without importing the registry.
 *
 * @module @deepseek-ai/dsh-subagent/activity
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentActivityKind } from './types.ts'

/**
 * Classify one child session event as the coarse child-run activity kind a
 * consumer records for UI phase display.
 * @param event - an event appended to the child's session.
 * @returns the activity kind.
 */
export function sessionEventActivityKind(event: SessionEvent): SubagentActivityKind {
  if (event.type === 'tool/call') return 'tool'
  if (event.type.startsWith('assistant/')) return 'output'
  return 'other'
}
