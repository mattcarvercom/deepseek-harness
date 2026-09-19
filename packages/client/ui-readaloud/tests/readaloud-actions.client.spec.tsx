// @vitest-environment jsdom
/**
 * ReadAloudActions rendering and gestures: the speaker control reads a
 * speakable message on click and becomes a stop control while its message
 * synthesizes or plays; a message with no speakable text carries an
 * unavailable, explained control that fires nothing; a failed synthesis
 * surfaces inline while the control still offers a manual read; auto-read
 * fires once when a message becomes speakable while the preference is on —
 * including a finalized node arriving on an already mounted row — and never
 * for a preference flipped on later; and a read stops when a newer turn
 * arrives. The chat snapshot and the playback/preference stores are live
 * fixtures bound through the production selector binding.
 */
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  AssistantBlock, AssistantMessageNode, ChatNode, ChatSnapshot,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import { zh } from '../src/client/locales.ts'
import type { ReadAloudActionProps, ReadAloudStepActionProps } from '../src/client/slots.ts'
import {
  INITIAL_READALOUD_PLAYBACK, type ReadAloudPlaybackState,
} from '../src/client/director.ts'
import { ReadAloudActions, ReadAloudStepActions } from '../src/client/ReadAloudActions.tsx'

const t = makeTranslate(zh, commonZh)

/** One finalized assistant node carrying the given message in the given turn. */
function assistantStep(messageId: MessageId, blocks: readonly AssistantBlock[], turn: number) {
  const final: AssistantMessageNode = {
    kind: 'assistant',
    seq: 1,
    messageId,
    time: 1_000,
    turn,
    step: 1,
    blocks,
  }
  return {
    key: rowKey(messageId, turn),
    kind: 'assistant-step',
    data: {
      status: 'settled' as const,
      turn,
      step: 1,
      blocks,
      time: 1_000,
      finalNode: final,
    },
  } as unknown as ChatNode<'assistant-step'>
}

/** The fixture Chat snapshot: a row table of assistant nodes plus the turn timeline. */
function chatSnapshot(
  rows: Record<string, ChatNode<'assistant-step'> | undefined>,
  turnOrder: readonly number[],
): ChatSnapshot {
  return {
    order: Object.keys(rows),
    nodes: {
      get: (key: string) => rows[key],
      source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
      processSource: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
      values: () => Object.values(rows),
    },
    locations: { getTurn: () => [], getStep: () => [] },
    navigation: { items: () => [] },
    timeline: { turnOrder, turns: new Map() },
    legacy: {
      nodes: [],
      turnTimings: new Map(),
      turnEnds: new Map(),
      partial: null,
      runningCalls: [],
    },
  } as unknown as ChatSnapshot
}

function rowKey(messageId: MessageId, turn: number) {
  return `assistant/${String(messageId)}/${turn}`
}

interface MountOptions {
  messageId?: MessageId
  blocks?: readonly AssistantBlock[]
  turn?: number
  turnOrder?: readonly number[]
  inTranscript?: boolean
  /** Extra rows prepended before the target row, for scan-order coverage. */
  otherRows?: Record<string, unknown>
  playback?: ReadAloudPlaybackState
  autoRead?: boolean
  speak?: (messageId: MessageId, text: string) => void
  stop?: () => void
  spoken?: readonly MessageId[]
  generating?: boolean
  narrated?: boolean
}

/** Build the fixture stores and props both seats mount over. */
function controlProps(options: MountOptions = {}) {
  const messageId = options.messageId ?? ('m1' as MessageId)
  const turn = options.turn ?? 0
  const rows = {
    ...options.otherRows,
    ...options.inTranscript === false
      ? {}
      : {
        [rowKey(messageId, turn)]: assistantStep(
          messageId, options.blocks ?? [{ kind: 'text', text: 'hi' }], turn,
        ),
      },
  } as Record<string, ChatNode<'assistant-step'> | undefined>
  const chat = createSnapshotStore<ChatSnapshot>(
    chatSnapshot(rows, options.turnOrder ?? (options.inTranscript === false ? [] : [turn])),
  )
  const playback = createSnapshotStore<ReadAloudPlaybackState>(
    options.playback ?? INITIAL_READALOUD_PLAYBACK,
  )
  const autoRead = createSnapshotStore<boolean>(options.autoRead ?? false)
  const speak = (options.speak ?? vi.fn()) as (messageId: MessageId, blocks: readonly unknown[]) => void
  const stop = (options.stop ?? vi.fn()) as () => void
  const setTextHighlight = vi.fn()
  const wasGenerating = vi.fn(() => options.generating ?? true)
  const wasNarrated = vi.fn(() => options.narrated ?? false)
  const spoken = options.spoken ?? []
  const props = {
    messageId,
    useChat: bindSnapshotSelector(chat),
    usePlayback: bindSnapshotSelector(playback),
    useAutoRead: bindSnapshotSelector(autoRead),
    speak,
    stop,
    setTextHighlight,
    wasSpoken: (id: MessageId) => spoken.includes(id),
    wasGenerating,
    wasNarrated,
    t,
  }
  return {
    props,
    chat,
    playback,
    autoRead,
    speak,
    stop,
    setTextHighlight,
    wasGenerating,
    wasNarrated,
    messageId,
  }
}

