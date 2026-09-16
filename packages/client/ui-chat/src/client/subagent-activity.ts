/** Per-session subagent-activity fold over the session's event window. */
import type {
  SessionEventLikeEntry, SessionEventSource, SessionEventWindow,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
// The `subagent/activity` SessionEventMap merge lives with the tool that emits it.
import type {} from '@deepseek-ai/dsh-tool-subagent/types'
import type { SubagentActivityMap } from './contract/subagent-activity.ts'

/**
 * Fold one event-window entry into the activity map.
 *
 * A `subagent/activity` upserts the latest fact under the delegating call id;
 * a `tool/result` for that call prunes the entry, so the map holds only
 * in-flight delegations. Every other entry leaves the map untouched.
 *
 * @param map - map to mutate.
 * @param entry - one durable or transient window entry, in log order.
 * @returns whether the map changed.
 */
export function applySubagentActivity(
  map: SubagentActivityMap,
  entry: SessionEventLikeEntry,
): boolean {
  if (entry.type !== 'event') return false
  switch (entry.event.type) {
    case 'subagent/activity': {
      const { callId, kind, label, provider, childSessionId } = entry.event.data
      const at = entry.event.time
      const current = map[callId]
      if (
        current !== undefined
        && current.at === at
        && current.kind === kind
        && current.label === label
        && current.provider === provider
        && current.childSessionId === childSessionId
      ) {
        return false
      }
      // The key mirrors the event payload: present for latched local runs,
      // absent otherwise (never an explicit undefined).
      map[callId] = {
        at, kind, label, provider,
        ...childSessionId !== undefined ? { childSessionId } : {},
      }
      return true
    }
    case 'tool/result': {
      const callId = entry.event.data.message.source.callId
      if (!(callId in map)) return false
      // oxlint-disable-next-line typescript/no-dynamic-delete -- the map is a plain call-id record; pruning is its only removal path
      delete map[callId]
      return true
    }
    default:
      return false
  }
}

/**
 * Rebuild the activity map from a full event window.
 * @param entries - the window entries, in ascending seq order.
 * @returns a fresh map holding the in-flight delegation facts.
 */
export function rebuildSubagentActivity(entries: readonly SessionEventLikeEntry[]): SubagentActivityMap {
  const map: SubagentActivityMap = {}
  for (const entry of entries) applySubagentActivity(map, entry)
  return map
}

/**
 * Session-scoped activity feed: follows one Session's event window and
 * publishes the activity map through a snapshot store. The store snapshot is
 * reference-stable between changes; a window replace or prepend rescan-folds
 * the whole window in log order, which keeps replayed sessions identical to
 * live ones.
 */
export class SubagentActivityFeed {
  /** Published map; the same snapshot reference until the map moves. */
  readonly store: SnapshotStore<SubagentActivityMap>
  private map: SubagentActivityMap = {}
  private revision = -1
  private disposed = false
  private unsubscribe: () => void

  constructor(feed: SessionEventSource) {
    this.store = createSnapshotStore(this.map)
    this.replace(feed.getSnapshot())
    this.unsubscribe = feed.subscribe(() => {
      this.accept(feed.getSnapshot())
    })
  }

  /** Stop following the event window. Idempotent: session release and plugin fiber teardown may both dispose. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
  }

  private replace(window: SessionEventWindow): void {
    this.revision = window.revision
    this.map = rebuildSubagentActivity(window.entries)
    this.store.set(this.map)
  }

  private accept(window: SessionEventWindow): void {
    if (window.revision === this.revision) return
    if (
      window.revision !== this.revision + 1
      || window.change.kind === 'replace'
      || window.change.kind === 'prepend'
    ) {
      this.replace(window)
      return
    }
    this.revision = window.revision
    if (window.change.kind === 'append') this.applyEntries(window.change.entries)
  }

  private applyEntries(entries: readonly SessionEventLikeEntry[]): void {
    const map: SubagentActivityMap = { ...this.map }
    let changed = false
    for (const entry of entries) {
      if (applySubagentActivity(map, entry)) changed = true
    }
    if (changed) {
      this.map = map
      this.store.set(map)
    }
  }
}
