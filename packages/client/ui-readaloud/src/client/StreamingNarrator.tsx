/**
 * Headless auto-read narrator for generating responses: while a turn runs it
 * projects the newest running Assistant step and hands every complete
 * sentence to the director, so speech starts during generation instead of
 * after the step settles. When the step settles it flushes the remaining
 * text, binds the durable message id — which marks the message spoken, so
 * the settled message's own auto-read stays quiet — and finishes the read.
 * A projection that cannot be extended (a retry rewrite) abandons streaming
 * for that step; if nothing was spoken yet, the settle auto-read reads it in
 * full. Progress is saved per node key, and unmount pauses the read where it
 * is, so a switch away and back resumes the same position and flushes a tail
 * that settled while the Session was away. Renders nothing.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/StreamingNarrator
 */

import { useEffect, useRef } from 'react'
import { assistantStep } from './nodes.ts'
import type { SpeakableBlock } from './sanitizer.ts'
import { speakableBlocks } from './sanitizer.ts'
import type { ReadAloudStreamProps } from './slots.ts'
import {
  collectStreamUtterances, type StreamNarrationState, type StreamUtterance,
} from './streaming.ts'

/** Streaming progress the component carries between renders. */
interface NarrationTracker {
  /** The running node's key the offsets belong to. */
  key: string | undefined
  /** Emitted offsets for that node's blocks. */
  state: StreamNarrationState | undefined
  /** The director still holds a live read for this key. */
  started: boolean
  /** Keys whose projection diverged; they are left to the settle auto-read. */
  abandoned: Set<string>
}

/**
 * Rebase one utterance onto the block it came from: the utterance becomes
 * the spoken text and its span's source ranges become the segments, so the
 * director's highlight mapping works unchanged.
 * @param block - the block the utterance was cut from.
 * @param utterance - the utterance, with its span in the block's text.
 * @returns a standalone speakable block for the director.
 */
function utteranceBlock(block: SpeakableBlock, utterance: StreamUtterance): SpeakableBlock {
  const segments = []
  for (const segment of block.segments) {
    const from = Math.max(segment.start, utterance.start)
    const to = Math.min(segment.end, utterance.end)
    if (to <= from) continue
    segments.push({
      start: from - utterance.start,
      end: to - utterance.start,
      sourceStart: segment.sourceStart + (from - segment.start),
      sourceEnd: segment.sourceStart + (to - segment.start),
    })
  }
  return { blockIndex: block.blockIndex, text: utterance.text, segments }
}

/**
 * Auto-read streaming narrator; mounted per Session into the composer tool
 * row, it observes the newest Assistant node and never renders.
 * @param props - the live auto-read preference, the Chat selector hook, and
 * the streaming read verbs.
 * @returns null.
 */
export function StreamingNarrator({
  useAutoRead, useChat, start, append, bind, finish, observe,
  pauseSession, isStreaming, loadNarration, saveNarration,
}: ReadAloudStreamProps) {
  const autoRead = useAutoRead(value => value)
  const node = useChat((snapshot) => {
    for (const key of [...snapshot.order].reverse()) {
      const candidate = assistantStep(snapshot.nodes.get(key))
      if (candidate !== undefined) return candidate
    }
    return undefined
  })
  const tracker = useRef<NarrationTracker>({
    key: undefined, state: undefined, started: false, abandoned: new Set(),
  })
  // Unmount pauses instead of stopping, even if the injected verbs change
  // identity: the position survives a session switch for the resume chip.
  const pauseRef = useRef(pauseSession)
  pauseRef.current = pauseSession
  useEffect(() => () => {
    pauseRef.current()
  }, [])

  useEffect(() => {
    const state = tracker.current
    const reset = (): void => {
      state.key = undefined
      state.state = undefined
      state.started = false
    }
    const emit = (key: string, utterances: readonly StreamUtterance[]): void => {
      for (const utterance of utterances) {
        const speakable = utteranceBlock(utterance.block, utterance)
        if (state.started) append(key, speakable)
        else {
          start(key, speakable)
          state.started = true
        }
      }
    }
    // Adopt a node's saved progress (a read that started before a remount, or
    // settled while the Session was away); a read the director no longer
    // holds is adopted as unstarted only when saved progress exists.
    const adopt = (nodeKey: string): void => {
      state.key = nodeKey
      state.state = loadNarration(nodeKey)
      state.started = isStreaming(nodeKey)
    }
    const nodeKey = node?.key
    // Watching a node generate is what authorizes its live-completion
    // auto-read; a message merely mounted by a session switch never gets it.
    if (node?.data.status === 'running' && nodeKey !== undefined) observe(nodeKey)
    // A different node owns the newest Assistant row now: the old read, if
    // any, receives no more text.
    if (state.key !== undefined && state.key !== nodeKey) {
      finish(state.key)
      reset()
    }
    if (node === undefined || nodeKey === undefined || !autoRead) {
      if (state.key !== undefined) {
        finish(state.key)
        reset()
      }
      return
    }
    const blocks = speakableBlocks(node.data.blocks)
    if (node.data.status === 'running') {
      if (state.abandoned.has(nodeKey)) return
      if (state.key !== nodeKey) adopt(nodeKey)
      const result = collectStreamUtterances(state.state, blocks, false)
      if (result.diverged) {
        state.abandoned.add(nodeKey)
        saveNarration(nodeKey, undefined)
        if (state.started) finish(nodeKey)
        reset()
        return
      }
      state.state = result.state
      saveNarration(nodeKey, result.state)
      emit(nodeKey, result.utterances)
      return
    }
    // Settled or interrupted: flush the tail, bind the durable id, finish.
    const messageId = node.data.finalNode?.messageId
    if (state.key !== nodeKey) {
      if (state.abandoned.has(nodeKey)) {
        state.abandoned.delete(nodeKey)
        if (messageId !== undefined) bind(nodeKey, messageId)
        return
      }
      // A read that settled while this Session was away still owes its tail:
      // adopt its saved progress and flush now, so a later resume plays it.
      // Saved progress is the marker of an unfinished pass — a read that this
      // narrator already flushed has none, and a finished read still counts
      // as streaming while its queued audio drains, so adopting on that would
      // re-flush the whole message forever.
      if (loadNarration(nodeKey) === undefined) return
      adopt(nodeKey)
    }
    const result = collectStreamUtterances(state.state, blocks, true)
    if (!result.diverged) emit(nodeKey, result.utterances)
    saveNarration(nodeKey, undefined)
    if (messageId !== undefined) bind(nodeKey, messageId)
    finish(nodeKey)
    state.abandoned.delete(nodeKey)
    reset()
  }, [
    append, autoRead, bind, finish, isStreaming, loadNarration, node, observe, saveNarration, start,
  ])

  return null
}
