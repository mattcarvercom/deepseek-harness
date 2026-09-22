# Post-mortem 0006: vLLM stream that never terminates

English | [中文](0006-vllm-stream-never-terminates.zh.md)

Status: resolved

## Executive summary

Both LLM adapters bounded their streams with a single watchdog — a per-read idle timer that resets on any wire activity. A model endpoint whose stream keeps sending data but never produces model content, as reported for a vLLM endpoint serving Qwen3.8-27B in [discussion #5007](https://github.com/deepseek-ai/deepseek-harness/discussions/5007), keeps that watchdog resetting forever: the request neither fails nor completes, and because no failure ever occurs, nothing is retried and nothing is reported. This commit adds a second, independent bound to both adapters — a content-idle deadline (`streamContentIdleTimeoutMs`, default ten minutes, `0` disables) that arms when the stream starts and resets only on real model output — so this class of stream now fails with a retryable `TIMEOUT` inside a finite window.

## Summary

Both streaming paths carry a per-read idle watchdog (`streamIdleTimeoutMs`, default five minutes, `0` disables) that bounds how long one read from the wire may stay silent. Both adapters reset it on any stream activity, not just on content: the DeepSeek adapter pulses it on every SSE comment — a keep-alive line on the wire — and the pi-ai adapter resets it on every value its SDK emits. The watchdog detects a connection that has gone fully silent, and it does so reliably. Its complement — a stream that stays active, never produces content, and never terminates — is the one input it cannot turn into a failure: every keep-alive arrives comfortably inside the per-read budget, the stream never closes, and no failure occurs. A request hung that way never enters the retry policy, which retries failures rather than silences, and it produces no diagnostic, because there is nothing to report.

## Impact

[Discussion #5007](https://github.com/deepseek-ai/deepseek-harness/discussions/5007), "[Bug] Cannot stream from vLLM end point", reports this symptom class: the reporter has "an endpoint set up with Qwen3.8 27B via vLLM", and "when I first started dsh and configured the endpoint through the UI, everything worked as expected. However, when I started dsh again, it no…". The discussion remains unanswered, and the report itself is the record of a request that could not complete. The report does not say which adapter the endpoint was configured through; both LLM adapters in this tree had the hole, and either path hangs the same way — a tool call, a turn, or a background job waits indefinitely until an external actor cancels, kills, or restarts the process, the same failure signature [post-mortem 0005](0005-subagent-codex-handshake-hang.md) established as unacceptable for a run against an external process. Nothing is corrupted, but a frozen user cannot tell a slow model from a broken endpoint, and no diagnostic exists to point at.

## Root cause

The per-read idle watchdog's reset rule treats any activity as a live stream, and an endpoint whose broken state is a keep-alive-only stream is invisible to that rule by construction. Two gaps compounded. First, no second, content-based bound existed: nothing measured silence about real output, only about the wire, so a stream that kept delivering data without content was healthy as far as every existing bound was concerned. Second, no failure, therefore no retry: the default retry policy (five retries) fires only on failures, so a stream that hung forever never entered any recovery path the harness otherwise had. The adapters' test matrices exercised the watchdog's input — fully silent streams — but not its complement, a stream active forever and contentless forever.

## Timeline

- The per-read idle watchdog (`streamIdleTimeoutMs`, default five minutes, `0` disables) exists in both LLM adapters, reset by any wire activity, including keep-alives.
- [Discussion #5007](https://github.com/deepseek-ai/deepseek-harness/discussions/5007) reports a vLLM endpoint serving Qwen3.8-27B whose first use through dsh worked and whose later dsh starts cannot stream; the discussion remains unanswered.
- The deep dive of the report against the current code found the hole in both adapters: the only streaming bound resets on keep-alive activity, so an endpoint that keeps a stream open without producing model content hangs the request forever, with no failure, no retry, and no report.
- This commit arms the second bound on both adapters: the content-idle deadline `streamContentIdleTimeoutMs` (default ten minutes, `0` disables, capped by the shared `MAX_TIMER_DELAY_MS`), reset only by model content — a non-empty text or reasoning delta, or a tool-call payload.

## Guardrails added

- `streamContentIdleTimeoutMs` is a validated config field on both adapters — non-negative finite, no greater than the shared `MAX_TIMER_DELAY_MS`, default ten minutes, `0` disables — recorded in the [configuration catalog](../config-catalog.md) and both packages' READMEs.
- A new `progressDeadline` primitive in [`dsh-timeout`](../../packages/util/timeout/README.md): armed at stream construction, reset only by explicit `progress()` calls, running across gaps between reads; `<= 0` is a timerless passthrough. The per-read watchdog and the content deadline fuse into one abort signal per request.
- Both consumer loops advance the deadline only on token-level content (`isTokenDelta`): keep-alive comments and SDK metadata values never extend it.
- A tripped deadline throws `LlmError('… stream content idle timeout after <ms>ms', 'TIMEOUT')`; `TIMEOUT` is already in the default retry policy's retryable codes, so the existing five-retry policy now has this failure to retry.
- The adapter specs pin, on each adapter, a keep-alive-only stream failing at the deadline, a stream that keeps producing content surviving past it, and `0` as the opt-out; the pi-ai spec additionally pins the content deadline winning the race against the SDK's in-band conversion of an aborted stream.

## Lessons

- "The peer is alive" is not "the request is making progress": a bound that resets on any activity guards against silence, not against active non-progress, and an endpoint whose broken state is keep-alive chatter needs a progress-based bound.
- A failure that never occurs can never be retried: the retry policy consumes failures, and a stream that hangs forever stays outside every recovery path; the fix is to make the failure happen, not to add another recovery.
- A streaming boundary's test matrix must include the complement of its watchdog's input: a stream active forever and contentless forever.
