import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionQueuedItem } from '../../types.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { QueuedMessage } from '../contract/snapshot.ts'
import { previewOf, textOf } from './message-preview.ts'

type QueueItems = readonly SessionQueuedItem[]

/** Authoritative transient queue projection and durable steering handoff. */
export class SessionQueueMirror {
  private current: readonly QueuedMessage[] = []

  /**
   * Return the current immutable queue projection.
   * @returns current queue rows.
   */
  snapshot(): readonly QueuedMessage[] {
    return this.current
  }

  /**
   * Replace from one authoritative stream queue frame.
   * @param items - complete host queue snapshot.
   */
  replace(items: QueueItems): void {
    this.current = items.map((item) => {
      const content = item.message.content as unknown as readonly ContentBlock[]
      return {
        id: item.id,
        messageId: item.message.id,
        placement: item.placement,
        ...(item.rpcId === undefined ? {} : { rpcId: item.rpcId }),
        content,
        preview: previewOf(content),
        text: textOf(content),
      }
    })
  }

  /**
   * Retire a transient steering row once its durable message enters the log.
   * @param event - newly contiguous durable Session event.
   * @returns whether the projection changed.
   */
  acceptDurable(event: SessionEvent): boolean {
    if (event.type !== 'user/message') return false
    const messageId = event.data.id
    const index = this.current.findIndex(item =>
      item.placement === 'steering' && item.messageId === messageId)
    if (index < 0) return false
    this.current = this.current.filter((_item, candidate) => candidate !== index)
    return true
  }
}
