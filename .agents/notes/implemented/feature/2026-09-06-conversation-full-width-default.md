# Agent Note: Conversation transcript opens at full width

Status: implemented

English | [中文](2026-09-06-conversation-full-width-default.zh.md)

## Problem

The conversation column's shared width axis opened at an adaptive reading width — `clamp(680px, 64% of the column, 920px)` centered in the column ([Adaptive and drag-resizable conversation content width](../../archived/feature/2026-08-18-conversation-adaptive-content-width.md)). On wide displays the transcript sat as a narrow centered band in a several-thousand-pixel column, and the only way to fill the window was to drag a width handle in every new session — and only in the browsers where such a drag had persisted, because the preference lived in per-browser localStorage. The user wanted every session to start already full and the handles kept for the occasional narrowing.

## Decision

**The axis opens at the full usable width, and the drag is session-scoped.** `ConversationRoot.module.css` declares `--dsh-chat-content-width: var(--dsh-chat-user-width, max(640px, calc(var(--dsh-conversation-column-width, 0px) - 176px)))`. The 176px budget (88px per side: 24px inset + 40px handle strip + 24px safe zone) is unchanged — it is what keeps the handles placeable at every width — and the 640px floor matches the layout center-column minimum. `resolveContentWidth` in the component mirrors the fallback: with no active drag it returns the max, and a drag width clamps to `[640px, column − 176px]`.

**A drag narrows (or re-clamps) the current session only.** The committed width is held in a component ref, re-clamped against the column by the same ResizeObserver publication, and cleared when the session changes — every session opens at the full column, in every browser. The `localStorage` preference `dsh.conversation.contentWidth` is retired: the component no longer reads or writes it, so a value stored before this change is inert. No reset affordance is needed — a session switch is the reset.

The handles, their 40px strips and glow, the pointer-capture drag model, and the shared-axis relations (input card W + 32px, dock cards, user-bubble cap) all stand; only the axis's default term and the drag's durability changed.

## Alternatives considered

**Default to full width but keep the persisted preference.** A user who dragged to narrow would keep opening narrow: the very drag-to-expand annoyance this change removes would return after the first narrowing.

**Keep the 920px reading cap and add a "wide mode" toggle.** Adds a settings surface for what the handle already covers, and sessions would still start narrow.

**A per-browser persisted "open full" flag.** It would persist exactly the default the user wants everywhere; a flag never turned off is dead state.

## Consequences

- Every session — new or reopened, in every browser — opens the transcript at the full usable column; no drag-to-expand is needed.
- Prose line length on wide displays is no longer capped at ~113 characters, and code blocks and tool cards gain the full column width. A user who wants a narrower reading width drags a handle for that session.
- A narrowing survives window resizes within the session (re-clamped, restored when the window widens) but never crosses a session boundary or a page load.
- The persisted `dsh.conversation.contentWidth` key is inert in existing browsers; it is no longer written, and no migration or key bump is needed.
- The adaptive clamp, its 680px / 64% / 920px numbers, and the drag-persistence sentences in [Adaptive and drag-resizable conversation content width](../../archived/feature/2026-08-18-conversation-adaptive-content-width.md) are superseded by this decision; that note's ResizeObserver publication, handle geometry, and shared-axis relations stand.

## Testing

`skeleton.client.spec.tsx` (ui-conversation) pins the round trip: with no drag the override stays absent so the CSS fallback applies; an outward drag at the cap is a no-op that writes nothing to storage; an inward drag narrows to the exact committed width; a window shrink re-clamps the display and a widening restores it; a press without travel and a double-click leave the session width alone; and a session switch removes the override. `DSH_SNAPSHOT=replay pnpm run test:web` re-verifies the assembled browser.
