# Post-mortem 0005: Codex subagent handshake hang

English | [中文](0005-subagent-codex-handshake-hang.zh.md)

Status: resolved (the pre-publication fix landed earlier in the same series; this commit closes the post-publication facets with the protocol-frame activity watchdog and terminal-frame diagnostics)

## Executive summary

A `subagent_codex` call can hang indefinitely when the delegated Codex app-server stays alive but stops responding ([discussion #6226](https://github.com/deepseek-ai/deepseek-harness/discussions/6226)): the child neither exits nor closes its stream, and the pre-publication handshake had no settlement path for that input, so the run, its tool call, and the session's deep-diving state wait until an external actor — a cancel, a kill, or a server restart — releases them, with no failure, no diagnostic, and no retry. The two pre-publication handshake requests now carry a per-request deadline (`handshakeTimeoutMs`, default `60_000` ms, `0` = off); a silent app-server fails the run at the deadline with category `transport` and a liveness detail recorded before teardown. The post-publication facet of the same report — the child completes its turn and exits while the run still waits — closed with the protocol-frame activity watchdog and terminal-frame diagnostics in this commit, and this post-mortem is resolved.

## Summary

The Codex provider publishes a run only after two handshake requests against the freshly spawned `codex app-server --stdio` child: `initialize` → `initialized`, then `thread/start`. Each request settles on exactly four observed facts: a response, an abort of the request signal, a settlement of the protocol stream, or a direct child failure. The shared JSON-RPC transport owns the pending-entry map and settles an entry only on response, abort, or stream settlement; it has no time of its own.

The incident's input is the complement of that partition: a child that stays alive, keeps the stdio stream open, and answers nothing. No response arrives, an abort fires only when a user acts, the stream never settles, and the child never fails, so the pending request — and the run built on it — waits indefinitely. A background Job has no one to abort, and nothing inside the run converts silence into a failure.

The same report describes a post-publication facet: the child completes its turn and exits while the dsh-side run still hangs. The wire dropped the `turn/completed` notification silently when its turn id did not match the active turn, and the post-publication race had no activity bound of its own; both facts closed with the activity watchdog and terminal-frame diagnostics in this commit.

## Impact

Intermittent `subagent_codex` calls never returned. In the foreground the tool call and the session's deep-diving state waited indefinitely, and the reporter observed that clicking cancel had no effect; in the background the one-shot Job stayed in flight with no completion notice, no failure diagnostic, and no retry. Only killing or restarting the dsh server released the hang. There was no data corruption and no security impact: the wedged run held its own workspace only, and the file side effects written before the hang were real work done by the child.

## Root cause

The pre-publication settlement paths partitioned the failure space incompletely: response, abort, stream settlement, and child failure, with no path for a child that is alive, open, and silent. The transport's pending-entry design is correct for a protocol peer — it settles only on observation — but the app-server is a child process, and a request against an external child needs a time bound owned by the caller's policy. Cancellation is a user decision and child death a product fact, and neither is a deadline: an unattended background run has neither.

The test matrix mirrored the same incompleteness. The fakes exercised cancellation, child exit, invalid frames, and stream close, but never a child that stays alive and silent past the expected response — the one input that distinguishes a wedged handshake from a healthy one.

And the failure builder had no liveness observation: when a pre-publication failure did surface, its diagnostic could not say whether the app-server process was still running or the child had already exited with its managed range still open — exactly the fact that decides whether a retry is worth attempting.

The reported cancel ineffectiveness is consistent with the same partition: in the current tree an abort of the request signal is the only pre-publication release path, and every release path needs an actor — a cancel, a kill, a restart. The fix removes the need for any actor: the deadline is a fact the run itself can observe.

The report's post-publication facet — the child completes its turn and exits while the run still waits — had two gaps of its own in the reported tree: a `turn/completed` notification whose turn id did not match the active turn was dropped silently by the wire, and the post-publication race had no activity bound of its own. Both closed with the protocol-frame activity watchdog and terminal-frame mismatch diagnostics in this commit.

## Timeline

- 2026-08-04 — The Codex product provider ships with the handshake requests carrying the request's abort signal: a user cancel interrupts a pending handshake, and a child exit fails the run.
- 2026-08-18 — the pre-publication phase is raced against direct child failure, so a child that dies mid-handshake settles the run with its exit outcome instead of waiting for a protocol close.
- [Discussion #6226](https://github.com/deepseek-ai/deepseek-harness/discussions/6226) reports intermittent `subagent_codex` calls that never return: the delegated child completes its turn — streamed output, file side effects — and exits while the dsh-side run hangs, the reporter observes that cancel has no effect, and the discussion remains Unanswered.
- The deep dive of the report against the current code establishes the remaining holes: the pre-publication handshake has no time bound (a live-but-silent child settles nothing), and the post-publication race has no activity bound and drops a mismatched `turn/completed` silently.
- The per-request response deadline lands in the shared JSON-RPC transport as the first commit of this series.
- This commit arms the deadline on the two pre-publication handshake requests from the new `Config.handshakeTimeoutMs` (default `60_000`, `0` = off), classifies a deadline failure as `transport`, and records a pre-teardown liveness detail in the safe failure diagnostic.
- This commit closes the post-publication facets with the protocol-frame activity watchdog and terminal-frame mismatch diagnostics; kill-child run control follows in the same series.

## Guardrails added

- [`Config.handshakeTimeoutMs`](../../packages/subagent/subagent-codex/README.md) bounds the two pre-publication handshake requests through the transport's per-request deadline: default `60_000` ms, `0` disables, validated non-negative finite and no greater than the shared `MAX_TIMER_DELAY_MS`.
- A handshake that hits its deadline fails the run at the stage it was in with category `transport` — transport silence, distinct from `unknown` — so the diagnostic names the mechanism.
- [`startupLivenessDetail`](../../packages/subagent/subagent-codex/src/run.ts) probes the acquired child with a zero-delay `waitForExit` before disposal and appends a fixed liveness detail to the safe failure diagnostic for the two surprising cases: a deadline that elapsed with the app-server process still running, and a child that exited while its managed range had not quiesced.
- The wire spec pins per-request deadline rejection on both handshake methods and proves a zero deadline arms nothing; the run spec pins both liveness details with exact messages alongside the unchanged legacy diagnostics for cancellation, spawn failure, invalid frames, EOF before close, and cleanup races; the real-product lane proves the healthy path is unaffected at the default deadline.
- [`Config.runActivityTimeoutMs`](../../packages/subagent/subagent-codex/README.md) bounds post-publication protocol silence on both product providers — Codex app-server frames and Claude Code SDK stream messages: default `300_000` ms, `0` disables, validated non-negative finite and no greater than the shared `MAX_TIMER_DELAY_MS`.
- A published run that stays silent past the deadline fails with category `transport` and a detail that names the last observed frame or message; the failure stage pins whether the silence preceded or followed turn submission.
- The Codex wire fails the run when a `turn/completed` references another thread or turn or arrives before the run submitted its turn, and reports — without failing — non-terminal frames that cannot belong to the run, through a provider diagnostic sink.
- The run specs pin the trip, reset, disabled, and terminal-mismatch paths with exact diagnostic messages, and the real-product lanes pass unchanged.
- The [run activity watchdog Agent Note](../../.agents/notes/implemented/feature/2026-09-15-subagent-run-activity-watchdog.md) records the design decision, and the [handshake deadline Agent Note](../../.agents/notes/implemented/feature/2026-09-15-codex-handshake-deadline.md) records its pre-publication sibling, including why the liveness observation uses the existing `waitForExit(signal?)` instead of a new subprocess seam method.

## Lessons

- A request against an external child process settles on exactly four observed facts — response, abort, stream settlement, child failure — and the caller's policy must cover time itself; cancellation and death are not deadlines.
- The liveness fact a failure diagnostic needs must be observed before teardown destroys it; the probe is cheap only while the process is still addressable.
- A protocol handshake's test matrix must include the alive-but-silent child — the one input no other settlement path produces.
- A reported hang names a symptom class, not a single mechanism; the fix series closed the Codex run's settlement partition facet by facet — the per-request deadline, the handshake deadline, and this commit's post-publication watchdog and terminal-frame diagnostics — and every facet now has a bound.
