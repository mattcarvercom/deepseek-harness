# Agent Note: Subagent kill control

Status: implemented

English | [中文](2026-09-15-subagent-kill-control.zh.md)

## Problem

The subagent control family had a stop but no hard stop. `interrupt` is a cancel only: the child's turn is cancelled, unclaimed pending inbox work is preserved, and a resident continuable child stays resumable. The scoped drains (`drainContinuableDescendants`, `drainContinuableChildren`) are process-local teardown verbs the parent process issues against its own Agents while cleaning up, not a human-addressable control over one named child. A parent session that no longer wanted a child's work — a run stuck on the wrong path, a child that outlived its purpose — had no way to end it: the child's parked inbox messages would be claimed into later turns, a resident child remained resumable indefinitely, and a one-shot child could only be abandoned. The primitives for ending a child already existed — a user-cause `Agent.cancel` with inbox discard, the memoized close transaction that releases an epoch's subtree child-first, and the session controller's established pattern of thin Remotes over service primitives — but nothing composed them under a claimed parent authority, and no Remote exposed the result.

## Decision

One service primitive, one Remote. `SubagentRuntime.kill(targetSessionId, authority)` admits `SubagentKillAuthority` — a single kind, the durable direct-parent address a human client presented, with no live-ancestor form because kill has no model-authored consumer — and authorizes it against the live target's durable `SessionHeader.parentSession`. A resident continuable target is cancelled on its current turn with the user cause, its pending inbox work is durably discarded, and its residency epoch is closed through the memoized close transaction, which releases owned descendant Activations child-first. A live one-shot child is cancelled through its own Agent the same way, and the run's owner settles it as `aborted` and releases it as usual. The call is fire-and-return: the cancel signal and the disposal task are issued before it returns; an absent target — unknown, remote, or already settled — and a manager-less composition are accepted no-ops, and an already-closing epoch is left to its own teardown, which already stopped the target and owns the release. A kill that loses the race to a scoped drain never signals the target twice, because the first close owns the epoch.

The session controller exposes the primitive as `session/killSubagent` on `ctx.remote.session`: one request carrying the addressed parent session and the durable child session id, one receipt acknowledging that the kill signal was admitted, not that the child is quiescent. The command resolves the subagent service through a strict optional read — an unmounted composition fails `gateway/internal` rather than advertising a capability it lacks — and maps the primitive's `UNAUTHORIZED` to the remote `subagent/unauthorized` failure with the child id, wrapping everything else as `gateway/internal` with cause. It does not pre-verify that the addressed parent exists or owns the child: the primitive is the single authorization point, checking the claim against the live target, so a request naming an already-settled child is simply an accepted no-op.

First abort wins: the killed child's `turn/end` records the user cause, while a descendant whose turn was stopped by its parent's teardown records the parent cause. A killed child settles `aborted`, and its parent receives the existing settlement line for a stopped child, so the kill adds no new model-visible text and no new cancellation cause.

## Alternatives considered

**A kill cancellation cause.** The durable cancellation cause already records who asked: the user cause covers a kill exactly as it covers any user-originated stop, and a kill-only cause would leak a control convenience into `AgentCancelCause`, which every consumer folds.

**A kill tool for the model.** The model already owns `interrupt_agent` over its own children; a delegating model that destroys state it cannot recreate is not the authority a human parent is. Kill is therefore a human control on the session namespace — no subagent-namespace Remote and no tool — with the primitive reachable from other host code through the service method.

**Pre-verifying the claimed parent in the Remote.** Checking that the addressed session exists and names the child before calling the primitive would duplicate the primitive's authorization and add a second failure path for a request that is already a safe no-op; the single check against the live target is race-free by construction.

**Awaiting quiescence before the receipt.** Awaiting the disposal task would turn a fire-and-return control into a round trip of unknown length over a teardown that already logs its own failures; admission is the meaningful acknowledgement, and settlement is observed through the existing settlement notice.

## Consequences

- A human can end any live subagent child of an addressed session: the child's turn aborts with the user cause, its pending inbox work is discarded with a final `agent/inbox/spliced` record, and a resident child's residency epoch closes, so later prompts no longer resume it.
- The kill is race-safe: a concurrent scoped drain or an already-closing epoch never signals the target twice, and a teardown failure after the target is released is logged, not thrown.
- One-shot children are covered through the Agent registry, so a composition without a live Agent registry accepts the no-op rather than failing.
- The `subagent` namespace Remote surface gains no kill entry, and no kill receipt type is needed for a Remote that returns nothing; the session namespace owns the control.
- Each killed child costs its parent one settlement notice — the same stopped wording an interrupt produces — and no new model-visible surface exists.

## Testing

The continuation spec pins the primitive end to end: a mid-turn kill (the user-cause cancel with inbox discard followed by the parent-cause teardown cancel, the final spliced record with the canceled outcome, the user-cause `turn/end`, and the closed epoch), an idle kill (both cancels inbox-only, parked work discarded, epoch closed), a stranger claim that is rejected while the epoch stays open, a one-shot kill that settles the run `aborted`, foreign claims over non-subagent and settled targets, a kill that loses the race to a scoped drain signalling once, a child-first release of a live grandchild with the parent cause, and a kill-triggered teardown failure logged after release. The service spec pins the manager-less no-op. The session-controller host spec pins the unmounted failure, the accepted receipt with the forwarded authority, and the `UNAUTHORIZED` mapping to the remote failure; the client spec pins the `session/killSubagent` rule. The subagent surface test lists `kill` among the service's exposed operations.

## Related

- [Subagent activity observation and the running-turn pill phase](2026-09-15-subagent-activity-observation.md) — the live-run observation that a kill stops; its pill carries the kill-child action for a latched local child.
- [The kill-child action on the running-turn pill](2026-09-15-subagent-kill-child-action.md) — the pill action that calls this Remote.
- [Continuable subagents](2026-07-28-continuable-subagent-conversations.md) — the residency epoch a kill closes.
- [Adjacent-Agent messaging](../architecture/2026-08-27-adjacent-agent-steer-messaging.md) — the messaging and interrupt control family that kill extends.
