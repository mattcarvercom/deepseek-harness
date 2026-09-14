# Agent Note: Verify context-overflow compaction actually fits before retrying

Status: implemented

English | [中文](2026-09-14-overflow-recovery-retry-verification.zh.md)

## Problem

A real dsh session got stuck for roughly 41 minutes, cycling through 7+ identical `CONTEXT_WINDOW_EXCEEDED` failures before the turn ended in that same error. Diagnosed from the session's own event log (`assistant/attempt` stream chunks carrying `finish.reason.kind: "error"`, spaced minutes apart across distinct steps).

`BasicCompactionEngine`'s `agent/request-error` listener already reacted to a provider-confirmed `CONTEXT_WINDOW_EXCEEDED`: it forced one context-overflow compaction pass and authorized a retry whenever `agent.session.surface.replaceGeneration` advanced past the pre-compaction value. That criterion answers "did compaction durably change the surface," not "did compaction bring the next request back under the model's own context window."

`selectCompactableRange` (called with `retainTokens: 0` for this trigger) deliberately never shrinks the newest balanced surface unit — the region transaction cannot split an indivisible tool-call/result pair or the most recent message. When that protected newest unit is itself the cause of the overflow (in the live incident, the agent repeatedly re-reading the same large file each step), one compaction pass reliably shrinks *older* history — real, logged progress — while leaving the actual oversized content untouched. The generation-advanced check treated this as full success and authorized a retry that was mathematically certain to 400 identically.

The per-agent `overflowRetries` budget (`maxOverflowRetries`, default 1) only bounds retries *within one overflow episode*; it resets on `agent/status` idle or any subsequent successful `assistant/message`. A turn doing real, successful work between overflow events (further tool calls, more file reads) kept re-arming that budget, so the insufficient-compaction-then-retry cycle could repeat many times across a long turn instead of failing fast once.

Separately confirmed and ruled out as the live incident's cause, but worth recording: `dsh-llm-retry`'s `mode: 'always'` policy has no failure-code filtering at all (by design, per its own doc comment — "every model-request failure") and no retry-count ceiling, so a provider profile configured that way sitting downstream of a compaction-basic listener that gives up would retry an unwinnable `CONTEXT_WINDOW_EXCEEDED` forever. This deployment's affected provider used the unconfigured default (`mode: 'normal'`, and `CONTEXT_WINDOW_EXCEEDED` is not in `DEFAULT_RETRYABLE_CODES`), so `llm-retry` correctly declined and deferred to compaction-basic every time; it did not contribute to this incident. Left unchanged here — a real gap, but a separate, deliberately out-of-scope policy question about what `'always'` mode should exclude.

## Decision

The `agent/request-error` listener in `packages/compaction/compaction-basic/src/index.ts` now authorizes a retry only when both hold: the surface replacement generation advanced, *and* the session's current measured size is back under the routed target's own pressure threshold (`resolveCompactSpec(policy, context.contextWindow).thresholdTokens` — the same `thresholdRatio`-scaled figure the `'pressure'` trigger already trusts as a safe operating margin, reused rather than inventing a new bar). This applies on both branches: the ordinary success path, and the existing "prune landed but summarization threw" catch-branch that previously treated any generation advance as sufficient retry proof.

The check lives in a new private `isUnderOverflowThreshold(agent, policy, target, signal)` helper: it resolves the target's context capacity via `ctx.llm.resolveModelInfo`, resolves the compact spec, and compares `ctx.tokenMeter.measure(agent.session).totalTokens` against `spec.thresholdTokens`. Capacity lookup failure, an undefined `context`, or `resolveCompactSpec` throwing all return `true` (permit the prior generation-only behavior) — a config gap unrelated to the overflow itself must not newly block recovery for providers that were working before this change.

When the check reports still-over-threshold, the listener logs a distinct warning and calls `next()` — preserving the original provider error — instead of authorizing a retry that would repeat it. `compactIfNeeded`'s own `'context-overflow'` branch is unchanged: it still performs exactly one best-effort pass; the new verification is entirely in the caller that decides whether that pass earned a retry.

## Alternatives considered

**Loop `compactIfNeeded`'s `'context-overflow'` branch like `'pressure'` does, throwing when still over threshold.** Rejected: the existing catch block already treats "generation advanced before a throw" as sufficient retry proof (for the legitimate "prune landed, summarization then failed" case), so a throw from an insufficient-but-technically-progressed pass would hit that same branch and get authorized anyway — the fix has to live in the retry-authorization decision itself, not in making `compactIfNeeded` throw differently.

**Compare against the raw `contextWindow` instead of the ratio-scaled `thresholdTokens`.** Considered, but the real 400 that triggered this Note came from combined input-plus-requested-output tokens exceeding the window (117,233 input + 32,768 requested output = 150,001 against a 150,000 window); token-meter's measurement is input-only. `thresholdTokens` (80% of window by default) already exists as this system's answer to exactly that kind of margin, is already configured per deployment, and is already exercised by the pressure path — reusing it needs no new tunable and no thread-through of the pending request's reserved output budget.

**Widen `dsh-llm-retry`'s `'always'` mode to exclude `CONTEXT_WINDOW_EXCEEDED`.** Not done here. `AlwaysRetryPolicyConfig` explicitly documents unbounded retry of "every model-request failure" as its contract; narrowing that silently would change public, documented policy semantics for every consumer of `'always'` mode, not just this one code. It did not cause the diagnosed incident (the affected provider used the default `'normal'` policy, which already excludes this code). Left as a known, separately-scoped gap.

## Consequences

A context-overflow whose cause is a single oversized, newest, protected surface unit now fails fast on the first attempt with the original provider error, instead of potentially cycling for as long as the turn keeps producing intervening successful steps. This is a stricter contract than before: a compaction pass that only reduces size without confirming the result fits no longer counts as recovery. Deployments relying on the old best-effort semantics see no behavior change when a pass genuinely gets back under threshold (the common case, per the existing test suite) or when target capacity/policy can't be resolved (falls back to the old behavior).

`llm-retry`'s `'always'`-mode gap remains real and independent: a provider profile explicitly configured that way can still retry a `CONTEXT_WINDOW_EXCEEDED` (or any other structurally unrecoverable code) unboundedly if compaction-basic gives up. Not this change's scope; flagged here for whoever next touches that policy's code-filtering.

## Testing

`packages/compaction/compaction-basic/tests/compaction-loop-repro.spec.ts` gains `PersistentOverflowAdapter` (every conversation request overflows; the offending content is the newest surface node, which `selectCompactableRange` never touches) and a new case, "does not retry a request a compaction pass could not bring under threshold": asserts exactly one conversation request is attempted, that a real compaction (`compaction/start` → `compaction/summary` → `compaction/end`) still ran and touched the older seeded history, and that the turn ends with `reason: { kind: 'error' }` instead of retrying.

`packages/compaction/compaction-basic/tests/compaction-basic.spec.ts`'s "preserves the newest whole tool-call/result pair during forced overflow compaction" fixture used a 1,000-token test context window under which the protected newest tool-call/result pair alone (~2,000+ heuristic tokens) could never pass the new threshold check — an accidental instance of exactly the scenario the fix targets, unrelated to what that test is actually pinning (that the preserved pair stays whole and balanced). Widened to `createContext(10_000)`, matching its sibling fixtures elsewhere in the same file that already use that window for the same `toolConversation()` fixture.

Full `packages/compaction/compaction-basic`, `packages/core/agent-loop`, `packages/llm/llm-retry`, and `packages/core/agent` suites pass (201 tests); repo-wide `typecheck` and `lint` pass clean.
