// @vitest-environment jsdom
/**
 * The assembled-client composition of ui-readaloud: the three seats it fills
 * in the real webApp roster, the auto-read preference over the settings mirror
 * (adoption never writes back), the per-session playback faces over the
 * shared director, and disposal and re-registration across its own Loader
 * rebuild. The production module loader is rejected in this environment, so
 * no bench synthesis ever completes; a stubbed AudioContext records the
 * shared context's lifecycle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, vi } from 'vitest'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  createClientTest, type TestClient, webApp,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { inject } from '../src/client/index.ts'
import { AutoReadToggle } from '../src/client/AutoReadToggle.tsx'
import { ReadAloudActions, ReadAloudStepActions } from '../src/client/ReadAloudActions.tsx'
import { SessionIndicator } from '../src/client/SessionIndicator.tsx'
import { StopSpeakingButton } from '../src/client/StopSpeakingButton.tsx'
import { StreamHighlightBridge } from '../src/client/StreamHighlightBridge.tsx'
import { StreamingNarrator } from '../src/client/StreamingNarrator.tsx'
import { ReadAloudSettingsRow } from '../src/client/ReadAloudSettingsRow.tsx'
import { INITIAL_READALOUD_PLAYBACK } from '../src/client/director.ts'
import type {
  ReadAloudActionInjected, ReadAloudIndicatorInjected, ReadAloudSettingsRowInjected,
  ReadAloudStopInjected, ReadAloudStreamHighlightInjected, ReadAloudStreamInjected,
  ReadAloudToggleInjected,
} from '../src/client/slots.ts'
import {
  READALOUD_SETTINGS_NAMESPACE, ReadAloudSettingsSchema, type ReadAloudSettings,
} from '../src/readaloud-settings.ts'

const SELF = '@deepseek-ai/dsh-client-ui-readaloud'
/** One minimal speakable block; these benches never reach the engine. */
const SPEAK_BLOCKS = [{ blockIndex: 0, text: 'hello', segments: [] }] as const
const it = createClientTest({ roster: webApp })
/** The whole roster's first boot pays the cold module transform of every plugin package. */
const COLD_BOOT_TIMEOUT_MS = 60_000
/** Dictionary namespace this plugin owns; both seats it fills declare it. */
const NS = 'readaloud'

/**
 * Page-global WebAudio stub: bench syntheses never complete, so no source is
 * ever created — only the shared context's creation and close are observed.
 */
class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = []
  readonly state = 'running'
  readonly destination = {}
  closed = false
  constructor() {
    FakeAudioContext.instances.push(this)
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
  createBuffer(): never {
    throw new Error('bench syntheses never produce a source')
  }
  createBufferSource(): never {
    throw new Error('bench syntheses never produce a source')
  }
}

beforeAll(() => {
  vi.stubGlobal('AudioContext', FakeAudioContext)
})
afterAll(() => {
  vi.unstubAllGlobals()
})
beforeEach(() => {
  FakeAudioContext.instances.length = 0
})

/** One Host view of the read-aloud section, including its revision fence. */
function readaloudView(section: ReadAloudSettings, revision = 1): SettingsNamespaceView {
  return {
    ns: READALOUD_SETTINGS_NAMESPACE,
    // The Remote wire serializes the schema and stored values before the client rehydrates them.
    schema: JSON.parse(JSON.stringify(ReadAloudSettingsSchema.toJSON())) as SettingsNamespaceView['schema'],
    value: JSON.parse(JSON.stringify(section)) as SettingsNamespaceView['value'],
    applies: 'live',
    secrets: [],
    revision,
  }
}

async function client(mock: RemoteMock, start: () => Promise<TestClient>, section: ReadAloudSettings | undefined) {
  const settings = mock.remote.settings
  settings.describe.mockResolvedValue(ok({
    writable: true,
    hasDocument: section !== undefined,
    namespaces: section === undefined ? [] : [readaloudView(section)],
  }))
  // Echo the auto-read choice back the way a writable Host document would.
  settings.mutate.mockImplementation((ns, ops, _expectedRevision) => {
    if (ns !== READALOUD_SETTINGS_NAMESPACE) {
      return Promise.reject(new Error(`bench did not expect a settings/mutate for ${ns}`))
    }
    let autoRead = false
    for (const op of ops) {
      if (op.op === 'set' && op.path[0] === 'autoRead') autoRead = op.value === true
    }
    return Promise.resolve(ok(readaloudView({ autoRead })))
  })
  const c = await start()
  await c.ctx.settingsScope.describe().ensure()
  return { c, settings }
}

