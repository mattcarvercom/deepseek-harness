# Agent Note: Web session deletion (durable, unrecoverable)

Status: implemented

English | [中文](2026-09-06-web-session-deletion.zh.md)

## Problem

The session hover menu carried Rename, Fork, and Archive. [Archive](2026-07-31-session-archive-global-set.md) hides a session from every display surface, but the log and its derived data stay on disk forever. Throwaway sessions — experiments, test runs, misdirected conversations — accumulate indefinitely: their JSONL session directory (every generation plus lock residue), their `session_projcache` row in `~/.dsh/storages/session_projcache`, and their ids inside workspace-registry records (`sessionIds`, the header index, the archive set). The product had no path to release that storage: archive is a hiding, not a cleanup. The menu's original "Delete session" row was a visual-only placeholder, replaced by Archive when the archive set shipped.

## Decision

**A fourth hover-menu row, "Delete session", with a confirmation modal that names the operation unrecoverable; on confirm the client calls a new `sessions.delete` Remote, and the Host runs one ordered lifecycle: refuse, release the Agent, destroy the log, drop derived data fail-soft, publish.**

- UI: `ui-workspace` rows add a `delete` menu row beside Rename/Fork/Archive (locale-owned copy, `menu.deleteSession` and a `deleteSession.*` dictionary in zh/en). Confirming opens a modal that states the log and all content are destroyed and cannot be undone; the confirm button is the only destructive affordance and shows a pending state while the Remote is in flight.
- Host: `SessionDeleteController.delete` (`packages/api/session-controller/src/delete.ts`, `@Remote('delete')`) resolves the header from the attached `ctx.sessions.get` else `sessionPersistence.stat` (definite miss → `session/not-found` with the id in details), refuses subagent-owned sessions with the shared `session/agent-busy` refusal, then `ApiSessionAgentController.disposeAgent` stops the live Agent — the retention map entry is removed before `handle.dispose()` runs, and the `agent/disposed` listener drops any entry a concurrent create/resume re-adopts mid-disposal.
- Storage: a new `SessionPersistence.delete(id)` abstract method. The JSONL backend refuses while any in-process handle is open (`SessionAlreadyOwnedError` — a pending, never-materialized session is always behind its open creator handle, so the open-handle probe covers it), then destroys the session directory for the id (every generation plus lock residue, resolved by session name so encoding and layout are irrelevant) or the obsolete flat artifact, and drops the id's cold-log memo. `true`/`false` reports whether data existed; a persistence failure aborts the operation before any cleanup step, so a failed deletion never publishes a removal.
- Fail-soft derived drops, in order: `sessionProjectionCache.remove(id)` (the row plus its pending write-behind state; a failed drop is a warn — a row without its log is inert, no cold read can serve it) and `workspaceRegistry.removeSession(id)` (the id stripped from every record's `sessionIds`, the header index, and the archive set; a stale record id is inert for listing because the list is persistence-driven and the registry prunes it on its next record mutation). `api-session/removed` is emitted only after the durable log deletion committed.
- Client: `ISessions.delete` / manager `deleteSession` forward the Remote; the service `delete` throws on any Host failure and, on success, clears the local row immediately via the shared session-removal path (the forwarded `api-session/removed` frame repeats it idempotently). Selecting a deleted open session falls back to the New Session view like any other removal.

## Alternatives considered

**Tombstone or soft delete with a restore window.** Keeps the storage the operation exists to release, and the session domain has no recovery surface to serve a tombstone from; the product decision is that a confirmed deletion is unrecoverable, which is what the modal states.

**Refuse deletion while an Agent is live instead of disposing inside the operation.** Simpler lifecycle, but it pushes a "stop the session first" chore onto the user and makes the command partial; disposing inside makes the command total, and the running turn is cancelled by the dispose.

**Hard-fail the deletion when a cache or registry drop throws.** The log destruction is already committed at that point; reporting failure for a delete that actually happened — or rolling the log back to match — is worse than an inert residue (a row without a log, an id without persistence) that nothing can list or serve.

**Ordering the persistence delete after the derived drops.** A derived-table fault would then mask a log that is still intact, and a later retry could double-report; the durable log is the source of truth, so it fails first and hard.

## Consequences

- Deletion is unrecoverable by design; the confirmation modal is the only guard, and it says so.
- A live Agent that is absent from the retention map would leave an open persistence handle, so `delete` refuses loudly with `SessionAlreadyOwnedError` instead of destroying a session in flight — the loud refusal is the desired failure mode for a destructive operation (no current path leaves a live Agent unretained).
- A failed fail-soft drop leaves inert residue — a projection-cache row without a log or a registry id without persistence — that no display surface lists and no cold read serves; both are pruned or ignored by later writes.
- `~/.dsh/storages/session_projcache` and workspace-registry records no longer accumulate ids of throwaway sessions.
- Archive remains the non-destructive sibling operation; deleting an archived session is allowed (the registry drop clears its archive-set entry too).

## Testing

`tests/session-delete.host.spec.ts` drives the Remote over the composed Host (cold and live Agent paths, subagent refusal, the not-found miss, and each fail-soft fault with its warn); the JSONL suite owns the directory/flat-artifact destruction, the open-handle refusal, and the stat-fault rethrow; the persistence contract suite owns the abstract `delete` semantics including the never-materialized no-op; the cache and registry suites own `remove` and `removeSession` row/record/accounting behavior; client doubles and the ui-workspace row/modal specs cover the menu, modal copy, and the idempotent local removal.
