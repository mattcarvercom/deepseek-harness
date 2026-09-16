# Agent Note: Subagent activity observation and the running-turn pill phase

Status: implemented

English | [中文](2026-09-15-subagent-activity-observation.zh.md)

## Problem

A published subagent delegation was opaque while it ran. The Web chat's running-turn pill — the deep-diving indicator with its elapsed clock — could only name the in-flight tool; a delegation minutes into a long child run displayed exactly what a just-submitted one did, and nothing distinguished a child mid-tool-call from one streaming model output. The same gap extended to the pill's other turn facts: while no assistant output was visible the subline could only report the newest running tool, so a turn waiting on a live background job was indistinguishable from any other quiet moment, and the fallback subline claimed "waiting for first token" even after the model had already produced output the user had not seen. All of this was client-local too: the elapsed clock anchored to when the client first observed the turn, so a reload mid-turn reset it, and the pill offered no way to recover from a stuck turn beyond a bare cancel. Every input needed to fix these facts already existed — the provider sees the child run's coarse phase transitions, the session log carries the turn's `turn/start` boundary, the job views publish live jobs, and the turn's first user message is a committed node — but the child's detailed event stream was not a surface a parent-session observer could read, and nothing projected a coarse version of it.

## Decision

Each subagent provider reports coarse activity through an observe-only `onActivity` callback on the start request, classified by [sessionEventActivityKind](../../../../packages/subagent/subagent/src/activity.ts) into the shared `SubagentActivityKind` — `tool` for a child tool call, `output` for a child assistant message, `other` for everything else. Reporting is observe-only by contract: it can never influence the run's timing, cancellation, or settlement. The delegation tool composes one fail-soft recorder per call: on the first observation, on each phase change, and on a 30-second heartbeat while a phase persists, it appends a `subagent/activity` event to the calling parent Session — the one package-owned durable event the tool appends, log-only and never model-visible — carrying the call id, the provider name, the kind, and the delegation's description truncated to 200 characters. An append failure logs one warning and disables emission for the rest of the call without touching the run; the recorder is disposed when the job settles, so no observation outlives its call.

The client folds the event into a per-session activity map ([SubagentActivityFeed](../../../../packages/client/ui-chat/src/client/subagent-activity.ts)): a `subagent/activity` upserts the newest fact under the delegating call id, a `tool/result` for that call prunes the entry, and a window replace or prepend re-scans the whole window in log order, so a replayed session reconstructs the identical map. The map reaches the pill through a session-scoped selector hook, and [derivePillPhase](../../../../packages/client/ui-chat/src/client/chat/pill-phase.ts) picks a single phase for the running turn from a fixed priority chain over published facts: an open compaction, a scheduled model-request retry, an in-flight subagent delegation carrying the newest activity fact, any other running tool, the assistant's live stream (a reasoning tail is `thinking`, anything else visible is `generating`), a live background job (newest by start time), and finally the honest fallback — `working` once the turn has visible assistant output, `first-token` while the request genuinely has no chunk. Each arm renders a locale-owned subline (`Waiting on child {label}`, `Running {tool}`, `Waiting for job {label}`, `Working…`, …), and the subagent arm alone offers the inspect-log action, which opens the call's trajectory view. Independently of the pill, the delegation's own tool row renders the coarse phase — producing output, running a tool, or working — as a locale-owned subline while the row is running, and never for a settled row.

The pill's elapsed clock anchors to the turn's logged start: the live `turn/start` boundary time while that boundary sits inside the loaded scope, and otherwise the new `startedAt` field on each [turn-outline](../../../../packages/session/session-turn-outline/README.md) entry — additive under the strict wire schema at projection stateVersion `3` — so a reload mid-turn keeps the real elapsed time. The action row grows with the turn: cancel always; cancel & re-run only once the turn has settled at least one tool result, where it resends the turn's own first user message read from the committed node through a confirmation dialog; and show log on the subagent arm.

## Alternatives considered