function actionEntry(c: TestClient) {
  return c.ctx.slots.entries('conversation.chat.assistant-actions').find(entry => entry.component === ReadAloudActions)!
}

function stepEntry(c: TestClient) {
  return c.ctx.slots.entries('conversation.chat.step-actions').find(entry => entry.component === ReadAloudStepActions)!
}

function indicatorEntry(c: TestClient) {
  return c.ctx.slots.entries('sidebar.session.indicator').find(entry => entry.component === SessionIndicator)!
}

function bridgeEntry(c: TestClient) {
  return c.ctx.slots.entries('conversation.chat.stream-actions').find(entry => entry.component === StreamHighlightBridge)!
}

function bridgeFace(c: TestClient, sessionId: SessionId): ReadAloudStreamHighlightInjected {
  return (bridgeEntry(c).inject as unknown as (id: SessionId) => ReadAloudStreamHighlightInjected)(sessionId)
}

function narratorEntry(c: TestClient) {
  return c.ctx.slots.entries('conversation.input.left').find(entry => entry.component === StreamingNarrator)!
}

function stopEntry(c: TestClient) {
  return c.ctx.slots.entries('conversation.input.left').find(entry => entry.component === StopSpeakingButton)!
}

function toggleEntry(c: TestClient) {
  return c.ctx.slots.entries('conversation.input.left').find(entry => entry.component === AutoReadToggle)!
}

function rowEntry(c: TestClient) {
  return c.ctx.slots.entries('settings.general.item').find(entry => entry.component === ReadAloudSettingsRow)!
}

function actionFace(c: TestClient, sessionId: SessionId): ReadAloudActionInjected {
  return (actionEntry(c).inject as unknown as (id: SessionId) => ReadAloudActionInjected)(sessionId)
}

function stepFace(c: TestClient, sessionId: SessionId): ReadAloudActionInjected {
  return (stepEntry(c).inject as unknown as (id: SessionId) => ReadAloudActionInjected)(sessionId)
}

function indicatorFace(c: TestClient): ReadAloudIndicatorInjected {
  return (indicatorEntry(c).inject as unknown as () => ReadAloudIndicatorInjected)()
}

function narratorFace(c: TestClient, sessionId: SessionId): ReadAloudStreamInjected {
  return (narratorEntry(c).inject as unknown as (id: SessionId) => ReadAloudStreamInjected)(sessionId)
}

function stopFace(c: TestClient, sessionId: SessionId): ReadAloudStopInjected {
  return (stopEntry(c).inject as unknown as (id: SessionId) => ReadAloudStopInjected)(sessionId)
}

function toggleFace(c: TestClient): ReadAloudToggleInjected {
  return (toggleEntry(c).inject as unknown as () => ReadAloudToggleInjected)()
}

function rowFace(c: TestClient): ReadAloudSettingsRowInjected {
  return (rowEntry(c).inject as unknown as () => ReadAloudSettingsRowInjected)()
}

/** This plugin's writes to the settings mirror, ignoring any other namespace. */
function ownMutateCalls(settings: RemoteMock['remote']['settings']) {
  return settings.mutate.mock.calls.filter(([ns]) => ns === READALOUD_SETTINGS_NAMESPACE)
}

