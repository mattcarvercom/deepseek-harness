# Agent Note: The single-line deep-diving pill

Status: implemented

English | [中文](2026-09-15-single-line-deep-diving-pill.zh.md)

## Problem

The running-turn pill grew past its one-line footprint. The group was a flex column: the shimmering `Deep diving...` label and its gated clock, the phase subline beneath it (compaction, retry, child, tool, job, or assistant-stream phase), and the action row beneath that (cancel, then the conditional cancel & re-run, show log, kill child). A turn waiting on a live background job — one short phase label and one always-present control — spent up to three lines of conversation height.

## Decision

`TurnStatus` in [ChatView.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) renders the pill as a single flex row: the shimmer label, the gated main clock, a locale-owned interpunct separator, the phase subline, and the action set.

- The separator is the new `chat.pill.separator` copy (` · `) in the chat locale dictionary; punctuation spacing is a localization decision, so the dictionary owns it. It is `aria-hidden` and colored with the caption token.
- The subline keeps its per-arm localized text and its ungated clock, and gains `font-style: italic` in the shared caption style so it reads as subordinate to the label on the same line. The `role="status"` live region stays on the group, so the subline's appearance and changes are still announced; both clocks stay `aria-hidden`.
- Every action is a feature-local round icon-only control: 22-px circular buttons carrying 14-px design-system glyphs, each with its existing localized copy as the accessible name via `aria-label` — cancel with the bold fill close icon (`IconCloseFill14`), cancel & re-run with the circular arrow (`IconRefreshOutline16`), show log on the subagent arm with the document-and-pen glyph (`IconListPenOutline16`), and kill child for a latched local child with the filled stop square (`IconStopFill16`). The ui-primitives catalog has no icon-only `Button` variant, and its guidance names the feature package the right home for genuinely specific chrome; the glyphs are the design system's own for each action, so an icon names its verb without a label.

## Alternatives considered

**Keeping the conditional actions as text-labeled buttons.** The first draft of this change kept cancel & re-run, show log, and kill child as outline text buttons after the round cancel. The labels read at a glance, but three words widen the row, and the icon form loses nothing: each glyph is the design system's own for the action, and the accessible name stays the full localized copy for keyboard and screen-reader users.

**A ui-primitives `Button` for the cancel.** The catalog's variants carry labels and an optional leading icon; none renders a small glyph inside a round target. Widening a shared primitive for one use inverts its promotion rule.

**The outline close glyph, or a text glyph.** The 12-px outline variant reads as a thin text glyph inside the round button; the design system's bold fill close icon is the same X with a stroke weight that holds at that size.

**No separator, or a heavier symbol.** A bare space is ambiguous against the label's trailing ellipsis, and a dash or bar reads as a data delimiter. The interpunct is the lightest unambiguous pause, and owning it in the dictionary leaves room for a locale to adjust it.

**Keeping the subline on its own row but shrinking it.** Keeps the vertical cost this change exists to remove.

## Consequences

An active turn takes one conversation line instead of up to three, and its whole action set is icons: each action's accessible name is the existing localized copy, so the pointer, keyboard, and screen-reader paths are unchanged in name and wiring. The pill's visible text changes, so the Web golden outputs that contain a running pill were re-recorded; each diff is the pill line only. No session event, protocol, or contract change: the phase derivation, the Location-data channel, and the inject face are untouched.

## Testing

The `chat-view` spec asserts the one-line format per phase arm, the separator, that each action button is icon-only (no text content), and the cancel, cancel & re-run, show log, and kill child clicks through their accessible names; the `aria-hidden` count assertions include the separator but not the glyphs. The re-recorded Web goldens carry the new line. `verify-client-ui-i18n` passes on the separator copy, and the note format and translation-pairing gates pass on this note.

## Related

- [Compaction progress subline on the deep-diving pill](2026-09-14-compaction-progress-subline.md) — the subline this note folds into the pill line. Its Location-data, ungated-clock, and live-region decisions stand; its two-line layout is replaced by this note.
- [Subagent activity observation and the running-turn pill phase](2026-09-15-subagent-activity-observation.md) — the phase arms and actions the one-line pill renders.
- [The kill-child action on the running-turn pill](2026-09-15-subagent-kill-child-action.md) — the kill child action on the subagent arm.
