/**
 * Per-message read-aloud control: the speaker icon in the assistant message's
 * IconActions row, between copy and branch, and on every settled working step
 * that is not its Turn's closing message. It flips to a stop icon while its
 * message synthesizes or plays, and starting it stops anything already
 * playing. With the auto-read preference on, each settled message is read
 * once, when it becomes speakable (the finalized node arrives), so a running
 * turn is narrated step by step as its text lands and a newer step's read
 * replaces the older one only when its first chunk is ready to play. A message
 * with no speakable text (no text, or fenced code only) carries an
 * unavailable, explained control in the tail seat and no control at all in
 * the working-step seat.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/ReadAloudActions
 */

import { useEffect, useId, useMemo, useRef } from 'react'
import {
  IconSpeakerOutline16, IconStopFill16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadAloudActionProps, ReadAloudStepActionProps } from './slots.ts'
import { assistantStep } from './nodes.ts'
import { speakableBlocks } from './sanitizer.ts'
import css from './ReadAloudActions.module.css'

/** Either seat's composed props; both carry the same owner, inject, and locale shares. */
type ReadAloudControlProps = ReadAloudActionProps | ReadAloudStepActionProps

/**
 * One finalized assistant message's read-aloud control in the Turn action row.
 * @param props - the owner's message identity, the injected verbs, and the
 * bound playback, auto-read, and Chat hooks.
 * @returns the speaker/stop button with its unavailable and failure notices.
 */
export function ReadAloudActions(props: ReadAloudActionProps) {
  return <ReadAloudActionControl {...props} hideUnavailable={false} />
}

/**
 * One settled working step's read-aloud control in the step action row.
 * @param props - the same shares as {@link ReadAloudActions}.
 * @returns the speaker/stop button, or null while the step carries no
 * speakable text (working steps without text show no control at all).
 */
export function ReadAloudStepActions(props: ReadAloudStepActionProps) {
  return <ReadAloudActionControl {...props} hideUnavailable />
}

/**
 * Shared control body: reads the step's speakable text from the Chat node and
 * drives the injected speak/stop verbs from the bound playback state.
 * @param props - composed seat props plus the seat's unavailable-control policy.
 * @returns the button, or null when a working-step seat has nothing to read.
 */
function ReadAloudActionControl({
  hideUnavailable, messageId, speak, stop, setTextHighlight, wasSpoken, wasGenerating, wasNarrated,
  useAutoRead, useChat, usePlayback, t,
}: ReadAloudControlProps & { hideUnavailable: boolean }) {
  // Scan the Chat order for this message's finalized Assistant node. Node
  // identity is stable across snapshots while its content is, so the selector
  // bails out on unchanged rows and the memoized text re-derives only on a
  // real content change.
  const node = useChat((snapshot) => {
    for (const key of snapshot.order) {
      const candidate = assistantStep(snapshot.nodes.get(key))
      if (candidate !== undefined && candidate.data.finalNode?.messageId === messageId) {
        return candidate
      }
    }
    return undefined
  })
  const blocks = useMemo(
    () => (node !== undefined ? speakableBlocks(node.data.blocks) : []),
    [node],
  )
  const mine = usePlayback(state =>
    state.messageId === messageId
    && (state.phase === 'synthesizing' || state.phase === 'playing' || state.phase === 'paused'),
  )
  const failed = usePlayback(state => state.messageId === messageId && state.phase === 'failed')
  const autoRead = useAutoRead(value => value)
  const unavailable = blocks.length === 0
  const reasonId = useId()

  // Auto-read: the trigger is the message becoming speakable (the finalized
  // node arriving), and the preference is read at that moment — a
  // preference flipped on while an already-readable row is mounted never
  // re-reads visible messages. The per-session spoken set (updated by the
  // injected speak verb) keeps this at most once per message, including
  // across remounts. On a working Step the arriving text of a newer step
  // interrupts the previous step's read through speak()'s own stop.
  const lastSpeakable = useRef<readonly unknown[] | undefined>(undefined)
  const streamKey = node?.key
  useEffect(() => {
    const becoming = blocks.length > 0 && lastSpeakable.current === undefined
    lastSpeakable.current = blocks.length > 0 ? blocks : undefined
    // Auto-read answers a live completion only: the Session must have watched
    // this step generate (a session switch mounts settled messages that must
    // stay quiet), and streaming narration must not have read it already.
    if (becoming && autoRead && !wasSpoken(messageId) && streamKey !== undefined
      && wasGenerating(streamKey) && !wasNarrated(streamKey)) {
      speak(messageId, blocks)
    }
  }, [autoRead, blocks, messageId, speak, streamKey, wasGenerating, wasNarrated, wasSpoken])

  // Publish the sentence being spoken to the message body; ui-chat renders
  // the highlight from its own store and clears it when this entry goes.
  const highlight = usePlayback(state => state.messageId === messageId ? state.highlight : undefined)
  useEffect(() => {
    setTextHighlight(highlight)
    return () => { setTextHighlight(undefined) }
  }, [highlight, setTextHighlight])

  if (hideUnavailable && unavailable) return null

  const label = unavailable
    ? t('actions.unavailable')
    : mine ? t('actions.stop') : t('actions.speak')
  // The control is wired only while speakable, so inside the arm the text
  // is narrowed to string and cannot become undefined before the click.
  const onClick = unavailable
    ? undefined
    : () => {
      if (mine) stop()
      else speak(messageId, blocks)
    }

  return (
    <>
      <Tooltip label={label} side="bottom">
        <button
          type="button"
          className={css.action}
          aria-label={unavailable ? t('actions.speak') : label}
          aria-disabled={unavailable || undefined}
          aria-describedby={unavailable ? reasonId : undefined}
          aria-pressed={unavailable ? undefined : mine}
          data-active={mine || undefined}
          data-unavailable={unavailable || undefined}
          onClick={onClick}
        >
          {mine ? <IconStopFill16 /> : <IconSpeakerOutline16 />}
        </button>
      </Tooltip>
      {unavailable && (
        <span id={reasonId} className={css.visuallyHidden}>{t('actions.unavailable')}</span>
      )}
      {failed && (
        <span className={css.failure} role="status">{t('error.synthesis')}</span>
      )}
    </>
  )
}
