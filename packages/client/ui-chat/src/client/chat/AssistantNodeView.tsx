import { memo, useCallback, useMemo } from 'react'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatFileMentions, ChatNodeViewProps, PresentationInjected, TurnTailOwnerProps } from '../contract/slots.ts'
import type { ChatTextHighlight } from '../contract/store.ts'
import { AssistantMarkdown } from './AssistantMarkdown.tsx'
import css from './AssistantNodeView.module.css'

/** Business readers owned by the assistant renderer's existing Slot registration. */
export interface AssistantNodeInjected extends PresentationInjected {
  /** Resolve against the live Session directory. @param path - Recorded path. @returns Host path. */
  resolveFilePath: (path: string) => string
  /** Resolve closing-Turn mentions with the supplied ordinary file gesture callback. */
  fileMentions: (owner: TurnTailOwnerProps, getFileTriggerProps: NonNullable<Parameters<ChatFileMentions['forClosing']>[2]>) => ReturnType<ChatFileMentions['forClosing']>
}

type AssistantNodeViewProps = ChatNodeViewProps<'assistant-step'> & InjectFace<AssistantNodeInjected>
  & PropsRenderSlots<'conversation.chat.reasoning.body' | 'conversation.chat.message.images' | 'conversation.chat.step-actions' | 'conversation.chat.stream-actions'>

/** Streaming, settled, and interrupted Assistant states share one keyed renderer instance. */
export const AssistantNodeView = memo(function AssistantNodeView({
  node, groupPart, useDisclosure, useGroupAction, useTurnData, turnProcess, openFile, loadImage, fileMentions,
  usePresentation, renderSlot, t, sessionId, useContextMenu, resolveFilePath, textHighlight, setTextHighlight,
}: AssistantNodeViewProps) {
  const { getTriggerProps } = useContextMenu()
  const getFileTriggerProps = useCallback((path: string) => getTriggerProps(() => ({
    kind: 'file', value: { sessionId, path: resolveFilePath(path) },
  })), [getTriggerProps, sessionId, resolveFilePath])
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
    () => owner === undefined ? undefined : fileMentions(owner, getFileTriggerProps),
    [fileMentions, owner, getFileTriggerProps],
  )
  const keepReplies = usePresentation(policy => policy.foldedReplies === 'all')
  // A kept reply row stays visible while the folded Turn hides its inline reasoning.
  const reasoningHidden = turnProcess !== undefined
    && turnProcess.foldable
    && (keepReplies
      ? groupPart !== 'reasoning'
      : turnProcess.spec.answerStep === data.step && turnProcess.spec.inlineReasoning)
    && !turnProcess.open
  const revealProcess = useCallback(() => { turnProcess?.setOpen(true) }, [turnProcess])
  // The Turn tail owns the closing message's action row; every other settled
  // step carries its own, so working steps have controls while the agent runs.
  const stepMessageId = data.finalNode?.messageId === undefined
    || (turn?.status === 'closed' && tail?.closing?.finalNode.seq === data.finalNode.seq)
    ? undefined
    : data.finalNode.messageId
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
        groupPart={groupPart}
        useDisclosure={useDisclosure}
        streaming={data.status === 'running'}
        textInteractionSource={data.status === 'settled' && data.finalNode?.messageId !== undefined}
        interrupted={data.status === 'interrupted'}
        loadImage={loadImage}
        reasoningHidden={reasoningHidden}
        useGroupAction={useGroupAction}
        usePresentation={usePresentation}
        renderSlot={renderSlot}
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
