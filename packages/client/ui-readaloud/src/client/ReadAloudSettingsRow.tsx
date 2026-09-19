/** General Settings row for the read-aloud auto-read preference. */

import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReadAloudSettingsRowProps } from './slots.ts'
import css from './ReadAloudSettingsRow.module.css'

/**
 * Render the auto-read preference.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function ReadAloudSettingsRow({
  setAutoRead, useAutoRead, t,
}: ReadAloudSettingsRowProps) {
  const autoRead = useAutoRead(value => value)
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.title')}</div>
        <div className={css.desc}>{t('settings.description')}</div>
      </div>
      <Switch
        checked={autoRead}
        onChange={setAutoRead}
        label={t('settings.autoRead')}
      />
    </div>
  )
}
