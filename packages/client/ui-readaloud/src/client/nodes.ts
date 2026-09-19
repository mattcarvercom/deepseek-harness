/**
 * Shared narrowing helpers over the Chat view's node union.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/nodes
 */

import type { ChatConversationViewNode, ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'

/**
 * Narrow an untyped Chat node to the Assistant row payload.
 * @param node - a node fetched by key from the Chat node store.
 * @returns the node typed to the Assistant payload, or undefined when it is not one.
 */
export function assistantStep(
  node: ChatConversationViewNode | undefined,
): ChatNode<'assistant-step'> | undefined {
  if (node === undefined || node.kind !== 'assistant-step') return undefined
  return node as ChatNode<'assistant-step'>
}
