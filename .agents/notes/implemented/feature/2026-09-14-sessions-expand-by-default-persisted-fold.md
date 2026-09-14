# Agent Note: Session list expanded by default with a persisted fold (web)

Status: implemented

English | [中文](2026-09-14-sessions-expand-by-default-persisted-fold.zh.md)

## Problem

The grouped session list rendered folded by default: each open Workspace showed at most its first five non-blank Sessions (plus the provisional New Session row), and a "Show N more sessions" link was required to see the rest. That expansion was React-local state inside `SessionTree`, dropped on every unmount and page reload, so any user with more than five Sessions in a Workspace re-clicked the link on every visit — a repeated cost the fold did not offset. The user's fold/unfold choice had no persistence seam, even though the browser's existing view store already persists grouping, ordering, archived visibility, and group expansion.

## Decision

**Invert the default: an open Workspace group shows its full session list, the overflow control becomes a real collapse toggle, and the choice is persisted in the browser's existing workspace view store.**

- Store: the entry-declared view store gains `sessionFolding: Record<string, boolean>` — `true` is an explicit fold to the five-row quota; an absent key (or `false`) is expanded, the new default. The polarity is deliberately inverted from `groupExpansion` (absent = closed) because the feature flips the default; the record stores the *exception* to it. A new `setSessionFolded` action writes the one key, and `retainAccountKeys` prunes it alongside the other two records when a Workspace disappears, so deleted Workspaces leave no dead folds.
- Persist key: `dsh.workspace.view.v6` → `v7`. The engine rehydrates by raw-JSON wholesale `setState`, so a v6 payload lacking the new record would rehydrate `sessionFolding` as `undefined` and crash on the action's write; the old key is dropped rather than misread, per the `showArchived` bump's precedent.
- Component: `SessionTree` loses its transient `expandedSessionGroups` state and the `toggled` helper; expansion is `sessionFolding[group.key] !== true`. The overflow control's gate is unchanged (it renders whenever a group exceeds the quota), and its click writes the previous display state as the new fold: `true` folds, `false` records an explicit expansion. The group header's toggle flips only group expansion; the fold is orthogonal to it, so a group closed while folded reopens folded. The search-reveal effect lifts a fold only when one exists (writing `setSessionFolded(group, false)`): a selected result past the fold's quota lifts the user's own fold (persisting the lift), while a result inside the quota or an expanded list leaves the record untouched. Drag anchoring reads the same bit.
- No locale change: the existing `sessions.expand` / `sessions.collapse` keys ("Show N more sessions" / "Show less") already label both directions of the new toggle.

## Alternatives considered

**Persist the current local expansion list, keeping the folded default.** Fixes the re-clicking but not the default that motivates it: most Workspaces with more than five Sessions force a click on every reload, and keeping the old default preserves a state the fold was rarely chosen for.

**A global "always show all sessions" switch in the view options menu.** Removes the click but not the complaint's subject (the default), and it leaves the per-group quota as dead weight for the common case; a per-group fold stays useful for very large Workspaces.

**Drop the control entirely (always expanded).** Simplest, but the five-row quota exists to keep a very large Workspace's list manageable in the narrow sidebar; keeping the inverse direction preserves that escape hatch without changing the default.

## Consequences

- Sessions are visible without a click; a user who wants the compact list can collapse it, and that choice now survives remounts and reloads in the same browser-persisted store that already keeps grouping, ordering, archived visibility, and group expansion.
- The persist-key bump is a one-time client rehydrate: stored view preferences reset to defaults once, and the manual session arrangement is the one user-edited value that is dropped rather than misread.
- A search reveal whose row sits past the user's fold silently lifts (and persists) that fold; a reveal inside the quota leaves the fold intact, so searching never reshapes a list the user did not ask to change.
- The new-session web-e2e golden changes from five rows plus a "Show 1 more sessions" button to all six plus "Show less"; the scenario now also pins the fold across a page reload.

## Testing

The rewritten `workspace-browser.client.spec.tsx` pins the default-expanded projection, fold and unfold through the control (recording the store), the fold surviving group close/reopen, the blank row outside the quota under a persisted fold, drag anchoring under a persisted fold, pruning of a deleted Workspace's fold, and all three reveal paths (fold kept inside the quota, fold lifted and persisted past it, expanded list untouched). The web e2e lane pins the new golden, fold/unfold, and the reload survival; `workspace-management.e2e.ts` reads the bumped v7 key, and the scrollbar scenario no longer clicks its way through the show-more chain. The package READMEs (English and Chinese) restate the new default and its persistence.
