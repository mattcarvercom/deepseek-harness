# Agent Note: Per-request deadline on the JSON-RPC line transport

Status: implemented

English | [中文](2026-09-15-jsonrpc-request-deadline.zh.md)

## Problem

`JsonRpcLineTransport.request` had one mechanism to bound a request: the caller's abort signal. Without a signal, a request against a silent or dead peer — one that accepts the request but never answers, a handshake that never completes — waits forever, because the transport settles a pending request only when the stream errors, closes, or is closed, and a wedged-but-alive stream satisfies none of those. Consumers had to build their own timer around each request and map the failure into their own error vocabulary (the `dsh-sdk` client wraps its transport with a client-level `RequestTimeoutError`); every other JSON-RPC consumer — the subagent runners first — had no deadline at all, which is how a silent codex process can hold a run hostage indefinitely.

## Decision

`request` takes an options object: `request(method, params, options?)` with `JsonRpcRequestOptions { signal?: AbortSignal; timeoutMs?: number }`, replacing the positional signal on this pre-stable API — the in-repo callers passing one, the `dsh-sdk` client and the three codex app-server wire calls, now pass `{ signal }` — while the `JsonRpcTransportPeer` interface is unchanged, because the serving side of that contract only calls `notify`.

A positive `timeoutMs` arms a deadline that, when it fires, removes the pending entry with the same cleanup as abandonment (one `release` closure cancels the deadline timer and detaches the abort listener) and rejects with the typed `JsonRpcTimeoutError` exposing `method` and `timeoutMs`, so callers can distinguish a deadline from a protocol error without parsing a message. A response arriving after the deadline is dropped — the pending map is already empty, so no state is retained for a response that may never come, and no state exists to clean up. `0` or an omitted `timeoutMs` leaves the request unbounded, so a validated `Config` value using the harness's `0 = off` convention can be passed through directly.

## Alternatives considered

**Kept the positional signal and appended a second positional `timeoutMs`.** Two optional positionals read as an ordered pair, and the next per-request control would have to shift every argument position; the options object groups the per-request controls under one documented surface.

**Armed the deadline in each consumer, as the `dsh-sdk` client does today.** Every consumer would duplicate the timer-plus-abandonment-plus-cleanup bookkeeping and fail with consumer-local error types; the transport owns the pending-entry map, so the deadline and its cleanup belong there. The SDK client keeps its richer client-level timeout on top of this — consumer policy and transport mechanism compose rather than compete.

**Extended the `JsonRpcTransportPeer` interface with options.** No consumer calls `request` with options through the interface — the serving side of that contract only `notify`s — so extending it would be a public change without a consumer. The concrete class carries the extended signature and stays structurally assignable to the unchanged interface.

**Threw on non-positive `timeoutMs` values.** The harness's timeout settings use `0 = off` as their off-value convention; rejecting `0` would force every future consumer to translate between the setting's vocabulary and the transport's before passing a value through.

## Consequences

- A bounded request can now fail fast with a transport-level typed error; a wedged peer no longer holds pending work past its deadline.
- The positional-signal call shape is gone from the concrete class (pre-stable wire library; the in-repo caller was updated in this change, and an out-of-repo caller on the release-candidate line needs a one-line options-object change).
- The deadline timer keeps the event loop alive while a bounded request is pending, and every settlement path clears it, so a settled request leaves no handle behind; `0 = unbounded` requests arm nothing.
- The wire format is unchanged: this is a per-request control on the existing request/response flow, so session events, the session format version, and the Python SDK mirror are unaffected.

## Testing

The transport spec pins: a deadline elapsing rejects with `JsonRpcTimeoutError` (with the `method` and `timeoutMs` fields and the documented message) and empties the pending map; a response arriving after the deadline is dropped without restoring state; the deadline timer is cleared on response, on abandonment, and on transport close; `0` arms no deadline; and the existing abandonment tests pass through the new options-object shape. The `dsh-sdk` client and `dsh-server` lanes pass unchanged.

## Related

- [TypeScript SDK and SDK subagent backend](../../archived/feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.md) — origin of the transport usage this deadline serves (archived).
