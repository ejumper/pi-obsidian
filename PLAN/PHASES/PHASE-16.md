# PHASE-16 — Tab session + draft restore

Status: implementing. User decisions (2026-11-17): restore open sessions across app
restarts/iOS kills; **fallback policy = new-session + a Notice** when the saved session can't be
opened (deleted = not wanted; the notice covers "something should have been here"); **composer
drafts restore too** (iOS recovery); machine-switch → new-session rule unchanged.

## Problem

`ChatView.getState()` persists only `{ instanceId }` — tabs survive restart with their machine
binding but open as no-session. iOS background kills lose even the composer draft.

## Design

- `getState()` → `{ instanceId, sessionId: string | null, draft: string }`. Old saved states
  (instanceId only) restore as today — backward compatible.
- Restore (`setState` → `maybeRestore()`, run once the view's store/composer exist — the existing
  onOpen/setState ordering dance): **verify-first** — `client.getSession(id)`; on success
  `store.openSession(id)` (existing cold-open path: transcript, SSE, run reconciliation — a run
  that outlived the app shows as still running), on failure stay new-session + `Notice`
  (404 → "was deleted?" wording; network → "machine unreachable" wording).
- Draft (`inputEl.value`) restores **regardless** of session outcome — typed text is valuable
  even if the session is gone.
- Save triggers: `app.workspace.requestSave()` when the bound sessionId changes (all paths:
  picker, panel, sends, forks) + debounced (~2s) on composer input. Covers the iOS kill window.
- Unchanged: machine switch resets the tab to no-session.

## Verification (walk before release)

1. Open session A in a tab, kill/relaunch → tab reopens on A with transcript + running state.
2. Delete session A on the machine, relaunch → tab opens new-session + Notice; draft restored.
3. Type a draft, kill the app, relaunch → draft text back in the composer.
4. `npm run check` green incl. the new restore checks.
