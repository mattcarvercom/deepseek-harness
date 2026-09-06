# Agent Note: Session unarchive and the archived-sessions view (web)

Status: implemented

English | [中文](2026-09-06-web-session-unarchive.zh.md)

## Problem

[Session archive](2026-07-31-session-archive-global-set.md) hides a session from every display surface, but the hidden sessions were unreachable: no surface listed them, and the row menu's archive row had no inverse. Archived sessions accumulate invisibly — the user could not see what had been hidden, let alone bring a session back. The archive note recorded a restore surface as future work: one UI surface plus one inverse RPC. This note is that surface.

## Decision

**The inverse RPC is a pure set removal (`unarchiveSession`), and the viewing surface is a "Show archived sessions" toggle inside the existing view-options menu — default off, so no always-visible chrome changes.**

- Registry: `ctx.workspaceRegistry.unarchiveSession(id)` rides `enqueueOperation` and filters the id out of `archivedSessionIds`. It deliberately has no `sessionKnown` check — unarchiving an id that is not in the set is an idempotent no-op, and a session whose log vanished after archiving still lifts. The retained `sessionIds` slot makes the lifted row land back in its original position without any re-join logic.
- RPC: `workspace.unarchiveSession({sessionId}) → {archivedSessionIds}` reuses the archive request and value types (symmetry: both answer with the full updated set); no new error code is needed because the operation never fails for an unknown id. The feed's existing set-diff `archived` frame publishes the change like any other.
- Client: `ClientWorkspaceModel.unarchiveSession` installs the echo exactly like its archive sibling; the `IWorkspaces` face and `UiWorkspaceService` forward it. `tree.ts` gains a `showArchived` flag threaded through `deriveGroups`, `deriveFlat`, and `deriveSearchResults`: the hidden set is `archivedSessionIds` when the flag is off and empty when on, so one `sessionVisible` arm serves both postures and lifted rows keep their retained slots. `SessionNode.archived` marks lifted rows for the dimmed title and the menu swap.
- UI: the view-options popover gains a separator, an "Archived" section label, and a "Show archived sessions" check row (checked via the Menu's `selectedIds`). Lifted rows render dimmed (`--dsw-alias-label-dimmed`) in their retained positions across grouped, flat, and search surfaces; the row menu swaps Archive for Unarchive, reusing the archive glyph because no unarchive icon exists in `ui-primitives`. The toggle lives in the entry-declared view store (`showArchived`, persisted key bumped to `dsh.workspace.view.v6`); a failed unarchive warns and keeps the row.

## Alternatives considered

**A dedicated archived-sessions panel or second browser tab.** More chrome for a small, rarely touched set, and it splits the browser's single row vocabulary; a filter inside the existing view options keeps one surface and one row design, with the default DOM unchanged (no e2e fixture churn).

**`unarchiveSession` requiring a known session, like `archiveSession`.** Symmetric on the surface, but unarchive has no join to validate: the only side effect is set removal, and rejecting a user who archived before a log cleanup would strand ids the set-diff frame cannot otherwise clear. Idempotence is the honest contract.

**A new unarchive glyph.** The icon set ships no unarchive arrow; reusing the archive glyph with the inverse label keeps the pair visually related and defers icon work to a broader icon pass.

## Consequences

- Archived sessions are viewable and liftable from the existing browser; the default view is byte-identical to before (toggle off), so shipped e2e fixtures replay without re-recording.
- The persist-key bump is a one-time client rehydrate: a new `showArchived` field cannot merge into the raw-JSON rehydrate path, so the old key's state is dropped rather than misread.
- Unarchive restores position, not state: the session's log, title, and interactions are exactly as left; nothing is re-derived at lift time.
- Deletion stays the destructive sibling: `removeSession` still strips archive membership, and unarchiving never resurrects a deleted session (its id is gone from every record).

## Testing

`packages/workspace/workspace` registry specs pin removal, idempotent no-ops, durability, and the logged-away id lifting; the workspace-controller host/model/transport specs pin the command, the echo install, and the facade error mapping; `tree.client.spec.ts` pins lifted rows at their retained slots with the marker in groups, flat, and search plus the hidden-set flip; the store spec pins the toggle default and action; the browser and rows specs pin the toggle row, the lifted dimmed row, the menu swap, and both failure warns.
