/** Chat-owned per-Session view state. */

/** Tool call identity as carried by Chat nodes. */
export type ToolCallId = string

/** One manually expanded Turn answer generation. */
export interface TurnProcessViewEntry {
  readonly turn: number
  readonly answerStep: number
}

/** One Markdown source range to highlight inside a text block. */
export interface ChatTextHighlightRange {
  readonly start: number
  readonly end: number
}

/**
 * One read-along highlight: the text block's index in the message's block
 * list and the Markdown source ranges to mark inside that block.
 */
export interface ChatTextHighlight {
  readonly blockIndex: number
  readonly ranges: readonly ChatTextHighlightRange[]
}

/** One highlight as the store retains it, addressed by durable id or streaming node key. */
export interface ChatTextHighlightEntry {
  /** The durable message id, or a generating step's stable node key. */
  readonly key: string
  readonly highlight: ChatTextHighlight
}

/** Per-Session state shared only by the Chat view and details surface. */
export interface ChatStoreState {
  turnProcesses: TurnProcessViewEntry[]
  textHighlights: ChatTextHighlightEntry[]
}