/** Mount the closing-message control over a fixed chat snapshot and live stores. */
function mount(options: MountOptions = {}) {
  const control = controlProps(options)
  return {
    ...render(<ReadAloudActions {...(control.props as unknown as ReadAloudActionProps)} />),
    ...control,
  }
}

/** Mount the working-step control over the same fixtures. */
function mountStep(options: MountOptions = {}) {
  const control = controlProps(options)
  return {
    ...render(<ReadAloudStepActions {...(control.props as unknown as ReadAloudStepActionProps)} />),
    ...control,
  }
}

afterEach(cleanup)

describe('ReadAloudActions', () => {
  it('reads a speakable message on click and keeps the speak face', () => {
    const ui = mount({ blocks: [{ kind: 'text', text: 'Hello **world**' }] })
    const button = ui.getByLabelText(zh['actions.speak'])
    expect(button.hasAttribute('aria-disabled')).toBe(false)
    expect(button.hasAttribute('data-unavailable')).toBe(false)

    fireEvent.click(button)

    expect(ui.speak).toHaveBeenCalledWith(ui.messageId, expect.arrayContaining([
      expect.objectContaining({ text: 'Hello world' }),
    ]))
    expect(ui.stop).not.toHaveBeenCalled()
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('becomes a stop control while its message synthesizes or plays', () => {
    for (const phase of ['synthesizing', 'playing'] as const) {
      const ui = mount({ playback: { messageId: 'm1' as MessageId, phase, highlight: undefined } })
      const button = ui.getByLabelText(zh['actions.stop'])
      expect(button.getAttribute('aria-pressed')).toBe('true')
      expect(button.hasAttribute('data-active')).toBe(true)

      fireEvent.click(button)

      expect(ui.stop).toHaveBeenCalledTimes(1)
      expect(ui.speak).not.toHaveBeenCalled()
      cleanup()
    }
  })

  it('leaves another message alone while that one plays', () => {
    const ui = mount({ playback: { messageId: 'm2' as MessageId, phase: 'playing', highlight: undefined } })
    const button = ui.getByLabelText(zh['actions.speak'])
    expect(button.hasAttribute('data-active')).toBe(false)

    fireEvent.click(button)

    expect(ui.speak).toHaveBeenCalledWith(ui.messageId, expect.arrayContaining([
      expect.objectContaining({ text: 'hi' }),
    ]))
    expect(ui.stop).not.toHaveBeenCalled()
  })

  it('is unavailable and explained when the message carries no speakable text', () => {
    const ui = mount({ blocks: [{ kind: 'text', text: '```\ncode\n```' }] })
    const button = ui.getByLabelText(zh['actions.speak'])
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('data-unavailable')).toBe(true)

    const describedBy = button.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy!)!.textContent).toBe(zh['actions.unavailable'])

    fireEvent.click(button)
    expect(ui.speak).not.toHaveBeenCalled()
    expect(ui.stop).not.toHaveBeenCalled()
  })

  it('shows the synthesis failure and still offers a manual read', () => {
    const ui = mount({ playback: { messageId: 'm1' as MessageId, phase: 'failed', highlight: undefined } })

    expect(ui.getByRole('status').textContent).toBe(zh['error.synthesis'])

    const button = ui.getByLabelText(zh['actions.speak'])
    fireEvent.click(button)
    expect(ui.speak).toHaveBeenCalledWith(ui.messageId, expect.arrayContaining([
      expect.objectContaining({ text: 'hi' }),
    ]))
  })

  it('auto-reads a speakable message once when the preference is on', () => {
    const ui = mount({ autoRead: true, blocks: [{ kind: 'text', text: 'Hello **world**' }] })

    expect(ui.speak).toHaveBeenCalledTimes(1)
    expect(ui.speak).toHaveBeenCalledWith(ui.messageId, expect.arrayContaining([
      expect.objectContaining({ text: 'Hello world' }),
    ]))

    ui.rerender(<ReadAloudActions {...(ui.props as unknown as ReadAloudActionProps)} />)
    expect(ui.speak).toHaveBeenCalledTimes(1)
  })

  it('auto-reads when the finalized node arrives on an already mounted row', () => {
    const ui = mount({ autoRead: true, inTranscript: false })
    expect(ui.speak).not.toHaveBeenCalled()

    act(() => {
      ui.chat.set(chatSnapshot(
        { [rowKey(ui.messageId, 0)]: assistantStep(ui.messageId, [{ kind: 'text', text: 'hi' }], 0) },
        [0],
      ))
    })

    expect(ui.speak).toHaveBeenCalledTimes(1)
    expect(ui.speak).toHaveBeenCalledWith(ui.messageId, expect.arrayContaining([
      expect.objectContaining({ text: 'hi' }),
    ]))
  })

  it('does not auto-read a message the Session already read', () => {
    const ui = mount({ autoRead: true, spoken: ['m1' as MessageId] })
    expect(ui.speak).not.toHaveBeenCalled()
  })

  it('does not auto-read a fenced-only message even when the preference is on', () => {
    const ui = mount({ autoRead: true, blocks: [{ kind: 'text', text: '```\ncode\n```' }] })
    expect(ui.speak).not.toHaveBeenCalled()
  })

  it('reads only through the explicit click while the preference is off', () => {
    const ui = mount({ autoRead: false })
    expect(ui.speak).not.toHaveBeenCalled()

    fireEvent.click(ui.getByLabelText(zh['actions.speak']))

    expect(ui.speak).toHaveBeenCalledTimes(1)
  })

  it('does not re-read an already mounted row when the preference flips on later', () => {
    const ui = mount({ autoRead: false })
    expect(ui.speak).not.toHaveBeenCalled()

    act(() => {
      ui.autoRead.set(true)
    })

    expect(ui.speak).not.toHaveBeenCalled()
  })

  it('does not auto-read a message the Session never watched generate', () => {
    const ui = mount({ autoRead: true, generating: false })
    expect(ui.speak).not.toHaveBeenCalled()
  })

  it('does not auto-read a message streaming narration already read', () => {
    const ui = mount({ autoRead: true, narrated: true })
    expect(ui.speak).not.toHaveBeenCalled()
  })

  it('keeps reading when a newer turn arrives, so the next voice hands over', () => {
    const ui = mount({
      turn: 0,
      turnOrder: [0, 1],
      playback: { messageId: 'm1' as MessageId, phase: 'playing', highlight: undefined },
    })
    expect(ui.stop).not.toHaveBeenCalled()
  })

  it('keeps playing its read while it is the latest turn', () => {
    const ui = mount({
      turn: 1,
      turnOrder: [0, 1],
      playback: { messageId: 'm1' as MessageId, phase: 'playing', highlight: undefined },
    })
    expect(ui.stop).not.toHaveBeenCalled()
  })

  it('skips rows that are not its own assistant message', () => {
    const ui = mount({
      otherRows: {
        'user:1': { kind: 'user' },
        [rowKey('m2' as MessageId, 0)]: assistantStep(
          'm2' as MessageId, [{ kind: 'text', text: 'other' }], 0,
        ),
      },
    })
    expect(ui.getByLabelText(zh['actions.speak'])).toBeTruthy()
  })

  it('is unavailable for a message that is not in the transcript', () => {
    const ui = mount({ inTranscript: false })
    const button = ui.getByLabelText(zh['actions.speak'])
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(ui.speak).not.toHaveBeenCalled()
  })

  it('flips to the stop control when its playback state arrives', () => {
    const ui = mount()
    expect(ui.getByLabelText(zh['actions.speak'])).toBeTruthy()

    act(() => {
      ui.playback.set({ messageId: ui.messageId, phase: 'synthesizing', highlight: undefined })
    })

    const button = ui.getByLabelText(zh['actions.stop'])
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.hasAttribute('data-active')).toBe(true)
  })
})

