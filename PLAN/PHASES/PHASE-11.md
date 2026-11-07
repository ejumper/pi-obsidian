# Phase 11 (group E) — Multiple pi Tabs

**Goal:** several pi sessions open at once in different tabs (and desktop splits), each with its
own session and composer, with panel/ribbon/commands targeting the focused one. Final release
after this phase completes: **0.3.2** (all of phases 7–11 ship together).

## 0.0 Design recap

- Obsidian supports multiple leaves of one view type; the architecture is already most of the
  way there: every `ChatView` owns its own `agent-store` and its own body-attached composer
  (in a desktop split each composer anchors to its own pane's rect — that falls out for free
  and is a feature).
- The missing concept is an **active pi view**: panel actions (session pickers, controls,
  settings buttons), the ribbon menu, and session-opening must target the pi view in the
  focused leaf, not a singleton. Track `active-leaf-change` in the plugin.
- Open policy (decision 2026-11-08): keep "Open pi" as "focus existing or create", and add a
  **new command "Open pi in new tab"** that always creates a fresh pi tab.
- Multi-session is fine server-side: each session is its own agent stream; N views = N SSE
  connections.

## 1.0 Tasks

### T41 — Active pi-view tracking
- Plugin tracks the most recently active `pi-chat` leaf (`workspace.on("active-leaf-change")`
  + `getLeavesOfType("pi-chat")`); PanelView and all commands act through it.
- Views register/unregister on open/close; no references leak (headless harness: open two
  views, close one, ensure the other still renders).

### T42 — Open-in-new-tab command & leaf policy
- New command "Open pi in new tab" (`app.workspace.getLeaf("tab")` + `setViewState`).
- Existing "Open pi" focuses the current pi view if one exists (mobile: switch to its tab;
  desktop: focus its pane) — only creates when none exists.
- Verify Obsidian's own tab behaviors work on pi tabs: drag-to-reorder, tab context menu
  (close/split), and that closing a pi tab detaches its composer from `document.body` (the
  `onClose` cleanup path — double-check it under multiple instances).

### T43 — Concurrent-sessions verification + harness coverage
- Two+ sessions streaming simultaneously update only their own transcripts (stores are
  independent — prove it).
- Switching tabs mid-run keeps each run's state intact; the panel's session list reflects the
  active view's session; model/thinking settings apply to the active view's session.
- Headless harness: open two `pi-chat` instances concurrently, assert both paint and both
  close cleanly (`test/headless-check.mjs` extension).
- Perf spot-check on desktop with 3 tabs (each view renders its own transcript — fine at
  current sizes; note anything surprising in this file).

## 2.0 Verification

- Two pi tabs with two different sessions, both streaming: outputs land in the right
  transcripts. Tab switch changes panel target. No stray composers remain after closing tabs.
- Everything from phases 7–10 verified again with two tabs open (geometry loops, indicators,
  message actions all per-view).
- `npm run check` green; version 0.3.2 staged (`dist/`) for the user to publish.
