import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'

import { apply } from '../src/index.ts'
import { READALOUD_SETTINGS_NAMESPACE, ReadAloudSettingsSchema } from '../src/readaloud-settings.ts'

/** In-memory settings provider with a persist log, after the settings package fixture. */
class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown>
  readonly persisted: Array<{ ns: SettingsNamespace; section: Record<string, unknown> }> = []
  readonly writable = true

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.persisted.push({ ns, section: structuredClone(section) })
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

async function boot(doc?: Record<string, unknown>) {
  const ctx = new Context()
  const fiber = ctx.plugin(MemorySettings, doc === undefined ? {} : { doc })
  await fiber
  const settings = ctx.get('settings') as MemorySettings
  return { ctx, settings }
}

describe('ui-readaloud node half', () => {
  it('registers the namespace and resolves the autoRead default over an empty document', async () => {
    const { ctx } = await boot()
    const fiber = ctx.plugin(apply)
    await fiber
    expect(ctx.settings.get(READALOUD_SETTINGS_NAMESPACE)).toEqual({ autoRead: false })
  })

  it('resolves a stored section over the schema default', async () => {
    const { ctx } = await boot({ [READALOUD_SETTINGS_NAMESPACE]: { autoRead: true } })
    const fiber = ctx.plugin(apply)
    await fiber
    expect(ctx.settings.get(READALOUD_SETTINGS_NAMESPACE)).toEqual({ autoRead: true })
  })

  it('fails the registration when the stored section is invalid for the schema', async () => {
    const { ctx } = await boot({ [READALOUD_SETTINGS_NAMESPACE]: { autoRead: 'nope' } })
    expect(() => ctx.settings.register(READALOUD_SETTINGS_NAMESPACE, ReadAloudSettingsSchema)).toThrow()
  })

  it('rejects a second registration of the namespace', async () => {
    const { ctx } = await boot()
    const fiber = ctx.plugin(apply)
    await fiber
    expect(() => ctx.settings.register(READALOUD_SETTINGS_NAMESPACE, ReadAloudSettingsSchema))
      .toThrow(/already registered/)
  })

  it('persists an update through the provider', async () => {
    const { ctx, settings } = await boot()
    const fiber = ctx.plugin(apply)
    await fiber
    await ctx.settings.update(READALOUD_SETTINGS_NAMESPACE, { autoRead: true })
    expect(ctx.settings.get(READALOUD_SETTINGS_NAMESPACE)).toEqual({ autoRead: true })
    expect(settings.persisted).toEqual([{ ns: READALOUD_SETTINGS_NAMESPACE, section: { autoRead: true } }])
  })

  it('removes the registration when the registrant fiber disposes', async () => {
    const { ctx } = await boot()
    const fiber = ctx.plugin(apply)
    await fiber
    expect(ctx.settings.get(READALOUD_SETTINGS_NAMESPACE)).toBeDefined()

    await fiber.dispose()
    expect(ctx.settings.get(READALOUD_SETTINGS_NAMESPACE)).toBeUndefined()
    expect(ctx.settings.describe()).toEqual([])

    // The namespace is free again; re-registering it must succeed.
    ctx.settings.register(READALOUD_SETTINGS_NAMESPACE, ReadAloudSettingsSchema)
  })
})
