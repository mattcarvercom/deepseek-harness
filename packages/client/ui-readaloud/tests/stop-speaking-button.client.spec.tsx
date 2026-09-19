// @vitest-environment jsdom
/**
 * Composer playback controls over the page-global active-read mirror: a
 * pause/resume chip and a stop chip show while its own Session speaks (any
 * live phase), stay hidden for another Session or an idle/failed read,
 * appear when a read starts, and pause, resume, or stop the active read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh } from '../src/client/locales.ts'
import type { ReadAloudActiveRead, ReadAloudStopProps } from '../src/client/slots.ts'
import { StopSpeakingButton } from '../src/client/StopSpeakingButton.tsx'

const t = makeTranslate(zh, commonZh)

/** Mount the control for one Session over a live active-read store. */
function mount(sessionId: string, active: ReadAloudActiveRead) {
  const activeRead = createSnapshotStore(active)
  const stop = vi.fn()
  const pause = vi.fn()
  const resume = vi.fn()
  const props = {
    sessionId: sessionId as SessionId,
    useActiveRead: bindSnapshotSelector(activeRead),
    stop,
    pause,
    resume,
    t,
  } as unknown as ReadAloudStopProps
  return { ...render(<StopSpeakingButton {...props} />), activeRead, stop, pause, resume }
}

afterEach(cleanup)

describe('StopSpeakingButton', () => {
  it('shows both chips for the speaking Session and stops on click', () => {
    for (const phase of ['synthesizing', 'playing', 'paused'] as const) {
      const ui = mount('s1', { sessionId: 's1' as SessionId, phase })
      const toggle = phase === 'paused' ? zh['actions.resume'] : zh['actions.pause']
      expect(ui.getByRole('button', { name: toggle })).toBeTruthy()

      fireEvent.click(ui.getByRole('button', { name: zh['actions.stop'] }))
      expect(ui.stop).toHaveBeenCalledTimes(1)
      cleanup()
    }
  })

  it('pauses a playing read and resumes a paused one', () => {
    const ui = mount('s1', { sessionId: 's1' as SessionId, phase: 'playing' })

    fireEvent.click(ui.getByRole('button', { name: zh['actions.pause'] }))
    expect(ui.pause).toHaveBeenCalledTimes(1)

    act(() => {
      ui.activeRead.set({ sessionId: 's1' as SessionId, phase: 'paused' })
    })
    fireEvent.click(ui.getByRole('button', { name: zh['actions.resume'] }))
    expect(ui.resume).toHaveBeenCalledTimes(1)
  })

  it('stays hidden for another Session and for inactive phases', () => {
    const other = mount('s2', { sessionId: 's1' as SessionId, phase: 'playing' })
    expect(other.container.childElementCount).toBe(0)
    cleanup()

    const idle = mount('s1', { sessionId: undefined, phase: 'idle' })
    expect(idle.container.childElementCount).toBe(0)
    cleanup()

    const failed = mount('s1', { sessionId: 's1' as SessionId, phase: 'failed' })
    expect(failed.container.childElementCount).toBe(0)
  })

  it('appears as soon as the read starts and hides when it settles', () => {
    const ui = mount('s1', { sessionId: undefined, phase: 'idle' })
    expect(ui.container.childElementCount).toBe(0)

    act(() => {
      ui.activeRead.set({ sessionId: 's1' as SessionId, phase: 'synthesizing' })
    })
    expect(ui.getByRole('button', { name: zh['actions.stop'] })).toBeTruthy()

    act(() => {
      ui.activeRead.set({ sessionId: undefined, phase: 'idle' })
    })
    expect(ui.container.childElementCount).toBe(0)
  })
})
