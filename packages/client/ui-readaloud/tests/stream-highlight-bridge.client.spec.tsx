// @vitest-environment jsdom
/**
 * StreamHighlightBridge over a live playback store: it publishes the
 * streaming read's highlight (a read with no durable message id) through the
 * key-bound setter, stays quiet for a manually read durable message, clears
 * when the read goes idle, and clears when it unmounts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import { zh } from '../src/client/locales.ts'
import {
  INITIAL_READALOUD_PLAYBACK, type ReadAloudPlaybackState,
} from '../src/client/director.ts'
import type { ReadAloudStreamHighlightProps } from '../src/client/slots.ts'
import { StreamHighlightBridge } from '../src/client/StreamHighlightBridge.tsx'

const t = makeTranslate(zh, commonZh)

const HL = { blockIndex: 0, ranges: [{ start: 0, end: 5 }] }

/** Mount the bridge over a live playback store and scripted setter. */
function mount(playback: ReadAloudPlaybackState) {
  const store = createSnapshotStore(playback)
  const setTextHighlight = vi.fn()
  const props = {
    usePlayback: bindSnapshotSelector(store),
    setTextHighlight,
    t,
  } as unknown as ReadAloudStreamHighlightProps
  return { ...render(<StreamHighlightBridge {...props} />), store, setTextHighlight }
}

afterEach(cleanup)

describe('StreamHighlightBridge', () => {
  it('publishes the streaming read highlight and clears when it goes idle', () => {
    const ui = mount({ messageId: undefined, phase: 'playing', highlight: HL })

    expect(ui.setTextHighlight).toHaveBeenCalledWith(HL)

    act(() => {
      ui.store.set(INITIAL_READALOUD_PLAYBACK)
    })

    expect(ui.setTextHighlight).toHaveBeenLastCalledWith(undefined)
  })

  it('stays quiet for a read bound to a durable message', () => {
    const ui = mount({ messageId: 'm1' as MessageId, phase: 'playing', highlight: HL })

    expect(ui.setTextHighlight).not.toHaveBeenCalled()
  })

  it('publishes nothing when it mounts without an active streaming read', () => {
    const ui = mount(INITIAL_READALOUD_PLAYBACK)

    ui.unmount()

    expect(ui.setTextHighlight).not.toHaveBeenCalled()
  })

  it('clears the mark when it unmounts mid-read', () => {
    const ui = mount({ messageId: undefined, phase: 'synthesizing', highlight: HL })
    expect(ui.setTextHighlight).toHaveBeenCalledWith(HL)

    ui.unmount()

    expect(ui.setTextHighlight).toHaveBeenLastCalledWith(undefined)
  })
})
