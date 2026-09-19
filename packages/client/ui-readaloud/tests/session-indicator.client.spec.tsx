// @vitest-environment jsdom
/**
 * Sidebar session-row indicator over the page-global active-read mirror: it
 * shows a labeled speaker button only for the session that is speaking
 * (either phase), hides itself for every other session, hides again when the
 * read settles back to idle, and stops the read on click without opening the
 * session row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh } from '../src/client/locales.ts'
import type { ReadAloudActiveRead, ReadAloudIndicatorProps } from '../src/client/slots.ts'
import { SessionIndicator } from '../src/client/SessionIndicator.tsx'

const t = makeTranslate(zh, commonZh)

/** Mount the indicator for one row over a live active-read store. */
function mount(sessionId: string, active: ReadAloudActiveRead) {
  const activeRead = createSnapshotStore(active)
  const stop = vi.fn()
  const props = {
    sessionId: sessionId as SessionId,
    useActiveRead: bindSnapshotSelector(activeRead),
    stop,
    t,
  } as unknown as ReadAloudIndicatorProps
  return { ...render(<SessionIndicator {...props} />), activeRead, stop }
}

afterEach(cleanup)

describe('SessionIndicator', () => {
  it('shows a labeled stop control for the speaking session in either phase', () => {
    for (const phase of ['synthesizing', 'playing'] as const) {
      const ui = mount('s1', { sessionId: 's1' as SessionId, phase })
      const indicator = ui.getByRole('button', { name: zh['indicator.stop'] })
      expect(indicator.getAttribute('title')).toBe(zh['indicator.stop'])

      fireEvent.click(indicator)
      expect(ui.stop).toHaveBeenCalledTimes(1)
      cleanup()
    }
  })

  it('stays hidden for other sessions and while idle', () => {
    const other = mount('s2', { sessionId: 's1' as SessionId, phase: 'playing' })
    expect(other.container.childElementCount).toBe(0)
    cleanup()

    const idle = mount('s1', { sessionId: undefined, phase: 'idle' })
    expect(idle.container.childElementCount).toBe(0)
    cleanup()

    const failed = mount('s1', { sessionId: 's1' as SessionId, phase: 'failed' })
    expect(failed.container.childElementCount).toBe(0)
  })

  it('appears when the read starts and hides again when it settles', () => {
    const ui = mount('s1', { sessionId: undefined, phase: 'idle' })
    expect(ui.container.childElementCount).toBe(0)

    act(() => {
      ui.activeRead.set({ sessionId: 's1' as SessionId, phase: 'playing' })
    })
    expect(ui.getByRole('button', { name: zh['indicator.stop'] })).toBeTruthy()

    act(() => {
      ui.activeRead.set({ sessionId: undefined, phase: 'idle' })
    })
    expect(ui.container.childElementCount).toBe(0)
  })
})
