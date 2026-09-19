/**
 * The injected faces of this package's entries. The
 * 'conversation.chat.assistant-actions', 'conversation.chat.step-actions',
 * and 'settings.general.item' slots are declared and typed by ui-chat and
 * ui-settings; this package only contributes entries, so no SlotMap merge
 * lives here. Live state arrives through the `hooks` compartment (the
 * renderer binds `playback` into `usePlayback` and `autoRead` into
 * `useAutoRead` as selector hooks).
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/slots
 */

import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls this package's LocaleNamespaceMap merge (the 'readaloud' seat).
import type {} from './locales.ts'
// Type-only: pulls ui-conversation's SlotMap merge (the composer tool row)
// and ui-workspace's merge (the sidebar session-row indicator seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReadAloudPhase, ReadAloudPlaybackState } from './director.ts'
import type { SpeakableBlock } from './sanitizer.ts'
import type { StreamNarrationState } from './streaming.ts'

/** Injected business face of one assistant-message read-aloud entry. */
export interface ReadAloudActionInjected {
  hooks: {
    /** This Session's playback state, shared by all of its message entries. */
    playback: SnapshotStore<ReadAloudPlaybackState>
    /** The live auto-read preference, shared with the Settings row. */
    autoRead: SnapshotStore<boolean>
  }
  /**
   * Read the message aloud, stopping anything already playing.
   * @param messageId - the message to read.
   * @param blocks - the speakable blocks derived from the message's blocks.
   */
  speak: (messageId: MessageId, blocks: readonly SpeakableBlock[]) => void
  /** Stop whatever is currently playing or synthesizing, if anything. */
  stop: () => void
  /**
   * Whether the message was already read in this Session, so auto-read fires
   * at most once per message.
   * @param messageId - the message to check.
   */
  wasSpoken: (messageId: MessageId) => boolean
  /**
   * Whether the Session watched this node generate, so auto-read fires only
   * for live completions and never for messages mounted by a session switch.
   * @param nodeKey - the assistant step's stable node key.
   */
  wasGenerating: (nodeKey: string) => boolean
  /**
   * Whether streaming narration already read this node, so the settled
   * message does not start a second, whole-message read.
   * @param nodeKey - the assistant step's stable node key.
   */
  wasNarrated: (nodeKey: string) => boolean
}

/** Full props of one assistant-message read-aloud entry. */
export type ReadAloudActionProps =
  PropsRuntime<'conversation.chat.assistant-actions'>
  & InjectFace<ReadAloudActionInjected>
  & PropsLocale<'readaloud'>

/**
 * The page-global active read, shared with surfaces outside the spoken
 * Session (the sidebar indicator): which Session is speaking and its phase.
 */
export interface ReadAloudActiveRead {
  /** The Session currently speaking, if any. */
  readonly sessionId: SessionId | undefined
  /** The active read's phase; idle while nothing speaks. */
  readonly phase: ReadAloudPhase
}

/** Injected business face of the streaming auto-read narrator. */
export interface ReadAloudStreamInjected {
  hooks: {
    /** The live auto-read preference. */
    autoRead: SnapshotStore<boolean>
  }
  /** Begin the streaming read with its first utterance. */
  start: (key: string, block: SpeakableBlock) => void
  /** Queue one more utterance behind the streaming read's audio. */
  append: (key: string, block: SpeakableBlock) => void
  /** Bind the durable message id and mark the message spoken. */
  bind: (key: string, messageId: MessageId) => void
  /** No more utterances will arrive for this read. */
  finish: (key: string) => void
  /**
   * Pause this Session's read where it is; called when the narrator unmounts
   * (a session switch) so the position survives the trip.
   */
  pauseSession: () => void
  /**
   * Whether a streaming read with this key is live (playing, synthesizing, or
   * paused), so a remounted narrator appends instead of restarting.
   * @param key - the assistant step's stable node key.
   */
  isStreaming: (key: string) => boolean
  /**
   * The projection progress saved for this key, so a read that settled while
   * the Session was away can flush its tail on return.
   * @param key - the assistant step's stable node key.
   */
  loadNarration: (key: string) => StreamNarrationState | undefined
  /**
   * Save (or clear) the projection progress for this key.
   * @param key - the assistant step's stable node key.
   * @param state - the progress, or undefined to clear it.
   */
  saveNarration: (key: string, state: StreamNarrationState | undefined) => void
  /**
   * Record that this node is generating in front of the user, enabling the
   * live-completion auto-read and excluding session-switch mounts.
   * @param key - the assistant step's stable node key.
   */
  observe: (key: string) => void
}

