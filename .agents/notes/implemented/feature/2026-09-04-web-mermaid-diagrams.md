# Agent Note: Web markdown renders mermaid diagrams

Status: implemented

English | [中文](2026-09-04-web-mermaid-diagrams.zh.md)

## Problem

`MarkdownText` renders untrusted GFM and TeX math, but a ` ```mermaid ` fence fell through to the plain `CodeBlock` arm: shiki has no mermaid grammar, so a reply that drew a diagram showed its literal source. The renderer had to treat the fence source as untrusted model content, follow the active palette, add no cost to the streaming path, and stay out of the shell bundle for sessions that never draw a diagram.

## Decision

Settled mermaid fences draw as inline SVG; streaming fences keep the plain code block, matching the TeX settled-only precedent from the [streaming fence highlight note](2026-08-20-web-streaming-fence-highlight.md).

- **`MermaidDiagram`** (`packages/client/ui-primitives/src/markdown/MermaidDiagram.tsx`) renders a fence's source after settlement. It loads the engine through **`loadMermaid()`** (`src/markdown/mermaid.ts`): a dynamic import split from the shell bundle that resolves to the mermaid handle. Loading through the local module — not the bare specifier at the call site — gives the unit lane a deterministic stub point; concurrently imported externalized bare specifiers are not interceptable there.
- Each render calls `initialize({ startOnLoad: false, securityLevel: 'strict', theme })` then `render(id, code)` with a unique `dsh-mermaid-N` id. `securityLevel: 'strict'` sanitizes the emitted SVG through mermaid's DOMPurify pass and disables click bindings — required because diagram source is untrusted model output that could otherwise encode navigation or script in node events. The sanitized SVG is injected into a card styled from the `--dsw-alias-markdown-code-block` token; its `svg` scales to the column (`max-width: 100%; height: auto`).
- The component follows `body[data-ds-dark-theme]` through a MutationObserver in `useSyncExternalStore`, re-renders on a palette flip with mermaid's `dark` or `default` theme, and keeps the previous SVG while the re-render is in flight instead of falling back to the source.
- A parse error, a non-Error rejection, or a failed lazy chunk load renders the locale-owned failure line (new `markdown.mermaid.renderError` label, threaded through the `MarkdownLabels.mermaid` field and all five label builders) plus the fence source in a code block, with mermaid's own message shown verbatim after the line.
- The settled card carries two top-right actions (locale-owned `markdown.mermaid.copyImage`/`copiedImage` labels). **Copy source** reuses the code block's `writeClipboard` path with the same one-second confirmation. **Copy image** rasterizes the rendered `svg` through `src/markdown/mermaid-image.ts` — clone the node, size it from its `viewBox`, load it as an `image/svg+xml` object URL into an `Image`, and draw it onto a canvas whose `toBlob` yields the PNG — then writes it with `navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])`. Fallbacks degrade to a download instead of an error: a refused clipboard write downloads the PNG (`mermaid-diagram.png`), and a failed rasterization (undecodable SVG, no 2d context, no canvas PNG) downloads the standalone SVG source (`mermaid-diagram.svg`).

## Testing

Package tests bound the state machine with the loader stubbed — jsdom lacks the CSSStyleSheet constructor and the SVG geometry (`getBBox`) that mermaid's layout needs, so the real engine cannot render there: success, loading, parse-error, string-rejection, load-rejection, dark-at-mount, palette flip, unmount-before-result, the StrictMode double effect, and the `renderCode` fence arms. A separate spec loads the real module through the seam to pin the resolution. The keyless Web replay lane seeds a settled reply with one valid flowchart and one unparseable fence, and the golden (`apps/web/tests/expected/markdown-mermaid/ui.expected.md`) pins the SVG's ARIA tree — the node labels — the failure line, and the fallback source.

## Alternatives considered

**Import mermaid statically.** Puts the ~1 MB engine into the shell bundle that every session loads, for a feature most replies never use.

**Render while streaming too.** mermaid's render is asynchronous and the source is incomplete mid-stream, so the diagram would re-render on every chunk; the TeX precedent settles only.

**Render with click bindings (`securityLevel: 'loose'`).** Diagram source is untrusted; node click events could navigate the user's browser. Strict forbids interactivity; diagrams do not need any.

**Sanitize with a hand-rolled pass over the loose SVG.** Re-derives the DOMPurify coverage that mermaid's strict level already applies for the same guarantee.

**Render in a worker.** mermaid's render mutates a temporary DOM node for layout; it is not worker-safe.

## Consequences

The first settled fence in a page pays the chunk fetch and first render; later diagrams reuse the loaded module. Diagrams are non-interactive and re-render on palette flips. A diagram's node labels appear in the stable ARIA snapshot, so a new diagram fixture records its golden once. `dsh-client-ui-primitives` declares mermaid directly (`^11.16.0`), the same version the root workspace already resolves for the documentation site.
