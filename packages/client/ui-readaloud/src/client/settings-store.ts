/**
 * The auto-read preference shared by the assistant-message read-aloud
 * entries and the General Settings row: one live snapshot store, backed by
 * the durable `ui-readaloud` settings section when a Host settings service is
 * composed.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/settings-store
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { AUTO_READ_FIELD, type ReadAloudSettings } from '../readaloud-settings.ts'

/** Auto-read stays off until the user turns it on in Settings. */
export const DEFAULT_AUTO_READ = false

/**
 * One live store the message entries and the Settings row read, mirroring
 * the ComposerSubmissionPolicy adoption pattern.
 */
export class ReadAloudPolicy {
  /** Reactive auto-read preference. */
  readonly autoRead: SnapshotStore<boolean> = createSnapshotStore(DEFAULT_AUTO_READ)
  private readonly host: SettingsScope<ReadAloudSettings> | undefined

  /**
   * @param host - durable preference scope owned by the settings plugin;
   * absent compositions stay process-local. The adoption subscription shares
   * the scope's lifetime — a disposed scope never publishes again.
   */
  constructor(host?: SettingsScope<ReadAloudSettings>) {
    this.host = host
    if (host !== undefined) {
      host.subscribe(() => { this.adopt(host) })
      this.adopt(host)
    }
  }

  /**
   * Change the auto-read preference; the live value publishes before the
   * durable write starts.
   * @param value - the new auto-read state.
   */
  setAutoRead(value: boolean): void {
    if (this.autoRead.getSnapshot() === value) return
    this.autoRead.set(value)
    void this.host?.set(AUTO_READ_FIELD, value)
  }

  /**
   * Adopt the scope's accepted durable value without writing it back.
   * @param host - the constructor-narrowed scope driving this adoption.
   */
  private adopt(host: SettingsScope<ReadAloudSettings>): void {
    const section = host.getSnapshot().value
    if (section === undefined || this.autoRead.getSnapshot() === section.autoRead) return
    this.autoRead.set(section.autoRead)
  }
}
