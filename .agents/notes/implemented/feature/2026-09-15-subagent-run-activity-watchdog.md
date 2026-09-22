# Agent Note: Subagent run activity watchdog

Status: implemented

English | [中文](2026-09-15-subagent-run-activity-watchdog.zh.md)

## Problem

A published subagent run had no time bound of its own. The Codex wire settles a published turn only on a `turn/completed` notification or the child's failure, and the app-server child can stay alive, keep the stdio stream open, and emit no further protocol frames — the complement of the pre-publication silence the [handshake deadline](2026-09-15-codex-handshake-deadline.md) bounds. The Claude Code stream has the same complement: after the query is published, the SDK stream can stop yielding messages while the child process stays up, and the `for await` consumer waits on the next value forever. In both cases the run, its tool call, and the session state built on them wait for an external actor — cancellation, a kill, or a server restart — with no failure, no diagnostic, and no retry. The shared `dsh-timeout` primitives could not fill this gap: `idleWatchdog` arms only while an iterator demand is outstanding and clears on resolution, so it cannot bound a Codex push-style frame stream that holds no demand between frames, and neither primitive carries the labeled detail and the provider-owned trip action a subagent run failure needs.

## Decision

Both product providers' configurations accept `runActivityTimeoutMs`: a non-negative finite number no greater than the shared `MAX_TIMER_DELAY_MS`, schema default `300_000`, with `0` restoring the unbounded run. The value flows through each provider's run spec to the run-lifecycle code that owns the watchdog. The Codex wire arms the timer when the run submits its turn, resets it on every app-server frame it observes — notifications and server-to-client requests, labeled `notification:` or `request:` plus method — and fails the run at the stage it is in when the deadline elapses, with category `transport` and a detail naming the last observed frame or `none`. The Claude Code attempt arms the same shape of watchdog when the query is published, resets it on every SDK stream message with a `type:subtype` label, and on trip closes the query — the stream then ends cleanly and the child tears down through the normal path — after which the catch maps the trip to a `query-run` failure with category `transport` and the same detail shape, overriding the invalid-result failure the closed stream would otherwise produce; the attempt's `finally` clears the watchdog. A `runActivityTimeoutMs` of `0` arms nothing and leaves the run unbounded, as before.

The Codex wire closes the terminal-mismatch facet of the same hole at the same time: a `turn/completed` that references another thread, arrives before the run submitted its turn, or references another turn fails the run with the mismatch named in the detail, while a non-terminal frame that cannot belong to the run is reported through the wire's `onUnassociatedFrame` diagnostic sink without failing, because only a mismatched terminal can strand the run.

## Alternatives considered

**Reusing `dsh-timeout`'s `idleWatchdog`.** That primitive bounds outstanding iterator demand on LLM request streams: the timer arms on each pending `next()`, clears on resolution, and a timeout aborts a fused signal that the adapter classifies with its capability timeout reason. A subagent run needs a different timing model — a bound that spans submission to terminal, resets on every observed frame or message, names the last activity in its failure detail, and trips into a provider-owned failure path (the query close plus the `transport` category) instead of an abort the catch would classify as caller cancellation. The run-scoped watchdog owns that state at the run's lifecycle in each provider package; the shared library keeps its demand-scoped contract.

**Failing on any unassociated frame.** Only a mismatched terminal can strand a published run; a mismatched non-terminal cannot, and failing on every unassociated frame would turn protocol noise into run death for a run that could still settle on its own terminal. Reporting non-terminals through the diagnostic sink while failing only terminal mismatches keeps both behaviors: the run keeps its chance to settle, and the silence watchdog bounds whatever is left.

**A wall-clock kill on the whole run.** Healthy turns — long builds, long agentic work — legitimately run longer than any fixed cap, and an activity bound already closes the reported hole: silence is the only post-publication input that strands a run today. A total-time bound remains an explicit follow-up for deployments that want one; it is not a default.

## Consequences

- A silent published run now fails within `runActivityTimeoutMs` (default `300_000` ms) at the stage it is in, with category `transport` and a detail naming the last observed frame (Codex) or message (Claude Code) — closing the post-publication facet of [post-mortem 0005](../../../../docs/postmortem/0005-subagent-codex-handshake-hang.md) for both product providers.
- A single silent command longer than the default (for example a quiet build) trips the deadline; deployments that want the pre-change unbounded run set `runActivityTimeoutMs: 0`.
- The Codex run catch merges the wire's collected failure detail into the facts it selects, so a watchdog trip or a dropped terminal that outlives the child exit that first rejected the race keeps its detail in the model-visible diagnostic.
- The Claude Code trip closes the query before the catch classifies: the `for await` consumer ends, the child teardown stays on its normal path, and the trip's mapping takes precedence over the invalid-result failure the stream's early end would produce.
- Both `Config` objects gain the validated field (non-negative finite, no greater than `MAX_TIMER_DELAY_MS`, schema default `300_000`); a direct `apply` call passes the field explicitly, as it does for `handshakeTimeoutMs` and `disposeGraceMs`.
- No session event, session format, or wire-format change: the watchdog is a provider-internal failure path on top of the existing failure diagnostic.
- The parallel watchdogs in the sibling provider packages are intentional duplication, marked in the duplication gate's ignore region.

## Testing

The Codex wire spec pins the trip (silence after the turn is submitted and silence in-flight), the reset on every streamed frame and on a server request, the disabled deadline, and the unassociated-frame behavior — non-terminals reported without failing, terminals failing with the mismatch named. The Codex run spec pins a silent published run failing at the activity deadline with the wire detail merged into the diagnostic. The Claude Code spec pins the trip that closes the query, the detail when no message ever arrives (`last: none`), the per-message reset that outlives the deadline, and the disabled stream. Both configuration specs pin the validation rejections (negative, non-finite, above the cap), the `300_000` default, and the direct-`apply` path. The real-product lanes pass unchanged.

## Related

- [Codex pre-publication handshake deadline](2026-09-15-codex-handshake-deadline.md) — the pre-publication sibling bound; the two deadlines together close post-mortem 0005.
- [Per-request deadline on the JSON-RPC line transport](2026-09-15-jsonrpc-request-deadline.md) — the transport mechanism the handshake deadline arms.
- [LLM stream content idle timeout](2026-09-15-llm-stream-content-idle-timeout.md) — the two-tier activity/content watchdog on the LLM adapters; the same "activity is not progress" distinction applied to subagent streams.
- [Timeout deadline library](../architecture/2026-07-06-timeout-deadline-library.md) — home of the shared primitives this note deliberately does not reuse.
- [Claude Code and Codex subagent backends](2026-08-04-claude-code-and-codex-subagent-backends.md) — the provider lifecycles these bounds cover.
- [Post-mortem 0005: Codex subagent handshake hang](../../../../docs/postmortem/0005-subagent-codex-handshake-hang.md) — the incident whose post-publication facet this note closes.