/** Injected business face of the streaming highlight bridge. */
export interface ReadAloudStreamHighlightInjected {
  hooks: {
    /** This Session's playback state, shared with its message entries. */
    playback: SnapshotStore<ReadAloudPlaybackState>
  }
}

/** Full props of the streaming highlight bridge. */
export type ReadAloudStreamHighlightProps =
  PropsRuntime<'conversation.chat.stream-actions'>
  & InjectFace<ReadAloudStreamHighlightInjected>
  & PropsLocale<'readaloud'>

/** Full props of the streaming auto-read narrator. */
export type ReadAloudStreamProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<ReadAloudStreamInjected>
  & PropsLocale<'readaloud'>

/** Injected business face of the sidebar session-row indicator. */
export interface ReadAloudIndicatorInjected {
  hooks: {
    /** The page-global active read. */
    activeRead: SnapshotStore<ReadAloudActiveRead>
  }
  /** Stop the page's active read, wherever it is speaking. */
  stop: () => void
}

/** Injected business face of the composer stop control. */
export interface ReadAloudStopInjected {
  hooks: {
    /** The page-global active read. */
    activeRead: SnapshotStore<ReadAloudActiveRead>
  }
  /** The Session this control belongs to. */
  sessionId: SessionId
  /** Stop the page's active read, wherever it is speaking. */
  stop: () => void
  /** Pause the page's active read where it is, keeping its position. */
  pause: () => void
  /** Resume the paused read from its kept position. */
  resume: () => void
}

/** Full props of the composer stop control. */
export type ReadAloudStopProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<ReadAloudStopInjected>
  & PropsLocale<'readaloud'>

/** Full props of one sidebar session-row read-aloud indicator. */
export type ReadAloudIndicatorProps =
  PropsRuntime<'sidebar.session.indicator'>
  & InjectFace<ReadAloudIndicatorInjected>
  & PropsLocale<'readaloud'>

/** Full props of one settled working-step read-aloud entry. */
export type ReadAloudStepActionProps =
  PropsRuntime<'conversation.chat.step-actions'>
  & InjectFace<ReadAloudActionInjected>
  & PropsLocale<'readaloud'>

/** Injected business face of the composer auto-read toggle. */
export interface ReadAloudToggleInjected {
  hooks: {
    /** The live auto-read preference. */
    autoRead: SnapshotStore<boolean>
  }
  /** Change the auto-read preference (live, then durable). */
  setAutoRead: (value: boolean) => void
}

/** Full props of the composer auto-read toggle. */
export type ReadAloudToggleProps =
  PropsRuntime<'conversation.input.left'>
  & InjectFace<ReadAloudToggleInjected>
  & PropsLocale<'readaloud'>

/** Injected business face of the auto-read Settings row. */
export interface ReadAloudSettingsRowInjected {
  hooks: {
    /** The live auto-read preference. */
    autoRead: SnapshotStore<boolean>
  }
  /** Change the auto-read preference (live, then durable). */
  setAutoRead: (value: boolean) => void
}

/** Full props of the auto-read Settings row. */
export type ReadAloudSettingsRowProps =
  PropsRuntime<'settings.general.item'>
  & InjectFace<ReadAloudSettingsRowInjected>
  & PropsLocale<'readaloud'>
