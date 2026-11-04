# Phase 1 — Core Chat

**Goal:** replace the ugly spike with the real, Obsidian-native chat experience (see
`PLAN/OVERVIEW.md` §3 for the settled design). Exit = the deferred phone validation rows
(PHASE-0 §4 rows 4–11) run against the polished UI.

## 0.0 Design recap (settled, do not re-litigate)

- Prompt editor at **top** of the view + primary button row under it (attach, model selector,
  open-file include/hide, send); transcript streams below in a virtualized scroll region.
- View header = session title (clickable → picker) + icon actions. Secondary actions are commands,
  surfaced in the ribbon-menu button.
- Prose renders via Obsidian `MarkdownRenderer` (theme-native); custom components only for
  tool-call cards, thinking blocks, diffs. Obsidian CSS variables only.
- iOS keyboard: composer anchors above `--keyboard-height`; transcript is a fixed-height
  virtualized column.

## 1.0 Tasks

### T5 — State store *(architect — load-bearing port, do first)*
`src/state/`: framework-agnostic TS port of the protocol logic from pi-web's
`hooks/useAgentSession.ts` (1,846 lines → distilled store):
- Session lifecycle: load history, lazy creation (`POST /api/agent/new`), command senders.
  Extend `AgentCommand` in `src/api/types.ts` to the full union (prompt/steer/follow_up/abort/
  set_model/set_thinking_level/set_tools/compact/abort_compaction/fork/navigate_tree/
  set_session_name/clear_queue/get_state/…).
- SSE event semantics: cumulative `message_update` snapshots → message list (replace, never
  append), `message_end` finalize, tool execution states, `queue_update` (steering/followUp
  queues), compaction/retry events, `extension_ui_*` frames (keep as state; terminal render is
  Phase 2). Unknown events ignored.
- Reconnect & reconciliation: `GET /api/agent/:id` snapshot poll (every 15s while running),
  `visibilitychange`/`online` reconnect (iOS background survival), handle 409 `{live:true}`
  (never fork a second agent onto a terminal-owned session) and lazy session-id assignment.
- **Verify:** typecheck/build; store demoed through the existing spike view behaviors + steering
  while running.

### T6 — Message rendering components *(executor, background)*
`src/views/render/`: message renderers, theme-native:
- Prose via `MarkdownRenderer.render()` (assistant + user), streaming re-render throttled ~100ms.
- Tool-call card: tool name + expandable args / result, error state; presentation borrowed from
  pi-web's message components (`components/MessageView.tsx` + tool rendering in pi-web).
- Thinking block: collapsed by default behind a toggle; `deferred` thinking left for Phase 2.
- Diffs: borrow pi-web's diff formatting logic, restyled to Obsidian vars.
- **Verify:** typecheck/build + architect review.

### T7 — Chat view assembly *(architect; after T5 + T6)*
`src/views/ChatView.ts` (replaces SpikeView):
- Top composer (auto-growing textarea + primary button row), virtualized transcript below,
  view header with session title + actions (new session, picker).
- Connection-state affordance from the store (disconnected / catching up / running).
- **Verify:** build + user look in `emulateMobile(true)` (Phase-0 row 4 lands here).

### T8 — Composer controls *(architect; with T7)*
- Model/thinking popover: `GET /api/models` → picker grouped by provider; `set_model` /
  `set_thinking_level` via store; shows current selection.
- Attach + open-file include/hide buttons: present but disabled with "Phase 2" tooltip
  (layout stays stable).
- Send semantics: Enter sends — `prompt` when idle, `steer` when running; Shift+Enter newline.

### T9 — Session picker & new session *(executor, background)*
- `SessionPickerModal extends SuggestModal<SessionInfo>`: fuzzy match on name/firstMessage/cwd;
  rows show modified date + running badge; selection opens in the current view.
- `NewSessionModal`: cwd input (prefilled from last-used cwd, persisted in plugin data) + optional
  first message → creates + opens.
- **Verify:** typecheck/build + architect review.

### T10 — Placement setting *(architect)*
- Settings radio: "Open pi in: Main area | Right sidebar"; `activateView()` honors it
  (`getLeaf("tab")` vs `getRightLeaf(false)`). Responsive CSS for narrow sidebar width.

### T11 — Commands & ribbon menu *(executor, background)*
- Commands: New session, Open session picker, Open pi, Cycle thinking level, Compact, Abort run.
- Ribbon icon opens a `Menu` (with submenu) holding the secondary actions.
- **Verify:** typecheck/build + architect review.

### T12 — Keyboard & scroll performance *(executor, background, tight spec)*
- Composer sticks above the soft keyboard: track root `--keyboard-height` (MutationObserver on
  root style) with visual-viewport fallback; bottom clearance `env(safe-area-inset-bottom)` with
  the `--safe-bottom` ≥ 20px floor (pi-web's solved pattern).
- Transcript virtualization: manual windowing — lock measured message heights, `display: none`
  messages >1.5 viewports from the visible region, restore before scroll-in (smart-second-brain
  findings; WebKit ignores `content-visibility`).
- **Verify:** typecheck/build + perf spot-check in emulated mobile.

## 2.0 Execution order

```
T5 (store) ──► T7 (assembly) ──► T8 (composer controls) ──► T10 (placement)
   ▲                ▲
T6 (renderers) ─────┘
T9 / T11 / T12 — executor, background, any time after T5 defines store interfaces
```

Delegation policy: executor runs are background + polled (2 stalls in Phase 0). Architect owns
T5/T7/T8/T10 (load-bearing + taste); executor owns T6/T9/T11/T12 (well-bounded).

## 3.0 Exit criteria

- Phase-0 matrix rows 4–11 all executed against the polished UI (phone rows included — the
  "wait until it's polished" gate is now open).
- The user daily-drives the plugin on desktop for a stretch without reaching for the pi-web PWA.
- `PLAN/OVERVIEW.md` gets Phase 1 checked; Phase 2 planning starts.

## 4.0 Risks

- **T5 scope creep**: `useAgentSession` encodes subtle semantics (queue steering, tree
  navigation, entry dedupe). Mitigation: port behavior-first, keep Phase-2 features (fork UI,
  tree nav UI) as store-only capabilities with no UI yet.
- **WebKit virtualization** (T12) is measured-dangerous on long chats — the exit phone rows are
  the real test.
- **Executor flakiness** (Phase 0: 2 failures) — background + poll mitigates stalls; architect
  takes over any task that fails twice.
