# Agent Note: Compaction progress subline under the deep-diving pill

Status: implemented

English | [中文](2026-09-14-compaction-progress-subline.zh.md)

## Problem

While a turn is running, the Web chat shows one indicator: the `Deep diving...` pill with its elapsed clock, which appears after a 15-second delay. When automatic compaction kicks off mid-turn — the expensive LLM summarization that can run for minutes — nothing distinguishes that state from ordinary model work: the pill reads identically while the model runs a tool and while it produces a multi-thousand-token summary. The open state is fully reconstructable from the already-logged `compaction/start` and `compaction/end` session events; it was simply not projected to the UI. Before this change the user learned that compaction had happened only after the fact, from the checkpoint summary node that appears after `compaction/summary`.

## Decision

The compaction Conversation node definition publishes the open automatic compaction's `compaction/start` envelope time to the owning turn through the existing Location-data channel: `buildLocationData` in [compaction.ts](../../../../packages/client/ui-chat/src/client/conversation-nodes/compaction.ts) returns a turn-scoped `compaction` value — an epoch-ms `number` under a merge-extended `ConversationTurnDataMap` key — set on `compaction/start`, retained across `compaction/summary`, and cleared on `compaction/end` with or without an error. Manual compactions (carrying a `sourceCommandId`) and turn-less compactions (`turn: null`) publish nothing: the definition's `match` rejects them, so they own no Context, and the manual path keeps its command-row presentation.

`TurnStatus` in [ChatView.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) reads the value through `useTurnDataValue` on the running turn's data store and renders it as a grey subline under the pill: the `chat.compacting` copy (`Compacting conversation...` / `正在压缩对话...`) plus its own clock anchored to the compaction start. The subline clock carries no 15-second gate — compaction is the interesting state, and the delay exists to keep the ordinary pill quiet on short turns — while the main pill clock keeps that gate. The `role="status"` live region moves from the pill to the two-line group so the subline's appearance is announced; both clocks stay `aria-hidden`. The copy lives in the chat locale dictionary.

## Alternatives considered

**A dedicated compaction node or badge.** A new node kind and transcript seat for a turn-level state, when the turn status group is the established place for turn-level progress. The Location-data channel exists precisely for such turn-scoped facts (precedent: the turn-process and turn-tail data keys).

**Reading the compaction events directly in ChatView.** Violates the conversation node discipline: components consume final node data or constrained Location hooks, not raw event windows; the definition-owned fold is the sanctioned path and stays replayable.

**Gating the subline clock with the same 15-second delay.** The user notices the turn going quiet during compaction; delaying the subline's own clock hides the moment they need it. The delay stays on the main pill, where it protects short turns.

**Tracking the open compaction in the Session snapshot.** Adds durable client state for a fact derivable from the two events already in the window; the engine's Location data is a replayable projection of exactly those events.

## Consequences

No new session events and no protocol change; model-visible-iff-logged stays untouched, and no recorded-session snapshot required re-recording. The subline appears only while the running turn has an open automatic compaction and disappears at `compaction/end`, whether it fails or not. A mid-turn reload loses nothing: the value derives from window events, so a client reassembled from the log redisplay the subline for a compaction still in flight.

## Testing

The `conversation-node-definitions` spec covers publishing on start, retaining across the summary, clearing on end with and without error, and the no-publish rule for manual and turn-less compactions; the `chat-view` spec covers the subline's appearance, its own clock, its disappearance, and its coexistence with the gated main clock. `verify-client-ui-i18n` passes on the new copy, and the `verify-agent-note-format` and `verify-translation-pairing` gates pass on this note.

## Related

- [Turn duration labels gain an hour unit](2026-09-09-turn-duration-hour-unit.md) — the main clock this subline sits beneath.
- [Queued manual compaction](2026-07-30-queued-manual-compaction.md) — the manual path that deliberately stays out of scope.
