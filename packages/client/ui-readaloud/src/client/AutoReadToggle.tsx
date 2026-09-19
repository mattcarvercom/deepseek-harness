/**
 * Composer auto-read toggle: a compact chip in the composer tool row, beside
 * the model selector, that flips the same live preference the General
 * Settings row owns. With it on, every settled assistant message is read
 * without a speaker click.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/AutoReadToggle
 */

import { IconSpeakerOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadAloudToggleProps } from './slots.ts'
import css from './AutoReadToggle.module.css'

/**
 * One composer toggle for the auto-read preference.
 * @param props - the injected preference face and the read-aloud locale.
 * @returns the toggle chip; its pressed state marks the live preference.
 */
export function AutoReadToggle({ useAutoRead, setAutoRead, t }: ReadAloudToggleProps) {
  const on = useAutoRead(value => value)
  return (
    <Tooltip label={on ? t('toggle.on') : t('toggle.off')} side="top">
      <button
        type="button"
        className={css.toggle}
        aria-label={t('toggle.label')}
        aria-pressed={on}
        data-active={on || undefined}
        onClick={() => { setAutoRead(!on) }}
      >
        <IconSpeakerOutline16 size={16} />
        <span className={css.label}>{t('toggle.label')}</span>
      </button>
    </Tooltip>
  )
}
