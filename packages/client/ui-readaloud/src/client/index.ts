/**
 * Read-aloud plugin, browser half: the per-message speaker/stop entries in
 * the conversation.chat.assistant-actions strip (the closing message) and the
 * conversation.chat.step-actions row (every other settled working step), plus
 * the auto-read row in the General Settings list. One page-global
 * SanottsEngine (the vendored wasm runtime in a dedicated worker, streamed
 * chunk by chunk) and one ReadAloudDirector (one shared AudioContext, never
 * more than one live read) serve every Session; each
 * Session additionally owns the spoken-message set and the playback store its
 * message entries read.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: the message identity the assistant-actions owner and the
// injected face carry.
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the ui-chat SlotMap merge (the assistant-actions entry) and
// the Chat node payload the message entry reads.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the ui-settings SlotMap merge (settings.general.item) and
// the Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, NS, zh } from './locales.ts'
import {
  INITIAL_READALOUD_PLAYBACK, ReadAloudDirector, type ReadAloudPlaybackState,
} from './director.ts'
import { SanottsEngine } from './engine.ts'
import { AutoReadToggle } from './AutoReadToggle.tsx'
import { ReadAloudActions, ReadAloudStepActions } from './ReadAloudActions.tsx'
import { SessionIndicator } from './SessionIndicator.tsx'
import { StopSpeakingButton } from './StopSpeakingButton.tsx'
import { StreamHighlightBridge } from './StreamHighlightBridge.tsx'
import { StreamingNarrator } from './StreamingNarrator.tsx'
import { ReadAloudSettingsRow } from './ReadAloudSettingsRow.tsx'
import type { StreamNarrationState } from './streaming.ts'
import { ReadAloudPolicy } from './settings-store.ts'
import type {
  ReadAloudActionInjected, ReadAloudActiveRead, ReadAloudIndicatorInjected,
  ReadAloudSettingsRowInjected, ReadAloudStopInjected, ReadAloudStreamHighlightInjected,
  ReadAloudStreamInjected, ReadAloudToggleInjected,
} from './slots.ts'
import { READALOUD_SETTINGS_NAMESPACE, type ReadAloudSettings } from '../readaloud-settings.ts'

export type {
  ReadAloudActionInjected, ReadAloudActionProps,
  ReadAloudSettingsRowInjected, ReadAloudSettingsRowProps,
} from './slots.ts'
export type { ReadAloudPhase, ReadAloudPlaybackState } from './director.ts'
export type { ReadAloudKey } from './locales.ts'

/** Required services: the slot registry, the copy, and the durable settings scope. */
export const inject = ['slots', 'locale', 'settingsScope']

/** Read-aloud state owned by one Session: what it already spoke and its playback. */
interface ReadAloudSurface {
  spoken: Set<MessageId>
  /** Node keys streaming narration already read. */
  narrated: Set<string>
  /** Streaming projection progress by node key, for remounts and late flushes. */
  narration: Map<string, StreamNarrationState>
  /** The newest assistant step this Session watched generate, if any. */
  lastRunningKey: string | undefined
  playback: SnapshotStore<ReadAloudPlaybackState>
  /** Detaches the active-read mirror's subscription when the plugin unloads. */
  unsubscribe: () => void
}

