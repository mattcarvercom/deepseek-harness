# Agent Note: The slot scan's tolerance for files deleted mid-scan

Status: implemented

English | [中文](2026-09-15-slot-scan-vanished-file-tolerance.zh.md)

## Problem

The client slot catalog's scanner globs every package source directory and then reads each listed file: two loops in [slot-walk.ts](../../../../scripts/slot-walk.ts) — the slot-contract scan and the exported-type index — feed the catalog that `cordis inspect what:"client"` teaches from.

The oxlint contract spec writes short-lived `oxlint-contract-<uuid>.ts` probes into package src directories to verify per-file-class tsconfig discovery, and removes them in its `finally`. It runs in a separate forked worker from the catalog spec within the same full-suite job. The catalog's glob can list a probe the oxlint worker has already deleted, and the subsequent read throws ENOENT, failing the whole scan. The window is small and probabilistic: the failure did not reproduce on demand, and one full `test:coverage` run failed on it while the identical specs passed in every focused run.

## Decision

Both loops read each listed file through a shared `readListed`, which reports a missing file as `undefined` (the loop skips it) and rethrows every other read error.

- ENOENT is the only tolerated code. A probe carries no slot-contract head, so even a fully read probe contributes nothing; and a file deleted between the listing and the read cannot silently change the catalog, because the scan reads every source file as its own exhaustiveness backstop — a slot whose declaration vanishes mid-scan surfaces as a rejected registration (an undeclared-slot blind spot) and the gate fails loudly, never as a silently wrong catalog.
- The catalog's source globs stay un-narrowed: no probe pattern is excluded from the corpus, and the vitest config's existing `oxlint-contract-*.ts` exclusion keeps covering test-file discovery only.

## Alternatives considered

**Serializing the catalog spec against the oxlint contract spec.** The house rule is not to serialize an entire suite because one fixture lacks isolation, and a sequential block cannot protect a host filesystem from another process or job in the first place. Serialization taxes every full run for a window that exists between exactly two specs; the probe writer already owns a unique, self-deleting resource, so consumer-side tolerance is the narrower fix.

**Retrying the read on ENOENT.** The file is genuinely gone in the usual case, so a retry delays the same failure and turns a deterministic skip into a timing bet; a retry loop here is a flake mask, not a fix.

**Excluding `oxlint-contract-*.ts` from the catalog's source globs.** That narrows the corpus the scan uses as its exhaustiveness backstop: a future probe-like file that did carry a slot head would silently drop out of the catalog, while the scan reads the whole workspace on purpose.

**Raising the catalog spec's timeout.** No awaited state exists to wait for; a larger budget only delays the same ENOENT.

## Consequences

The catalog spec no longer fails on a race it does not own: a full `test:coverage` run passes both specs with the oxlint worker creating and deleting probes in parallel with the catalog's scan. The only other way a corpus file can vanish mid-scan is a concurrent deletion on the same checkout, and that case resolves as a loudly failing contract validation or a transiently stale catalog in one run — never as a silently wrong one. Every other read error still fails the scan, and the oxlint contract spec is unchanged.

## Testing

The new [slot-walk.spec.ts](../../../../scripts/slot-walk.spec.ts) pins the behavior on a fixture package in a per-test temporary root, with a mocked `readFileSync` answering from a table: ENOENT for one listed file skips it while the rest of the scan survives with the owning package resolved; any other error fails the scan with the exact thrown error; an ordinary scan keeps every file that exists. In a full `pnpm run test:coverage` run, both specs pass with the oxlint contract spec's probe lifecycle running in parallel with the catalog's scan.
