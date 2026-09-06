# Agent Note: Remove the GUI testing notice

Status: implemented

English | [中文](2026-09-05-remove-gui-testing-notice.zh.md)

## Problem

The [shared-modal product onboarding](../feature/2026-08-13-shared-modal-product-onboarding.md) decision restored a concise testing-stage notice ahead of the DeepSeek credential dialog. On this fork the notice only ever has one reader — the maintainer running their own local deployment — and every first-run or reset `settings.yaml` without an acknowledged `welcomeNoticeVersion` shows the interstitial again for no remaining benefit.

## Decision

This decision removes the notice from the assembled product entirely, mirroring the [first beta-notice removal](../../archived/simplification/2026-08-13-remove-first-run-beta-notice.md). `ui-settings-models` no longer seats a `welcome-notice` step: the notice's component (`WelcomeNotice.tsx`/`.module.css`), store (`welcome-store.ts`), copy owner (`onboarding-copy.ts`), and locale keys are deleted, leaving `deepseek-official` as the plugin's only `settings.onboarding` registrant. The Host keeps the `ui-onboarding` namespace registered so a settings document that still carries an old `welcomeNoticeVersion` stays valid, unchanged from the first removal's reasoning. Coverage that only exercised the deleted step — `welcome-notice.client.spec.tsx`, `welcome-store.client.spec.ts`, `remote-welcome.e2e.ts`, the two welcome-specific `apply.client.spec.ts` cases, and the e2e `welcome.expected.md` golden — is deleted rather than retargeted, since nothing remains for it to pin.

## Alternatives considered

**Make the notice dismissible without a version bump (a local "don't show again" toggle).** Rejected: a second unversioned suppression mechanism duplicates the existing `welcomeNoticeVersion` field for no shipped benefit once the whole step is gone.

**Keep the notice but shorten or soften its copy.** Rejected: any first-run interstitial ahead of the credential dialog is friction for a single local maintainer, independent of its wording.

**Skip the notice only for the maintainer's own workspace behind a config flag.** Rejected: a per-deployment flag holds two code paths for one branch this fork always takes; nothing else in the codebase would read it.

## Consequences

A fresh loopback profile now goes straight to the inline DeepSeek key dialog when no provider is usable, with no preceding step. `deepseek-official` keeps its existing order-`0` registration and its [shared-modal](../feature/2026-08-13-shared-modal-product-onboarding.md) presentation and [step-owned takeover chrome](../bug-fix/2026-08-06-onboarding-step-owned-takeover-chrome.md) mechanism, both of which stay current since they describe the coordinator and slot contract generically rather than pinning to a fixed step count. `ui-onboarding.welcomeNoticeVersion` remains a valid, inert settings key. Reintroducing any first-run notice on this fork would need a new versioned field and a new Agent Note; the removed notice's copy and version live only in git history.
