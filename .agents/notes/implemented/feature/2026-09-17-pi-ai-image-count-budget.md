# Agent Note: pi-ai routes bound retained images per request

Status: implemented

English | [中文](2026-09-17-pi-ai-image-count-budget.zh.md)

## Problem

The pi-ai adapter carried only byte and pixel image budgets (`maxRequestImageBytes`, `requestImagePixelBudget`, `requestImageMaxBytes`); nothing bounded how many image occurrences one request retained. A deployment behind a provider that caps images per prompt — here a vLLM route started with `--limit-mm-per-prompt {"image":{"count":4}}` — failed every request once a session's history accumulated a fifth image (a dropped attachment plus a few generated results), surfacing the provider's own `400 At most 4 image(s)` as `INVALID_REQUEST`. The DeepSeek adapter already solved this shape with `maxImagesPerRequest` plus `dsh-compaction-image-offload`.

## Decision

`PiAiProviderProfile` gains `maxImagesPerRequest` (default 600, mirroring the DeepSeek adapter's effectively-unbounded default; a positive safe integer, validated in `resolveProfiles`). `toPiContextWithImages` passes it as the count bound of the shared `requiredImageOffload` budget beside the existing byte bound and throws `IMAGE_OFFLOAD_REQUIRED` with the count to offload when either bound is exceeded — the same recovery path DeepSeek uses: the `dsh-compaction-image-offload` plugin records the selected oldest occurrences in an `image/offload` event and retries the step, so the provider never sees more images than its cap. The check now also runs when only the count bound is set; both bounds absent still leaves the request unbounded.

The deployment sets `maxImagesPerRequest: 4` on both eGPU routes in `~/.dsh/settings.yaml`, matching the vLLM cap.

## Testing

`context.spec.ts` gains a count-bound case: one occurrence at the bound passes, two occurrences against a bound of one reject with `IMAGE_OFFLOAD_REQUIRED` and `offloadImages: 1`. The real settings document resolves through the strict schema to `maxImagesPerRequest: 4` on both routes (probed with `resolveProfiles` against `~/.dsh/settings.yaml`).

## Alternatives considered

**Raise the provider's image cap.** Only postpones the failure: history keeps every generated image, so the count eventually exceeds any fixed cap, and a higher cap multiplies vision-encoder work on every request.

**Tighten only the pixel or byte budgets.** Neither maps to a count; small images would still exceed a provider's per-prompt count while staying well under the byte budget.

## Consequences

A session that exceeds the count durably offloads its oldest images to placeholder text and keeps the newest ones visible to the model. The default preserves upstream behavior for providers without a per-prompt image cap.
