import z from '@deepseek-ai/schemastery'

/** Settings namespace this package owns in the durable user-settings seam. */
export const READALOUD_SETTINGS_NAMESPACE = 'ui-readaloud' as const

/** Settings field name for the auto-read toggle inside {@link READALOUD_SETTINGS_NAMESPACE}. */
export const AUTO_READ_FIELD = 'autoRead' as const

/**
 * User settings exposed by the ui-readaloud package:
 *
 * - `autoRead`: automatically speak each completed turn's final assistant message.
 */
export interface ReadAloudSettings {
  autoRead: boolean
}

/** Schema of {@link ReadAloudSettings}: one boolean field, defaulting to off. */
export const ReadAloudSettingsSchema = z.object({
  autoRead: z.boolean().default(false),
})
