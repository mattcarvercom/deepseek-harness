/**
 * Session-row read-aloud indicator: a small speaker beside the title of the
 * session currently speaking. It reads the page-global active-read mirror,
 * not the row's own Session scope, so switching sessions never loses track
 * of where the voice is coming from. Rendered by ui-workspace's session row
 * through its `sidebar.session.indicator` seat.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/SessionIndicator
 */

import { IconSpeakerOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadAloudIndicatorProps } from './slots.ts'
import css from './SessionIndicator.module.css'

/**
 * One session row's speaking indicator and stop control.
 * @param props - the row's session identity, the page-global read mirror, and
 * the stop verb.
 * @returns the pulsing speaker button while this session speaks, null otherwise.
 */
export function SessionIndicator({ sessionId, useActiveRead, stop, t }: ReadAloudIndicatorProps) {
  const speaking = useActiveRead(state => state.sessionId === sessionId
    && (state.phase === 'synthesizing' || state.phase === 'playing' || state.phase === 'paused'))
  if (!speaking) return null
  const label = t('indicator.stop')
  return (
    <button
      type="button"
      className={css.indicator}
      aria-label={label}
      title={label}
      onClick={(event) => {
        // The row itself opens the session; the speaker only stops the read.
        event.stopPropagation()
        stop()
      }}
    >
      <IconSpeakerOutline16 size={14} />
    </button>
  )
}