**Streaming the child session's event stream into the parent.** The child's log already records everything in detail, but re-exposing that stream on the parent makes the parent log a mirror of the child's, duplicates durable data across two sessions, and turns every child event into a parent append. Coarse phase classification at the provider boundary captures what the pill actually needs — which phase, and when it changed — at a rate a viewer can read.

**Client-side polling of the child session.** No stable client read channel exists for a child session mid-run; the tool result is the only settled surface, and a new polling transport would observe with more machinery what a one-line provider callback already provides.

**Unthrottled per-observation emission.** A chatty child yields a phase observation per child event; appending each would flood the parent log with sub-minute records no consumer can render. The phase-change-plus-heartbeat throttle bounds the record stream at the producer, where the phase semantics live.

**Deriving the clock from events inside the loaded window.** The running turn's `turn/start` falls outside a paged or reloaded window, and any later in-window event is not the turn's start. A durable per-turn `startedAt` in the whole-log turn outline — a projection fact, not a window fact — is the only anchor that survives reloads without a new wire format.

**Making `subagent/activity` model-visible.** The phase is a UI rendering of the child's progress; adding it to model requests would spend tokens on every later delegation in the session. The log-only record keeps the fact durable for the UI while leaving the model-visible surface untouched.

## Consequences

- A running delegation shows its label and coarse phase in the pill's subline and the coarse phase under its own tool row; both update on each phase change and at most every 30 seconds otherwise, and both disappear with the call's `tool/result` — live and after reload alike, because the fold is purely log-derived.
- The pill's subline is honest across every arm: a turn with visible output reports working, a turn genuinely before its first chunk reports waiting for the first token, and a turn waiting on a live job names the job.
- A reload mid-turn keeps the real elapsed clock through the new `turnOutline[].startedAt` anchor; the wire change is additive (stateVersion `3`), and cached projection rows re-fold on the version mismatch.
- Unknown-build readers meet the new type under the standard required-on-read rule and refuse such a log rather than skip it; builds from this change forward know and fold the type.
- Each delegation adds at most one `subagent/activity` record per 30 seconds per phase; a long single-phase child adds one record per half minute for the duration of that phase.
- The zh locale, the persistence catalog, the event producer/consumer graph, and the re-recorded Web goldens change with the new sublines; the goldens changed because the pill's visible text changed, not because any conversation behavior changed.

## Testing

The tool spec pins the recorder's first-observation, phase-change, and heartbeat emission, the no-emit inside the heartbeat window, the fail-soft disable on append failure, and disposal at settlement. The client fold spec pins the upsert, the prune on result, the replay identity across window replace and prepend, and feed disposal. The pill spec pins every arm of the phase chain, the reasoning-versus-text split of the streaming arm, the newest-job selection, and the working-versus-first-token fallback. The ChatView spec pins each subline's rendering and locale copy, the action set (cancel always; cancel & re-run gated on a settled tool result and resending the first user prompt; show log on the subagent arm), and the reload-stable clock anchor. The turn-outline specs pin the `startedAt` fold and the additive stateVersion `3` re-fold. The tool-row spec pins the subline appearing only while a running delegation row owns an activity fact, with the kind-based copy. The re-recorded Web goldens carry the corrected sublines.

## Related

- [Subagent run activity watchdog](2026-09-15-subagent-run-activity-watchdog.md) — the sibling bound on the same run: the watchdog fails a silent published run; this note observes a live one.
- [Compaction progress subline on the deep-diving pill](2026-09-14-compaction-progress-subline.md) — the pill-subline precedent; its arm opens this note's phase chain.
- [In-flight prompt visibility in the conversation flow](2026-09-14-inflight-prompt-visibility.md) — the neighboring turn-scoped fold sharing the running-turn scope.
- [Web background-job display](2026-08-08-web-background-job-display.md) — the job views the pill's job arm reads.
- [Retain ignorable external session events](../architecture/2026-08-30-retain-ignorable-external-session-events.md) — the required-on-read rule governing how this new log-only event behaves on unknown builds.
