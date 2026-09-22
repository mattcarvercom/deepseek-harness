# Agent Note: LLM stream content-idle deadline

Status: implemented

English | [中文](2026-09-15-llm-stream-content-idle-timeout.zh.md)

## Problem

Both LLM adapters bounded their streams with one watchdog — the per-read idle timer (`streamIdleTimeoutMs`) that arms on each outstanding read and resets on any stream activity. Both adapters reset it on data that is not content: the DeepSeek adapter pulses on every SSE keep-alive comment, and the pi-ai adapter resets on every value its SDK emits. A stream that keeps delivering such activity but never produces model content — the symptom class reported on a vLLM endpoint in [discussion #5007](https://github.com/deepseek-ai/deepseek-harness/discussions/5007) — therefore never fails: the watchdog stays reset, the stream never terminates, and the request hangs indefinitely. Because no failure occurs, the retry policy, which retries failures rather than silences, has nothing to retry, and no diagnostic surfaces. The watchdog is correct for its own input — a fully silent connection — and the hole is the missing second tier: nothing measured progress, only activity.

## Decision

`dsh-timeout` gains a `progressDeadline(upstream, timeoutMs, code)` primitive with a different timing model from `idleWatchdog`: the timer arms at construction, keeps running across gaps between outstanding reads, and resets only through explicit `progress()` calls; `timeoutMs <= 0` is a timerless passthrough (the signal is the upstream itself or a fresh never-aborted controller, and `progress()` and `dispose()` are no-ops); a tripped signal can never be re-armed; `dispose()` is idempotent.

Both adapters add `streamContentIdleTimeoutMs` to their configuration: a non-negative finite number no greater than the shared `MAX_TIMER_DELAY_MS`, default `600_000` (ten minutes), `0` restoring the unbounded behavior for endpoints whose healthy state is a long silence before the first token. The stream is constructed with the two watchdogs' signals fused (`AbortSignal.any`), each stream call arms its own deadline, and the consumer loops advance it only on token-level content — `isTokenDelta`, a non-empty text or reasoning delta or a tool-call payload — so keep-alive comments, SDK metadata values, and usage frames never extend it. A tripped deadline fails the request with `LlmError('… stream content idle timeout after <ms>ms', 'TIMEOUT')`: the DeepSeek adapter classifies it in its catch, and the pi-ai adapter checks it inline after every value, because the pi-ai SDK converts a mid-stream throw into an in-band error event and only the inline check makes the content deadline win that race.

## Alternatives considered

**Generalize `idleWatchdog` with pulse-kind tags (content versus activity).** Rejected: the tiers have different timing models, and the demand-rearmed primitive cannot express them. `idleWatchdog` arms per outstanding demand and clears on the result; the content deadline must arm at construction and keep running while no read is outstanding, re-arming only on content. A tag parameter would still fire on the first demand's expiry in exactly the gap that matters — the time between the last value and the next read.

**Detect progress at the wire-frame level (any non-keep-alive frame, or any SDK event).** Rejected in favor of chunk level: both adapters share `dsh-llm`'s mapped chunk vocabulary, so the one shared predicate `isTokenDelta` gives both adapters the identical progress definition without either maintaining a per-wire-protocol vocabulary of what counts as metadata. The predicate is deliberately stricter than "any data": reasoning deltas and tool-call payloads count as progress, pure metadata does not.

**Make `TIMEOUT` retryable in the default retry policy.** No change was needed: `TIMEOUT` is already a member of `DEFAULT_RETRYABLE_CODES`. The defect was that the failure never happened, and the deadline supplies it; the policy shape is unchanged.

## Consequences

- A stream that keeps its wire busy without producing model content now fails with `TIMEOUT` at the content deadline, the default five-retry policy retries it, and a persistently broken endpoint surfaces as a bounded, diagnosed failure instead of an infinite hang.
- `streamContentIdleTimeoutMs: 0` restores the pre-change behavior (only the per-read idle watchdog applies); the ten-minute default tolerates long first-token latency, including extended reasoning.
- `dsh-timeout`'s public surface grows by one primitive; `idleWatchdog` semantics are unchanged, and the two compose into one fused signal per request.
- No session event, session-format, or wire-format change: the deadline is a provider-internal failure path whose outcome is the ordinary failed-request diagnostic.
- Configuration resolves the new field through the adapters' existing explicit resolve steps, with the `?? DEFAULT` inside the resolver matching the existing `streamIdleTimeoutMs` pattern.

## Testing

The `dsh-timeout` spec pins the primitive's full contract: arm-at-construction, reset only through `progress()`, running across demand gaps, the `<= 0` passthrough (including the fresh never-aborted controller), the post-trip guard, and idempotent disposal. The DeepSeek adapter spec pins a keep-alive-only stream failing at the deadline with the exact `TIMEOUT` message, a stream that keeps producing content surviving past it, `0` as the opt-out, and the resolver's validation (negative, non-finite, and above-cap rejections; `0` and the default accepted). The pi-ai spec pins the same three behaviors against the SDK's event stream and additionally pins the two races: the content deadline beating the SDK's in-band conversion of an aborted stream, and a zero bound preserving the in-band `aborted` finish on a caller abort.

## Related

- [Provider-routed LLM adapters](../architecture/2026-07-14-provider-routed-llm-adapters.md) — the adapter architecture whose per-read stream-idle timeout this note supplements; that note keeps its decisions.
- [Post-mortem 0006: vLLM stream that never terminates](../../../../docs/postmortem/0006-vllm-stream-never-terminates.md) — the incident this note's deadline closes.
- [`dsh-timeout`](../../../../packages/util/timeout/README.md) — home of `progressDeadline` and `idleWatchdog`.
