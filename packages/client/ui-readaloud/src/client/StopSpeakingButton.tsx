/**
 * Composer playback controls: pause/resume and stop chips beside the
 * auto-read toggle that appear while this Session is speaking — including a
 * streaming read, which has no message row to stop from. Pause keeps the
 * position, so a long read survives a session switch; stop retires it.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/StopSpeakingButton
 */

import {
  IconPauseOutline16, IconPlayOutline16, IconStopFill16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadAloudStopProps } from './slots.ts'
import css from './StopSpeakingButton.module.css'

/**
 * One composer playback control for the active read.
 * @param props - the page-global read mirror, this Session's id, and the verbs.
 * @returns the pause/resume and stop chips while this Session speaks, null otherwise.
 */
export function StopSpeakingButton({
  sessionId, useActiveRead, stop, pause, resume, t,
}: ReadAloudStopProps) {
  const phase = useActiveRead((state) => {
    if (state.sessionId !== sessionId) return undefined
    if (state.phase === 'synthesizing' || state.phase === 'playing' || state.phase === 'paused') {
      return state.phase
    }
    return undefined
  })
  if (phase === undefined) return null
  const paused = phase === 'paused'
  const toggleLabel = paused ? t('actions.resume') : t('actions.pause')
  return (
    <>
      <Tooltip label={toggleLabel} side="top">
        <button
          type="button"
          className={css.stop}
          aria-label={toggleLabel}
          onClick={paused ? resume : pause}
        >
          {paused ? <IconPlayOutline16 size={16} /> : <IconPauseOutline16 size={16} />}
        </button>
      </Tooltip>
      <Tooltip label={t('actions.stop')} side="top">
        <button type="button" className={css.stop} aria-label={t('actions.stop')} onClick={stop}>
          <IconStopFill16 size={16} />
        </button>
      </Tooltip>
    </>
  )
}
