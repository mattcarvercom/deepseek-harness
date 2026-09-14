// @vitest-environment jsdom
// The real loadMermaid seam: the dynamic import resolves to the mermaid
// module under jsdom (rendering the diagrams themselves needs browser SVG
// geometry, which the web e2e owns).
import { describe, expect, it } from 'vitest'
import { loadMermaid } from '../src/markdown/mermaid.ts'

describe('loadMermaid', () => {
  it('resolves with the mermaid handle', async () => {
    const mermaid = await loadMermaid()
    expect(typeof mermaid.initialize).toBe('function')
    expect(typeof mermaid.render).toBe('function')
  })
})
