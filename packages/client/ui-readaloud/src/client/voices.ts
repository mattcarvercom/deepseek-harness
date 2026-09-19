/**
 * Read-aloud voice registry. A voice is the key of a self-hosted weight
 * directory under assets/sanotts/voices/ plus the lineage build the sanotts
 * runtime loads for it; the engine passes the key to the runtime verbatim.
 * There is no runtime picker, so every key is a compile-time constant.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/voices
 */

/**
 * Voice keys this plugin can synthesize; each names the vendored weight
 * directory assets/sanotts/voices/<key>/.
 */
export type ReadAloudVoiceKey = 'heart' | 'heartnano'

/**
 * Default voice: the 2.27M-parameter f32 model. `heartnano` is the registered
 * low-resource fallback (294k int8) for callers that need it.
 */
export const DEFAULT_READALOUD_VOICE: ReadAloudVoiceKey = 'heart'
