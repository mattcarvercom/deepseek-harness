/**
 * Lazy mermaid module load.
 *
 * The dynamic import keeps the mermaid diagram engine out of the shell
 * bundle: its chunk fetches only when the first settled mermaid fence
 * renders. Loading through this local module (rather than the bare
 * specifier at the call site) keeps the module-load failure path testable
 * in the unit lane, where concurrently imported externalized bare
 * specifiers are not interceptable.
 */

import type { Mermaid } from 'mermaid'

/**
 * Load the mermaid module.
 * @returns the default-exported mermaid handle.
 */
export function loadMermaid(): Promise<Mermaid> {
  return import('mermaid').then(({ default: mermaid }) => mermaid)
}