describe('ReadAloudStepActions', () => {
  it('renders no control at all for a step with no speakable text', () => {
    const ui = mountStep({ blocks: [{ kind: 'text', text: '```\ncode\n```' }] })
    expect(ui.container.childElementCount).toBe(0)
  })

  it('reads a speakable working step on click', () => {
    const ui = mountStep({ blocks: [{ kind: 'text', text: 'working **note**' }] })
    const button = ui.getByLabelText(zh['actions.speak'])
    expect(button.hasAttribute('data-unavailable')).toBe(false)

    fireEvent.click(button)

    expect(ui.speak).toHaveBeenCalledWith(ui.messageId, expect.arrayContaining([
      expect.objectContaining({ text: 'working note' }),
    ]))
  })

  it('flips to the stop control while its step synthesizes', () => {
    const ui = mountStep({ playback: { messageId: 'm1' as MessageId, phase: 'synthesizing', highlight: undefined } })
    expect(ui.getByLabelText(zh['actions.stop']).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('read-along highlight publishing', () => {
  it('publishes the spoken range while playing and clears it when the read settles', () => {
    const ui = mount({
      playback: {
        messageId: 'm1' as MessageId,
        phase: 'playing',
        highlight: { blockIndex: 0, ranges: [{ start: 0, end: 5 }] },
      },
    })

    expect(ui.setTextHighlight).toHaveBeenCalledWith({
      blockIndex: 0,
      ranges: [{ start: 0, end: 5 }],
    })

    act(() => {
      ui.playback.set({ messageId: undefined, phase: 'idle', highlight: undefined })
    })

    expect(ui.setTextHighlight).toHaveBeenLastCalledWith(undefined)
  })

  it('clears the highlight when its entry unmounts mid-read', () => {
    const ui = mount({
      playback: {
        messageId: 'm1' as MessageId,
        phase: 'playing',
        highlight: { blockIndex: 0, ranges: [{ start: 1, end: 4 }] },
      },
    })
    expect(ui.setTextHighlight).toHaveBeenLastCalledWith({
      blockIndex: 0,
      ranges: [{ start: 1, end: 4 }],
    })

    ui.unmount()

    expect(ui.setTextHighlight).toHaveBeenLastCalledWith(undefined)
  })
})