describe('ui-readaloud in the assembled client', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
  })

  it('fills the assistant-actions and Settings seats with one shared preference', async ({ mock, start }) => {
    const { c } = await client(mock, start, undefined)

    const action = actionEntry(c)
    expect(action.locale).toBe(NS)
    expect(action.options).toMatchObject({ id: 'readaloud', order: 30 })
    const step = stepEntry(c)
    expect(step.locale).toBe(NS)
    expect(step.options).toMatchObject({ id: 'readaloud', order: 30 })
    const indicator = indicatorEntry(c)
    expect(indicator.locale).toBe(NS)
    const bridge = bridgeEntry(c)
    expect(bridge.locale).toBe(NS)
    const narrator = narratorEntry(c)
    expect(narrator.locale).toBe(NS)
    expect(narrator.options).toMatchObject({ id: 'readaloud-narrator', order: 31 })
    const toggle = toggleEntry(c)
    expect(toggle.locale).toBe(NS)
    expect(toggle.options).toMatchObject({ id: 'readaloud', order: 30 })
    const stop = stopEntry(c)
    expect(stop.locale).toBe(NS)
    expect(stop.options).toMatchObject({ id: 'readaloud-stop', order: 32 })
    const row = rowEntry(c)
    expect(row.locale).toBe(NS)
    expect(row.options).toMatchObject({ id: 'readaloud', order: 30 })

    const face = actionFace(c, 's1' as SessionId)
    const settings = rowFace(c)
    // The closing message and its working steps share one Session surface,
    // and the composer toggle drives the same page-global preference.
    expect(stepFace(c, 's1' as SessionId).hooks.playback).toBe(face.hooks.playback)
    expect(toggleFace(c).hooks.autoRead).toBe(settings.hooks.autoRead)
    expect(narratorFace(c, 's1' as SessionId).hooks.autoRead).toBe(settings.hooks.autoRead)
    // The composer stop chip and the sidebar speaker both read the mirror and
    // stop the same page-global read.
    const stopChip = stopFace(c, 's1' as SessionId)
    expect(stopChip.hooks.activeRead).toBe(indicatorFace(c).hooks.activeRead)
    stopChip.stop()
    indicatorFace(c).stop()
    // The streaming bridge marks a generating step from the same Session store.
    expect(bridgeFace(c, 's1' as SessionId).hooks.playback).toBe(face.hooks.playback)
    bridgeFace(c, 's2' as SessionId)
    // The sidebar indicator starts parked on the page-global mirror.
    expect(indicatorFace(c).hooks.activeRead.getSnapshot())
      .toEqual({ sessionId: undefined, phase: 'idle' })
    // The message entry and the Settings row read the one live preference.
    expect(face.hooks.autoRead).toBe(settings.hooks.autoRead)
    expect(face.hooks.autoRead.getSnapshot()).toBe(false)
    expect(face.hooks.playback.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(face.wasSpoken('m1' as MessageId)).toBe(false)
  }, COLD_BOOT_TIMEOUT_MS)

  it('adopts the Host preference without writing it back', async ({ mock, start }) => {
    const { c, settings } = await client(mock, start, { autoRead: true })

    await vi.waitFor(() => {
      expect(rowFace(c).hooks.autoRead.getSnapshot()).toBe(true)
    })
    expect(ownMutateCalls(settings)).toEqual([])
  })

  it('persists a flip from the composer toggle through the settings scope', async ({ mock, start }) => {
    const { c, settings } = await client(mock, start, { autoRead: false })
    const face = toggleFace(c)

    face.setAutoRead(true)

    expect(face.hooks.autoRead.getSnapshot()).toBe(true)
    await vi.waitFor(() => {
      expect(ownMutateCalls(settings)).toEqual([
        [READALOUD_SETTINGS_NAMESPACE, [{ op: 'set', path: ['autoRead'], value: true }], 1],
      ])
    })
  })

  it('persists a toggled preference through the settings scope', async ({ mock, start }) => {
    const { c, settings } = await client(mock, start, { autoRead: false })
    const face = rowFace(c)

    face.setAutoRead(true)

    // The live value publishes before the durable write settles.
    expect(face.hooks.autoRead.getSnapshot()).toBe(true)
    await vi.waitFor(() => {
      expect(ownMutateCalls(settings)).toEqual([
        [READALOUD_SETTINGS_NAMESPACE, [{ op: 'set', path: ['autoRead'], value: true }], 1],
      ])
      expect(c.ctx.settingsScope.describe().getSnapshot().view?.namespaces)
        .toEqual([readaloudView({ autoRead: true })])
    })
  })

  it('speaks, stops, and discards a superseded synthesis on the session playback store', async ({ mock, start }) => {
    const { c } = await client(mock, start, undefined)
    const face = actionFace(c, 's1' as SessionId)

    face.speak('m1' as MessageId, SPEAK_BLOCKS)

    expect(face.hooks.playback.getSnapshot())
      .toEqual({ messageId: 'm1' as MessageId, phase: 'synthesizing', highlight: undefined })
    expect(face.wasSpoken('m1' as MessageId)).toBe(true)

    face.stop()

    expect(face.hooks.playback.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    // The default module loader rejects here; the generation guard drops the
    // late result, so the store stays at rest.
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(face.hooks.playback.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeAudioContext.instances[0]!.closed).toBe(false)
  })

  it('streams utterances through the narrator face and marks the message spoken on bind', async ({ mock, start }) => {
    const { c } = await client(mock, start, undefined)
    const sessionId = 's1' as SessionId
    const narrator = narratorFace(c, sessionId)
    const actions = actionFace(c, sessionId)
    const block = SPEAK_BLOCKS[0]

    // Only a watched generation may auto-read; narration then excludes it.
    expect(actions.wasGenerating('node-key')).toBe(false)
    narrator.observe('node-key')
    expect(actions.wasGenerating('node-key')).toBe(true)
    expect(actions.wasNarrated('node-key')).toBe(false)

    narrator.start('node-key', block)
    narrator.append('node-key', block)
    expect(actions.wasNarrated('node-key')).toBe(true)
    // The queued utterance marks before its first chunk is scheduled.
    expect(actions.hooks.playback.getSnapshot())
      .toEqual({ messageId: undefined, phase: 'synthesizing', highlight: { blockIndex: 0, ranges: [] } })

    narrator.bind('node-key', 'm1' as MessageId)
    expect(actions.wasSpoken('m1' as MessageId)).toBe(true)

    narrator.finish('node-key')
    await new Promise(resolve => setTimeout(resolve, 25))
  })

  it('pauses and resumes the live read, and pauses on narrator unmount', async ({ mock, start }) => {
    const { c } = await client(mock, start, undefined)
    const sessionId = 's1' as SessionId
    const narrator = narratorFace(c, sessionId)
    const stop = stopFace(c, sessionId)
    const indicator = indicatorFace(c)

    expect(narrator.isStreaming('node-key')).toBe(false)
    narrator.start('node-key', SPEAK_BLOCKS[0])
    expect(narrator.isStreaming('node-key')).toBe(true)

    // Projection progress round-trips through the Session surface.
    const progress = { emitted: new Map([[0, 5]]), projected: new Map([[0, 'hello']]) }
    narrator.saveNarration('node-key', progress)
    expect(narrator.loadNarration('node-key')).toBe(progress)
    narrator.saveNarration('node-key', undefined)
    expect(narrator.loadNarration('node-key')).toBeUndefined()

    stop.pause()
    expect(narrator.isStreaming('node-key')).toBe(true)
    expect(indicator.hooks.activeRead.getSnapshot()).toEqual({ sessionId, phase: 'paused' })

    stop.resume()
    expect(indicator.hooks.activeRead.getSnapshot()).toEqual({ sessionId, phase: 'synthesizing' })

    // Unmounting the narrator pauses so a session switch keeps the position.
    narrator.pauseSession()
    expect(narrator.isStreaming('node-key')).toBe(true)
    expect(indicator.hooks.activeRead.getSnapshot()).toEqual({ sessionId, phase: 'paused' })

    stop.stop()
    expect(narrator.isStreaming('node-key')).toBe(false)
    expect(indicator.hooks.activeRead.getSnapshot()).toEqual({ sessionId: undefined, phase: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 25))
  })

  it('mirrors the speaking Session into the page-global indicator store', async ({ mock, start }) => {
    const { c } = await client(mock, start, undefined)
    const first = actionFace(c, 's1' as SessionId)
    const second = actionFace(c, 's2' as SessionId)
    const indicator = indicatorFace(c)

    first.speak('m1' as MessageId, SPEAK_BLOCKS)
    expect(indicator.hooks.activeRead.getSnapshot())
      .toEqual({ sessionId: 's1' as SessionId, phase: 'synthesizing' })

    // A read in another Session moves the indicator, and stopping clears it.
    second.speak('m2' as MessageId, SPEAK_BLOCKS)
    expect(indicator.hooks.activeRead.getSnapshot())
      .toEqual({ sessionId: 's2' as SessionId, phase: 'synthesizing' })
    await new Promise(resolve => setTimeout(resolve, 25))

    second.stop()
    expect(indicator.hooks.activeRead.getSnapshot())
      .toEqual({ sessionId: undefined, phase: 'idle' })
  })

  it('keeps playback per Session and the preference page-global', async ({ mock, start }) => {
    const { c } = await client(mock, start, undefined)
    const first = actionFace(c, 's1' as SessionId)
    const other = actionFace(c, 's2' as SessionId)

    expect(other.hooks.playback).not.toBe(first.hooks.playback)
    expect(other.hooks.autoRead).toBe(first.hooks.autoRead)
    expect(other.wasSpoken('m1' as MessageId)).toBe(false)

    other.speak('m2' as MessageId, SPEAK_BLOCKS)

    expect(other.hooks.playback.getSnapshot())
      .toEqual({ messageId: 'm2' as MessageId, phase: 'synthesizing', highlight: undefined })
    expect(first.hooks.playback.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)

    // Starting a read in another Session stops the previous one, wherever.
    first.speak('m1' as MessageId, SPEAK_BLOCKS)

    expect(first.hooks.playback.getSnapshot())
      .toEqual({ messageId: 'm1' as MessageId, phase: 'synthesizing', highlight: undefined })
    expect(other.hooks.playback.getSnapshot()).toEqual(INITIAL_READALOUD_PLAYBACK)

    first.stop()
    expect(FakeAudioContext.instances).toHaveLength(1)
  })

  it('closes the shared context and frees every seat when its row unloads', async ({ mock, start }) => {
    const { c } = await client(mock, start, undefined)
    const face = actionFace(c, 's1' as SessionId)
    face.speak('m1' as MessageId, SPEAK_BLOCKS)

    await c.unload(SELF)
    await c.flush()

    expect(c.ctx.slots.entries('conversation.chat.assistant-actions')
      .filter(entry => entry.component === ReadAloudActions)).toEqual([])
    expect(c.ctx.slots.entries('conversation.chat.step-actions')
      .filter(entry => entry.component === ReadAloudStepActions)).toEqual([])
    expect(c.ctx.slots.entries('conversation.input.left')
      .filter(entry => entry.component === AutoReadToggle)).toEqual([])
    expect(c.ctx.slots.entries('conversation.input.left')
      .filter(entry => entry.component === StreamingNarrator)).toEqual([])
    expect(c.ctx.slots.entries('conversation.input.left')
      .filter(entry => entry.component === StopSpeakingButton)).toEqual([])
    expect(c.ctx.slots.entries('sidebar.session.indicator')
      .filter(entry => entry.component === SessionIndicator)).toEqual([])
    expect(c.ctx.slots.entries('conversation.chat.stream-actions')
      .filter(entry => entry.component === StreamHighlightBridge)).toEqual([])
    expect(c.ctx.slots.entries('settings.general.item')
      .filter(entry => entry.component === ReadAloudSettingsRow)).toEqual([])
    await vi.waitFor(() => {
      expect(FakeAudioContext.instances[0]!.closed).toBe(true)
    })
    // The dictionaries are free again — the registration disposer ran.
    expect(() => {
      c.ctx.locale.register(NS, 'zh', {})()
    }).not.toThrow()
    expect(() => {
      c.ctx.locale.register(NS, 'en', {})()
    }).not.toThrow()
  })

  it('re-registers its seats after a Loader rebuild of its own entry', async ({ mock, start }) => {
    const { c } = await client(mock, start, undefined)
    const beforeAction = actionEntry(c)
    const beforeStep = stepEntry(c)
    const beforeToggle = toggleEntry(c)
    const beforeNarrator = narratorEntry(c)
    const beforeStop = stopEntry(c)
    const beforeBridge = bridgeEntry(c)
    const beforeIndicator = indicatorEntry(c)
    const beforeRow = rowEntry(c)
    const face = actionFace(c, 's1' as SessionId)
    face.speak('m1' as MessageId, SPEAK_BLOCKS)

    await c.reload(SELF)
    await c.flush()

    expect(actionEntry(c)).not.toBe(beforeAction)
    expect(stepEntry(c)).not.toBe(beforeStep)
    expect(toggleEntry(c)).not.toBe(beforeToggle)
    expect(narratorEntry(c)).not.toBe(beforeNarrator)
    expect(stopEntry(c)).not.toBe(beforeStop)
    expect(bridgeEntry(c)).not.toBe(beforeBridge)
    expect(indicatorEntry(c)).not.toBe(beforeIndicator)
    expect(rowEntry(c)).not.toBe(beforeRow)
    expect(actionEntry(c).locale).toBe(NS)
    expect(stepEntry(c).locale).toBe(NS)
    expect(toggleEntry(c).locale).toBe(NS)
    // The Session surfaces are rebuilt: nothing is spoken in the new life and
    // the torn-down life closed its context.
    expect(actionFace(c, 's1' as SessionId).wasSpoken('m1' as MessageId)).toBe(false)
    expect(FakeAudioContext.instances).toHaveLength(1)
    expect(FakeAudioContext.instances[0]!.closed).toBe(true)
  })
})
