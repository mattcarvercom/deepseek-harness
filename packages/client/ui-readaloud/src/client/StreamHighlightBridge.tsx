/**
 * Headless bridge between the streaming read and the transcript: while a
 * generating step is being read it publishes the playback state's current
 * highlight under the step's stable node key, so the mark follows the voice
 * before the message has a durable id. It renders nothing and exists only
 * for the running step; once the step settles the message entry takes over
 * with the durable-id highlight.
 * @module @deepseek-ai/dsh-client-ui-readaloud/client/StreamHighlightBridge
 */

import { useEffect, useRef } from 'react'
import type { ReadAloudStreamHighlightProps } from './slots.ts'

/**
 * Publish the streaming read's highlight under this step's node key.
 * @param props - the Session playback store and the key-bound setter.
 * @returns null.
 */
export function StreamHighlightBridge({
  usePlayback, setTextHighlight,
}: ReadAloudStreamHighlightProps) {
  // Only a streaming read (no durable id yet) addresses this step's key; a
  // manual read of some other message must not mark the generating text.
  const highlight = usePlayback(state => state.messageId === undefined
    && (state.phase === 'synthesizing' || state.phase === 'playing')
    ? state.highlight
    : undefined)
  const published = useRef(false)
  useEffect(() => {
    if (highlight !== undefined) {
      published.current = true
      setTextHighlight(highlight)
    }
    // A changed or withdrawn mark clears through the cleanup before the next
    // effect; unmount clears whatever this bridge last published.
    return () => {
      if (published.current) {
        published.current = false
        setTextHighlight(undefined)
      }
    }
  }, [highlight, setTextHighlight])
  return null
}
