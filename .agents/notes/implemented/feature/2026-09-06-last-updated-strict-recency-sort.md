# Agent Note: Last updated as a strict recency sort

Status: implemented

English | [中文](2026-09-06-last-updated-strict-recency-sort.zh.md)

## Problem

The view menu's **Last updated** order promised a recency view but shipped a different mechanism: the per-account order persisted in the browser's localStorage was frozen, and only a Session whose `updatedAt` grew past the persisted observation snapshot jumped to the front, once. Browsers that loaded the same Host data at different times therefore held different frozen orders, so the same selection legitimately rendered different lists in different browsers. The label named a sort; the behavior delivered browser-local history. A drag in that mode edited an order the label no longer described, and the one-time promotion could not be explained by anything the user saw.

## Decision

**Last updated** is now a strict recency sort computed at render time: newest `updatedAt` first, with the stable Session id as the tie-break. The sort applies to each Workspace group's members and the Ungrouped bucket in grouped presentation and to the flat list. The display is a pure function of the Host session list, so it is identical in every browser, renders the recency order on first paint instead of a stale persisted order, and re-sorts as soon as an activity timestamp moves.

The mode persists nothing. The persisted per-account Session order (`sessionOrderByAccount` under `dsh.workspace.view.v6`) is read and written only while **Manual** is selected: the browser reconciles each account's stored arrangement with its current members — appending new ids in account order and dropping vanished ones — and writes it back only when it changed. Switching to Last updated leaves the stored arrangement untouched; switching back restores it exactly, so the mode round trip is lossless in both directions.

Session dragging is Manual-only. While Last updated is active, session rows are not draggable, because a drop there would be invisible behind the per-render re-sort. Manual-mode drag behavior is unchanged: real-Workspace drags write the browser-local account and the Host Session account, while Ungrouped and flat-list drags remain browser-local.

The one-time promotion machinery is removed: the persisted `sessionUpdatedAtByAccount` observation timestamps, the switched-to-Last-updated resort flag, and the per-activity promotion branch are gone from the store and the browser. The persist key stays `dsh.workspace.view.v6`: pre-removal payloads that carry the now-inert `sessionUpdatedAtByAccount` key rehydrate harmlessly, so no key bump is needed. Both recency comparators now return zero for equal ids, keeping the comparator contract total. The blank New Session's one-time creation-time promotion into its grouped and flat accounts — which does not advance `updatedAt` — is kept: it positions the row for Manual and is display-neutral while Last updated renders the recency sort.

The view menu labels **Manual** and **Last updated** are unchanged; Last updated now matches its label.

## Alternatives considered

**Keep the promotion semantics and repair the per-browser divergence.** Promotion over a frozen order is irreparably browser-history-dependent: the same selection would keep showing different lists in different browsers, and the label would keep over-promising a sort.

**Persist a second, Last-updated-owned order per account.** The display would then read a persisted order instead of the data, reintroducing first-paint staleness and a second bookkeeping stream, while storing a projection of the data rather than any user arrangement.

**Hide the order menu while sessions are unchanged.** The selection would stop being meaningful in one mode, and the menu would become conditional chrome for a difference the user can already see in the rows.

## Consequences

- Last updated is a true recency sort in every browser and both presentations at all times; the selection matches its label, and an activity timestamp moves a row as soon as the list refreshes.
- Manual keeps its exact arrangement across mode switches and reloads; a Last updated detour no longer disturbs it.
- Session dragging disappears from the Last updated presentation. A user who wants to pin a row by dragging must switch to Manual; the removed drag affordance is the only lost interaction.
- The view store loses one persisted field. Existing v6 payloads that carry it rehydrate with the key inert; no migration or key bump.
- The one-time New Session promotion and Manual-mode drag semantics from [Workspace Sidebar Order and Folding](2026-08-11-workspace-sidebar-order-and-folding.md) stand unchanged; that note's promotion sentences are superseded by this decision.

## Testing

UI tests pin the new semantics: the Last updated display is a strict recency sort with a stale stored arrangement present — in a Workspace group, the Ungrouped bucket, and the flat list — and the mode leaves the persisted order untouched and marks rows non-draggable; user activity re-sorts the display without a store write; returning to Manual restores the stored arrangement and persists it across remount. The store spec pins the removed field's absence, the two-argument `syncSessionOrderAccount`, and retention without the timestamp map. The workspace-management Web e2e still pins the v6 persist key.
