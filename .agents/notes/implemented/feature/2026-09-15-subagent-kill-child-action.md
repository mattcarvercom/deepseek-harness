# Agent Note: The kill-child action on the running-turn pill

Status: implemented

English | [中文](2026-09-15-subagent-kill-child-action.zh.md)

## Problem

Kill control shipped a human-addressable `session.killSubagent` Remote, and activity observation gave the running-turn pill a subagent phase — but the pill never exposed the control. The kill is addressed by the child's durable session id, and no client-side surface carried that id: the activity payload observed the child's phase and label, not its address. A human watching an in-flight subagent phase had no way to stop that child from the surface displaying it, and no other in-turn surface carried the address.

## Decision

The `subagent/activity` payload gains an optional `childSessionId`, and the tool sets it only for in-process (local) runs: the run's `id` is then the published child session id that kill addresses. Out-of-process runs carry parent-namespace-unique ids that kill cannot reach, so the key is omitted and the pill hides the action. The key is truly absent rather than `undefined` — `exactOptionalPropertyTypes` applies at the emitter, the ui-chat fold, the pill derivation, and the `TurnStatus` call site — so a consumer that does not know the field simply never sees it.

The latch timing is explicit: in the scripted flow `onStart` fires synchronously inside `start()`, before the run exists, so the first activity record can legitimately predate the latch and carry no key; the id lands on the records after `start` resolves. A foreground call latches synchronously at resolution; a background call latches in the post-resolution microtask. The pill reflects the newest latched fact, so a pre-latch record renders the phase without the action until the id arrives.

The pill grows a `Kill child` action on its subagent arm, present only when the phase carries `childSessionId`. The click calls a new `killChild` entry on the ui-chat inject face, which `apply` maps to `session.killSubagent`. A failed kill — a non-ok `RemoteResult` or a transport fault — is swallowed: once the child is gone the kill is an accepted no-op, and the child's activity fact keeps the action mounted until the child settles, so the action is retryable by construction. The copy is locale-owned (`chat.action.killChild`).

## Alternatives considered

**Showing the child session id in the pill and leaving the kill to another surface.** The id is an internal address; displaying it adds no usable control at that location, and no other in-turn surface addresses a single child — the subagent panel is a post-hoc transcript surface, and `interrupt_agent` is model-owned.

**Mounting the kill on the subagent read-only composer or panel.** Those surfaces belong to the child session, while kill is a verb on the parent session's face. The pill is the surface that displays the in-flight phase, so the action that stops the observed run belongs there.

**Surfacing the kill failure in a toast.** The failure is either already moot (the child settled, making the kill an accepted no-op) or retryable (the child still runs, and the action stays mounted); a toast on a fire-and-return control that remains available until settlement is noise without an actionable state.

**Bumping `SESSION_FORMAT_VERSION`.** This is an optional field on an already ignorable payload: a build that does not know the event type ignores the event wholesale, and a build that does treats the field as optional. No structural change touches a known event.

**Carrying the id on the continuable branch too.** The continuable recorder never arms (no activity events, no pill arm), and continuable children have their own settlement notice and messaging/interrupt surfaces; no pill state would consume the address.

## Consequences

- A user can stop an in-process one-shot child directly from the running-turn pill; the kill is fire-and-return, and a repeat click on a gone child is an accepted no-op.
- Out-of-process (remote) children hide the action: their address is unreachable by kill, and a visible no-op button would mislead.
- Pre-latch records legitimately lack the key; until the latch lands — at most the records emitted before `start` resolves — the pill shows the phase without the action.
- `ISession` widens with `killSubagent`, so every client test-fixture session face must stub it; `FixtureSession`'s stub fails loud, so an unstubbed fake cannot pass silently.
- No new event type, no format-version bump, and no recorded-session output change: `subagent/activity` is UI-only and ignorable, so golden replays stay byte-identical.
- No new web e2e: the Remote transport is pinned by the kill-control session-client and remote specs, and the client specs pin the pill wiring end to end (fact to phase to button to inject to `Session`).

## Testing

The tool-subagent spec pins the latch: a background local run with a held gate lets the first record predate the latch (key absent) while post-latch records carry the id; a foreground run's pre-latch first record lacks the key and its later records carry it; the existing remote-run tests assert the key stays absent; the continuable test remains silent (no activity events). The ui-chat specs pin the client side: the fold upserts, replaces (a moved or dropped id is a changed fact), and omits the key; the rebuild carries the latched id until the call settles; the pill derivation carries the winning fact's id or omits it; `ChatView` renders the localized kill button for a latched fact, hides it for an unlatched one, and routes the click to the injected `killChild` with the child's id; the apply spec pins the `Session.killSubagent` call and the silent reject arm. The test-support runtime spec pins the bare `FixtureSession` stub failing loud on an unstubbed call. The cordis inspect-catalog regenerator pins the widened `ISession` declaration.

## Related

- [Subagent activity observation and the running-turn pill phase](2026-09-15-subagent-activity-observation.md) — the payload this note extends and the pill this note modifies.
- [Subagent kill control](2026-09-15-subagent-kill-control.md) — the `killSubagent` Remote this action calls.
- [Locale-owned client UI copy](../architecture/2026-08-23-locale-owned-client-ui-copy.md) — the dictionary home of the button copy.