/**
 * Client plugin body: the message entry, the Settings row, and the shared
 * engine and director they speak through.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-readaloud: dictionaries')

  const policy = new ReadAloudPolicy(
    ctx.settingsScope.bind<ReadAloudSettings>({ namespace: READALOUD_SETTINGS_NAMESPACE }),
  )
  // Page singletons: the engine loads its wasm once, and the director keeps
  // every read on the one shared AudioContext so two Sessions never overlap.
  const engine = new SanottsEngine()
  const director = new ReadAloudDirector(engine)

  const surfaces = new Map<SessionId, ReadAloudSurface>()
  // Page-global mirror of the one active read, for surfaces outside the
  // spoken Session (the sidebar row): one read at a time, so the first
  // speaking Session wins and idle means nobody. Every playback publish
  // re-derives it; selector hooks bail out on unchanged derived values.
  const activeRead = createSnapshotStore<ReadAloudActiveRead>({ sessionId: undefined, phase: 'idle' })
  const refreshActive = (): void => {
    let active: ReadAloudActiveRead = { sessionId: undefined, phase: 'idle' }
    for (const [sessionId, surface] of surfaces) {
      const { phase } = surface.playback.getSnapshot()
      if (phase === 'synthesizing' || phase === 'playing' || phase === 'paused') {
        active = { sessionId, phase }
        break
      }
    }
    activeRead.set(active)
  }
  const surfaceFor = (sessionId: SessionId): ReadAloudSurface => {
    let surface = surfaces.get(sessionId)
    if (surface === undefined) {
      const playback = createSnapshotStore(INITIAL_READALOUD_PLAYBACK)
      surface = {
        spoken: new Set<MessageId>(),
        narrated: new Set<string>(),
        narration: new Map<string, StreamNarrationState>(),
        lastRunningKey: undefined,
        playback,
        unsubscribe: playback.subscribe(() => { refreshActive() }),
      }
      surfaces.set(sessionId, surface)
    }
    return surface
  }
  // Fiber unload (HMR, app teardown): drop the Session surfaces and shut the
  // shared director down with its AudioContext.
  ctx.effect(() => () => {
    for (const surface of surfaces.values()) surface.unsubscribe()
    surfaces.clear()
    director.dispose()
  }, 'ui-readaloud: director and per-session surfaces')

  // Both message seats share one injected face: the same per-Session
  // playback, spoken set, and director serve the closing message and every
  // settled working step alike.
  const actionInject = (sessionId: SessionId): ReadAloudActionInjected => {
    const surface = surfaceFor(sessionId)
    return {
      hooks: { playback: surface.playback, autoRead: policy.autoRead },
      speak: (messageId, blocks) => {
        surface.spoken.add(messageId)
        director.speak({ sessionId, messageId, blocks, store: surface.playback })
      },
      stop: () => { director.stop() },
      wasSpoken: messageId => surface.spoken.has(messageId),
      wasGenerating: nodeKey => surface.lastRunningKey === nodeKey,
      wasNarrated: nodeKey => surface.narrated.has(nodeKey),
    }
  }

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'readaloud',
    order: 30,
    locale: NS,
    inject: actionInject,
  }, ReadAloudActions))

  ctx.slots.inject('conversation.chat.step-actions', () => ctx.slots.register({
    name: 'conversation.chat.step-actions',
    id: 'readaloud',
    order: 30,
    locale: NS,
    inject: actionInject,
  }, ReadAloudStepActions))

  // Streaming auto-read: watch the generating step and start speaking as its
  // sentences complete, instead of waiting for the message to settle.
  const streamInject = (sessionId: SessionId): ReadAloudStreamInjected => {
    const surface = surfaceFor(sessionId)
    return {
      hooks: { autoRead: policy.autoRead },
      start: (key, block) => {
        surface.narrated.add(key)
        director.startStream({ sessionId, key, store: surface.playback })
        director.append(sessionId, key, block)
      },
      append: (key, block) => { director.append(sessionId, key, block) },
      bind: (key, messageId) => {
        surface.spoken.add(messageId)
        director.bind(sessionId, key, messageId)
      },
      finish: (key) => { director.finish(sessionId, key) },
      observe: (key) => { surface.lastRunningKey = key },
      // Unmounting this Session's narrator pauses instead of stopping: the
      // position and the queued audio survive until the Session returns.
      pauseSession: () => { director.pauseSession(sessionId) },
      isStreaming: key => director.isStreaming(sessionId, key),
      loadNarration: key => surface.narration.get(key),
      saveNarration: (key, state) => {
        if (state === undefined) surface.narration.delete(key)
        else surface.narration.set(key, state)
      },
    }
  }
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'readaloud-narrator',
    order: 31,
    locale: NS,
    inject: streamInject,
  }, StreamingNarrator))

  // A generating step has no durable id yet; this bridge marks its text from
  // the streaming read's highlight under the step's stable node key.
  ctx.slots.inject('conversation.chat.stream-actions', () => ctx.slots.register({
    name: 'conversation.chat.stream-actions',
    locale: NS,
    inject: (sessionId: SessionId): ReadAloudStreamHighlightInjected => ({
      hooks: { playback: surfaceFor(sessionId).playback },
    }),
  }, StreamHighlightBridge))

  // Sidebar row indicator: a speaker on the session that is speaking, so the
  // voice stays locatable while another session is read.
  ctx.slots.inject('sidebar.session.indicator', () => ctx.slots.register({
    name: 'sidebar.session.indicator',
    locale: NS,
    inject: (): ReadAloudIndicatorInjected => ({
      hooks: { activeRead },
      stop: () => { director.stop() },
    }),
  }, SessionIndicator))

  // An always-available stop beside the composer controls: streaming reads
  // have no message row yet, so this is their only stop surface.
  const stopInject = (sessionId: SessionId): ReadAloudStopInjected => ({
    hooks: { activeRead },
    sessionId,
    stop: () => { director.stop() },
    pause: () => { director.pause() },
    resume: () => { director.resume() },
  })
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'readaloud-stop',
    order: 32,
    locale: NS,
    inject: stopInject,
  }, StopSpeakingButton))

  // Composer shortcut for the same preference: one chip beside the model
  // selector, so auto-read needs no Settings trip.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'readaloud',
    order: 30,
    locale: NS,
    inject: (): ReadAloudToggleInjected => ({
      hooks: { autoRead: policy.autoRead },
      setAutoRead: (value) => { policy.setAutoRead(value) },
    }),
  }, AutoReadToggle))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'readaloud',
    order: 30,
    locale: NS,
    inject: (): ReadAloudSettingsRowInjected => ({
      hooks: { autoRead: policy.autoRead },
      setAutoRead: (value) => { policy.setAutoRead(value) },
    }),
  }, ReadAloudSettingsRow))
}
