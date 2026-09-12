# ADR-015: A generic undo toast as the default hard-delete affordance

**Status:** Accepted

## Context

Two unrelated features each needed to let a user recover from a destructive action without a
blocking confirmation dialog:

- The search/filter bar's (`docs/adr/ADR-014-search-filter-bar.md`) saved-filter delete is a
  real, owner-only hard delete (`internal/savedfilter`'s backend enforces it) — clicking the
  cross on an applied filter's chip had no safety net beyond "are you sure?", which blocks the
  interaction and (per user feedback on the bar's UX) doesn't fit alongside the rest of the bar
  now that filters live as always-visible chips rather than a menu the user has to reopen.
- The Calendar view's (`docs/roadmaps/list-view-modes.md` Phase 3) drag-a-record-off-the-grid
  flow used a blocking `Dialog` to confirm clearing the date field — inconsistent with every
  OTHER drag in that same file (the Unscheduled panel's own drop clears the date with zero
  confirmation) and with Kanban's drags elsewhere in the engine, all of which act immediately
  and revert-on-error rather than ask first.

Building a one-off "are you sure" or a one-off toast for each would repeat the same problem
ADR-011's form actions menu solved for custom actions: bespoke, non-reusable UI for a pattern
that recurs. The explicit ask was for a **single, generic mechanism this becomes the default
hard-delete affordance for**, sized for exactly these two adopters now — not a queued
notification system or a body of hypothetical future requirements.

## Decision

### 1. One plain Zustand store, one pending slot, no queue

`views/undo-toast.tsx`'s `useUndoToastStore` holds at most one `{ id, message, onRecover,
onExpire? }` — not `createOpsContext`'s host-injected-Server-Action pattern (this is transient
client UI state with no backend contract of its own, the same shape `useUiStore` and
`useRecordLabelStore` already use), and not a queue. A second `show()` while one is pending
immediately fires the first's `onExpire` and replaces it. `// ponytail: single pending slot, a
real queue is the upgrade path if two hard deletes ever need to be undoable at once` — sized to
the two adopters that exist today, not to a hypothetical stacked-notifications future.

### 2. `onRecover` required, `onExpire` optional — covers both commit timings a delete can have

The two adopters commit at different points, and the API has to fit both without a second
mechanism:

- **Deferred-commit** (saved-filter delete): the chip disappears immediately, but the actual
  `SavedFilterOps.remove` call only happens in `onExpire`, once the undo window has genuinely
  elapsed. Recovering costs zero backend calls — it never happened.
- **Eager-commit-with-reversal** (Calendar's drag-off-to-unschedule): the field PATCH already
  fires immediately, matching how every other drag in that renderer already behaves. `onRecover`
  just PATCHes the prior value back; no `onExpire` is needed since there's nothing left to
  finalize.

A single `show({ message, onRecover, onExpire? })` shape serves both call sites; forcing one
timing model onto both features would have meant a second API anyway.

### 3. Dismiss hides the banner; it does not cancel the undo window

The toast's own `×` (`dismiss()`) only clears the visible `pending` state — the `onExpire` timer
set by `show()` keeps running untouched. This matches ordinary toast semantics elsewhere
(closing a "message deleted" toast doesn't itself undo the deletion) and the literal ask: a
cross to delete *the notification*, not a second way to cancel the delete. `recover()` is the
only path that stops the timer.

### 4. Mounted once, globally, no provider

`<UndoToastHost />` mounts once in `apps/shell/app/layout.tsx`, alongside the other
root-mounted providers — but it isn't one itself. Any component anywhere can call
`useUndoToastStore.getState().show(...)` directly, the same way `useUiStore` is reached today,
with no context to thread through the call site.

### 5. A triggering component must route `onRecover` through a ref, not a bare closure

`onRecover` fires long after the render that created it is gone. A callback that closes directly
over that render's state can go stale: Calendar's first attempt captured `moveField` (and
therefore the `records` array it closed over) directly in the `onDragEnd` handler — by the time
`Recover` was clicked, `moveField`'s own "no-op if the value is already what's being set" guard
saw the ALREADY-cleared value in that stale `records` snapshot and silently did nothing. The fix
is a ref updated every render (`moveFieldRef.current = moveField`) so `onRecover` always calls
into the latest state. Any future adopter with a similar internal no-op guard needs the same
ref indirection — a plain closure is only safe when the callback fires within the SAME render's
lifetime.

## Consequences

- Only one hard delete can be "pending undo" at a time app-wide. Two rapid hard deletes in
  different parts of the UI will silently finalize the first the moment the second is
  triggered — acceptable today (the two adopters are never both mid-flow at once in practice);
  a real queue is the documented upgrade path if that changes.
- `onExpire`/`onRecover` correctness is the CALLER's responsibility — the store itself has no
  knowledge of what it's undoing. A future adopter forgetting the ref-indirection pattern above
  reintroduces the exact stale-closure bug Calendar hit first.
- No keyboard path (e.g. an "undo" shortcut) exists yet — v1 gap, same posture the Kanban/
  Calendar drag-and-drop mechanics already carry (`docs/roadmaps/list-view-modes.md`'s
  Pitfalls).

## Reference implementation

`packages/core-front/src/views/undo-toast.tsx` (`useUndoToastStore`, `UndoToastHost`),
`apps/shell/app/layout.tsx` (mount point), `packages/core-front/src/views/search-bar.tsx`
(`deleteSavedFilter` — deferred-commit adopter), `packages/core-front/src/views/
calendar-renderer.tsx` (`onDragEnd`'s drop-outside-the-calendar branch, `moveFieldRef` —
eager-commit-with-reversal adopter).
