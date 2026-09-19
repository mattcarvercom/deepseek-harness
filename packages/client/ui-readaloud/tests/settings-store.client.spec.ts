import { describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

import { ReadAloudPolicy } from '../src/client/settings-store.ts'
import { AUTO_READ_FIELD, type ReadAloudSettings } from '../src/readaloud-settings.ts'

/**
 * The narrow settings scope the policy observes and writes through, with a
 * controllable snapshot and a recording set() stand in for the durable
 * section.
 */
function makeHost(value: ReadAloudSettings | undefined) {
  const listeners = new Set<() => void>()
  let snapshot: SettingsScopeSnapshot<ReadAloudSettings> = {
    status: 'ready',
    value,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const set = vi.fn((_field: string, next: unknown) => {
    snapshot = { ...snapshot, value: { autoRead: next as boolean } }
    for (const listener of [...listeners]) listener()
    return Promise.resolve()
  })
  const host: SettingsScope<ReadAloudSettings> = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    mutate: vi.fn(),
    set,
    unset: vi.fn(),
  }
  return {
    host,
    set,
    publish: (value: ReadAloudSettings | undefined) => {
      snapshot = { ...snapshot, value }
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('ReadAloudPolicy', () => {
  it('defaults to off and works standalone without a scope', () => {
    const policy = new ReadAloudPolicy()
    expect(policy.autoRead.getSnapshot()).toBe(false)
    policy.setAutoRead(true)
    expect(policy.autoRead.getSnapshot()).toBe(true)
    policy.setAutoRead(false)
    expect(policy.autoRead.getSnapshot()).toBe(false)
  })

  it('adopts the scope\u2019s accepted value at construction without writing back', () => {
    const { host, set } = makeHost({ autoRead: true })
    const policy = new ReadAloudPolicy(host)
    expect(policy.autoRead.getSnapshot()).toBe(true)
    expect(set).not.toHaveBeenCalled()
  })

  it('publishes the live value before the durable write and does not write back the host echo', () => {
    const { host, set } = makeHost({ autoRead: false })
    const policy = new ReadAloudPolicy(host)
    expect(policy.autoRead.getSnapshot()).toBe(false)

    policy.setAutoRead(true)
    expect(policy.autoRead.getSnapshot()).toBe(true)
    expect(set).toHaveBeenCalledWith(AUTO_READ_FIELD, true)
    // The scope's echo of the same value is adopted, not re-written.
    expect(set).toHaveBeenCalledTimes(1)
    expect(policy.autoRead.getSnapshot()).toBe(true)
  })

  it('treats a same-value change as a no-op', () => {
    const { host, set } = makeHost({ autoRead: true })
    const policy = new ReadAloudPolicy(host)
    policy.setAutoRead(true)
    expect(set).not.toHaveBeenCalled()
    policy.setAutoRead(false)
    expect(set).toHaveBeenCalledWith(AUTO_READ_FIELD, false)
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('adopts scope emissions in both directions without writing back', () => {
    const { host, set, publish } = makeHost(undefined)
    const policy = new ReadAloudPolicy(host)
    expect(policy.autoRead.getSnapshot()).toBe(false)
    publish({ autoRead: true })
    expect(policy.autoRead.getSnapshot()).toBe(true)
    publish({ autoRead: false })
    expect(policy.autoRead.getSnapshot()).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('leaves the store when the section becomes absent', () => {
    const { host, publish } = makeHost({ autoRead: true })
    const policy = new ReadAloudPolicy(host)
    expect(policy.autoRead.getSnapshot()).toBe(true)
    publish(undefined)
    expect(policy.autoRead.getSnapshot()).toBe(true)
  })

  it('an equal-value emission neither writes back nor churns the store', () => {
    const { host, set, publish } = makeHost({ autoRead: true })
    const policy = new ReadAloudPolicy(host)
    const before = policy.autoRead.getSnapshot()
    publish({ autoRead: true })
    expect(set).not.toHaveBeenCalled()
    expect(policy.autoRead.getSnapshot()).toBe(before)
  })
})
