import type { Context } from '@deepseek-ai/cordis'

import type {} from '@deepseek-ai/dsh-settings'

import { READALOUD_SETTINGS_NAMESPACE, ReadAloudSettingsSchema } from './readaloud-settings.ts'

export { AUTO_READ_FIELD, READALOUD_SETTINGS_NAMESPACE, ReadAloudSettingsSchema } from './readaloud-settings.ts'
export type { ReadAloudSettings } from './readaloud-settings.ts'

/**
 * Node half of ui-readaloud: registers the `ui-readaloud` settings namespace
 * (the `autoRead` toggle) with the settings service. The browser half lives in
 * `@deepseek-ai/dsh-client-ui-readaloud/client`; this file carries no runtime
 * behavior of its own beyond the settings registration.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (scope) => {
    scope.settings.register(READALOUD_SETTINGS_NAMESPACE, ReadAloudSettingsSchema)
  })
}
