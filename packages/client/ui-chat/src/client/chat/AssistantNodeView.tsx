import { memo, useCallback, useMemo } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '../contract/slots.ts'
import type { ChatTextHighlight } from '../contract/store.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import css from './AssistantNodeView.module.css'

type AssistantNodeViewProps = ChatNodeViewProps<'assistant-step'>
  & PropsRenderSlots<'conversation.chat.step-actions' | 'conversation.chat.stream-actions'>

/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
export const AssistantNodeView = memo(function AssistantNodeView({
  node, useTurnData, turnProcess, openFile, renderMessageImages, fileMentions,
  renderSlot, textHighlight, setTextHighlight, t,
}: AssistantNodeViewProps) {
  const data = node.data
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const tail = useTurnData('turn-tail')
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== 'closed' || data.finalNode === undefined) return undefined
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined
    return { turn, seq: data.finalNode.seq, openFile }
  }, [data.finalNode, openFile, tail, turn])
  const mentions = useMemo(
    () => owner === undefined ? undefined : fileMentions(owner),
    [fileMentions, owner],
  )
  // The Turn tail owns the closing message's action row; every other settled
  // step carries its own, so working steps have controls while the agent runs.
  const stepMessageId = data.finalNode?.messageId === undefined
    || (turn?.status === 'closed' && tail?.closing?.finalNode.seq === data.finalNode.seq)
    ? undefined
    : data.finalNode.messageId
  const reasoningHidden = turnProcess !== undefined
    && turnProcess.foldable
    && turnProcess.spec.answerStep === data.step
    && turnProcess.spec.inlineReasoning
    && !turnProcess.open
  const revealProcess = useCallback(() => { turnProcess?.setOpen(true) }, [turnProcess])
  const setStepHighlight = useCallback((highlight: ChatTextHighlight | undefined) => {
    if (stepMessageId !== undefined) setTextHighlight(stepMessageId, highlight)
  }, [setTextHighlight, stepMessageId])
  const setStreamHighlight = useCallback((highlight: ChatTextHighlight | undefined) => {
    setTextHighlight(node.key, highlight)
  }, [node.key, setTextHighlight])
  return (
    <div className={css.root}>
      <AssistantMarkdown
        blocks={data.blocks}
        highlight={textHighlight}
        streaming={data.status === 'running'}
        interrupted={data.status === 'interrupted'}
        renderMessageImages={renderMessageImages}
        reasoningHidden={reasoningHidden}
        revealProcess={revealProcess}
        mentions={mentions}
        t={t}
      />
      {stepMessageId !== undefined && (
        <div className={css.actions}>
          {renderSlot('conversation.chat.step-actions', {
            messageId: stepMessageId,
            setTextHighlight: setStepHighlight,
          })}
        </div>
      )}
      {data.status === 'running' && (
        <div className={css.actions}>
          {renderSlot('conversation.chat.stream-actions', {
            streamKey: node.key,
            setTextHighlight: setStreamHighlight,
          })}
        </div>
      )}
    </div>
  )
})
