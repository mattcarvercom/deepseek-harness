// @vitest-environment jsdom
/**
 * Opt-in read-along highlight: settled Markdown marks exactly the given
 * Markdown source ranges, leaves characters outside them plain, splits
 * ranges across inline nodes, and renders a byte-identical DOM to the
 * unhighlighted pass when no range intersects (including an empty list).
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

const MARKDOWN = 'A **bold** word and `code`.'

function marks(container: HTMLElement): string[] {
  return [...container.querySelectorAll('mark')].map(node => node.textContent ?? '')
}

it('renders no marks and byte-identical DOM without an intersecting range', () => {
  const plain = render(<MarkdownText text={MARKDOWN} />)
  const empty = render(<MarkdownText text={MARKDOWN} highlight={[]} />)

  expect(marks(plain.container)).toEqual([])
  expect(empty.container.innerHTML).toBe(plain.container.innerHTML)
})

it('marks the source range spanning text and emphasis', () => {
  // Source offsets: ` word and ` occupies 10..19 between the two emphasis delimiters.
  const { container } = render(<MarkdownText text={MARKDOWN} highlight={[{ start: 10, end: 19 }]} />)

  expect(marks(container)).toEqual([' word and'])
  expect(container.querySelector('strong')?.textContent).toBe('bold')
})

it('marks disjoint ranges across separate inline nodes', () => {
  const { container } = render(<MarkdownText
    text={MARKDOWN}
    highlight={[{ start: 4, end: 8 }, { start: 20, end: 24 }]}
  />)

  expect(marks(container)).toEqual(['bold', 'code'])
})

it('leaves nodes without an intersecting range plain', () => {
  const { container } = render(<MarkdownText
    text={MARKDOWN}
    highlight={[{ start: 100, end: 110 }]}
  />)

  expect(marks(container)).toEqual([])
  expect(container.textContent).toBe('A bold word and code.')
})

it('marks a growing streaming message without freezing a stale range', () => {
  const view = render(<MarkdownText text={'Alpha done. Beta running'} streaming highlight={[{ start: 0, end: 11 }]} />)
  expect(marks(view.container)).toEqual(['Alpha done.'])

  view.rerender(<MarkdownText
    text={'Alpha done. Beta running on and on'}
    streaming
    highlight={[{ start: 12, end: 16 }]}
  />)

  expect(marks(view.container)).toEqual(['Beta'])
})
