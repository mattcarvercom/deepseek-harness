/** `readaloud` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'readaloud'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'actions.speak': '朗读',
  'actions.stop': '停止朗读',
  'actions.pause': '暂停朗读',
  'actions.resume': '继续朗读',
  'actions.unavailable': '这条消息没有可朗读的文本',
  'error.synthesis': '无法朗读这条消息',
  'indicator.speaking': '该会话正在朗读',
  'indicator.stop': '停止该会话的朗读',
  'toggle.label': '自动朗读',
  'toggle.on': '自动朗读回复：开',
  'toggle.off': '自动朗读回复：关',
  'settings.title': '自动朗读回复',
  'settings.description': '每轮对话结束时，朗读该轮最后一条助手回复。',
  'settings.autoRead': '自动朗读回复',
} satisfies Record<string, string>

/** The read-aloud namespace key union. */
export type ReadAloudKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Read-aloud copy: the message action button, the failure notice, and the Settings row. */
    readaloud: ReadAloudKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'actions.speak': 'Read aloud',
  'actions.stop': 'Stop reading',
  'actions.pause': 'Pause reading',
  'actions.resume': 'Resume reading',
  'actions.unavailable': 'This message has no text to read aloud',
  'error.synthesis': 'Could not read this message aloud',
  'indicator.speaking': 'Reading aloud in this session',
  'indicator.stop': 'Stop reading in this session',
  'toggle.label': 'Auto-read',
  'toggle.on': 'Auto-read responses: on',
  'toggle.off': 'Auto-read responses: off',
  'settings.title': 'Auto-read responses',
  'settings.description': 'Speak the last assistant message of each turn once the turn completes.',
  'settings.autoRead': 'Auto-read responses',
} satisfies Record<ReadAloudKey, string>
