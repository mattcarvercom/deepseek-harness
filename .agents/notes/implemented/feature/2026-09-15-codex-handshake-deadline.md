# Agent Note: Codex pre-publication handshake deadline

Status: implemented

English | [中文](2026-09-15-codex-handshake-deadline.zh.md)

## Problem

The Codex app-server wire settled a pre-publication handshake on two non-response facts: an abort of the request signal, and a direct failure of the spawned child. Neither covers the input the field incident reported — a live child that keeps the stdio stream open and answers nothing ([discussion #6226](https://github.com/deepseek-ai/deepseek-harness/discussions/6226)): the `initialize` and `thread/start` requests, and the run built on them, waited until a server restart, with no failure, no diagnostic, and no retry. The shared JSON-RPC transport settles a pending request only on response, abort, or stream settlement and has no time of its own, so the provider had nowhere to bound the handshake; and when a pre-publication failure did surface, the failure builder had no liveness observation to say whether the app-server process was still running, so the diagnostic could not tell a live-but-silent process from a dead one.

## Decision

The provider configuration accepts `handshakeTimeoutMs`: a non-negative finite number no greater than the shared `MAX_TIMER_DELAY_MS`, schema default `60_000`, with `0` restoring the unbounded handshake. The value flows through `CodexRunSpec` to the `CodexAppServerWire` constructor, which bounds the two pre-publication requests through the transport's `timeoutMs` option; `runTurn` stays unbounded, because a long turn is legitimate work rather than silence.

A deadline that fires fails the run at its stage with category `transport` — the transport-silence category, distinct from `unknown` — before any disposal. Before that disposal, `startupLivenessDetail` probes the acquired child with a `waitForExit` call raced against a zero-delay abort signal and, when the probe adds a fact, appends a fixed liveness detail to the safe failure diagnostic: a deadline that elapsed with the app-server process still running, or a child that exited while its managed range had not quiesced. A cancelled run, an already-explained child failure, and an unobservable range add no detail; the detail is always the last field of the diagnostic message.

## Alternatives considered

**A `SubprocessHandle.liveness()` seam method.** The existing `done` promise and `waitForExit(signal?)` already express the probe — the memoized exit range raced against a zero-delay abort — so a seam method would add a public API without a current owner and ask every subprocess provider to implement behavior one consumer needs.

**A host-only `ctx.logger.warn` for the silent handshake.** Retry decisions happen at the model's tool result, and the harness pairs model-visible facts with logged ones; a host-only line would be invisible to the decision. The fact lands in the safe diagnostic, which reaches the tool result, and the existing failure logging carries it to the Host.

**A wall-clock cap on the whole run.** Legitimate turns run longer than any fixed cap, and the post-publication liveness problem is a different design — an activity bound on protocol frames, not wall clock. A blanket cap would kill healthy work while leaving the actual gap, the unbounded pre-publication requests, in place.

## Consequences

- A silent app-server now fails the run at the `handshakeTimeoutMs` deadline, at the stage it was in, with category `transport` and an actionable liveness detail, so the caller retries or cancels on a bounded failure instead of waiting for a restart.
- `handshakeTimeoutMs: 0` restores the pre-change unbounded handshake; `60_000` is the schema default, so a direct `apply` call passes the field explicitly, exactly as it does for `disposeGraceMs`.
- The wire constructor gains a fifth argument defaulting to `0`; the provider's `start()` is the production caller and passes the configured value.
- The safe failure message gains an optional `detail` field, always last; every other field of the diagnostic is unchanged.
- No session event, session format, or wire-format change: the deadline is a provider-internal failure path, and the turn request stays unbounded.

## Testing

The wire spec pins the per-request deadline rejection on both handshake methods — `JsonRpcTimeoutError` carrying `method` and `timeoutMs` — and proves a zero deadline arms nothing. The run spec pins both liveness details with their exact messages and the unchanged legacy diagnostics for cancellation, spawn failure, invalid frames, EOF before close, and an unobservable range. The configuration spec pins the validation rejections (negative, non-finite, above the cap), the acceptance of `0`, the `60_000` default, and the direct-`apply` path. The real-product lane passes unchanged, proving the healthy handshake at the default deadline.

## Related

- [Per-request deadline on the JSON-RPC line transport](2026-09-15-jsonrpc-request-deadline.md) — the transport mechanism this note arms.
- [Claude Code and Codex subagent backends](2026-08-04-claude-code-and-codex-subagent-backends.md) — the provider lifecycle this deadline bounds.
- [Post-mortem 0005: Codex subagent handshake hang](../../../../docs/postmortem/0005-subagent-codex-handshake-hang.md) — the incident that exposed the hole.
