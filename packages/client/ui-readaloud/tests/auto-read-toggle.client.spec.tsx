// @vitest-environment jsdom
/**
 * Composer auto-read toggle: the chip reflects the live preference (pressed
 * state and active styling), reads its localized label, and flips the
 * preference through the injected setter in both directions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh } from '../src/client/locales.ts'
import type { ReadAloudToggleProps } from '../src/client/slots.ts'
import { AutoReadToggle } from '../src/client/AutoReadToggle.tsx'

const t = makeTranslate(zh, commonZh)

/** Mount the toggle over a live preference store and a scripted setter. */
function mount(on = false) {
  const autoRead = createSnapshotStore(on)
  const setAutoRead = vi.fn()
  const props = {
    useAutoRead: bindSnapshotSelector(autoRead),
    setAutoRead,
    t,
  } as unknown as ReadAloudToggleProps
  return { ...render(<AutoReadToggle {...props} />), autoRead, setAutoRead }
}

afterEach(cleanup)

describe('AutoReadToggle', () => {
  it('shows the parked state and flips the preference on click', () => {
    const ui = mount(false)
    const button = ui.getByRole('button', { name: zh['toggle.label'] })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.hasAttribute('data-active')).toBe(false)

    fireEvent.click(button)

    expect(ui.setAutoRead).toHaveBeenCalledWith(true)
  })

  it('reflects the live preference and flips it back off', () => {
    const ui = mount(true)
    const button = ui.getByRole('button', { name: zh['toggle.label'] })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.hasAttribute('data-active')).toBe(true)

    fireEvent.click(button)

    expect(ui.setAutoRead).toHaveBeenCalledWith(false)
  })
})
