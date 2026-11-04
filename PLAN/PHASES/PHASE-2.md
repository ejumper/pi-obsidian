# Phase 2 — Layout & Composer (bottom-anchored)

**Goal:** rebuild the chat view's chrome to the agreed app design: composer block pinned to the
bottom of the viewport (floating above the soft keyboard on mobile), auto-growing editor, the
new button row with real states, and the sidebar placement option removed.

## 0.0 Design recap (settled — see PLAN/OVERVIEW.md §3)

Layout top→bottom: thin session bar (title → opens pi panel, status, version), transcript
(flex:1, scroll), composer block (auto-grow editor + button row). This REVERSES Phase 1's
top-composer: the keyboard.ts vars flip back — composer gets
`margin-bottom: max(var(--pi-keyboard-inset), var(--pi-safe-bottom))`, transcript drops its
keyboard padding and instead gets bottom breathing room.

## 1.0 Tasks

### T13 — Composer block *(architect)*
- Move composer DOM to bottom of view (order: bar / transcript / composer).
- Auto-grow editor: starts 1 row (+ padding), grows with softwrap/newlines to a cap (~8 lines
  or 35vh), then scrolls internally. Reset height on send/clear.
- Enter sends (Shift+Enter newline — keep). Keep send routing: idle → `sendPrompt`/`startNewSession`,
  running → `steer` (see T14).
- **Verify:** build + manual: grow/scroll behavior, keyboard clearance in emulateMobile.

### T14 — Button row & states *(architect logic, executor for icon components/CSS)*
Left→right: attach, include/hide, model chip … … send|stop+queue.
- **Send**: circular, `--interactive-accent` bg, `--text-on-accent` fg, `lucide-arrow-up`.
  Only right-side button while idle. Disabled (dimmed, inert) when editor is empty/whitespace.
- **Running state**: Send is replaced by two right-side buttons:
  - **Stop** — pill, label "Stop", `--color-red` bg with contrast fg → `store.abort()`.
  - **Queue** — circular `lucide-arrow-right`; dimmed when editor empty, `--color-yellow` bg when
    text present → `store.steer(text)` (steer semantics only; follow-up UI deliberately dropped).
- **Attach** — `lucide-paperclip`, opens OS file picker (wiring lands in Phase 5; button disabled
  with tooltip until then).
- **Include/hide** — `lucide-file` (included) / `lucide-file-x` (excluded) + count badge of files
  that would be mentioned (wiring lands Phase 5; button disabled with tooltip until then).
- **Model chip** — `lucide-cpu` + truncated current model name; opens a Menu of models
  (`GET /api/models` grouped by provider) + a thinking-level submenu (replaces the old "model"
  button; `store.setModel` / `store.setThinkingLevel`).
- Icon buttons follow Obsidian conventions: icon-only, `aria-label` + tooltip titles.
- **Verify:** build + manual state matrix (idle empty / idle text / running empty / running text).

### T15 — Placement removal *(architect)*
- Remove the "Open pi in" setting and the sidebar branch of `activateChatView` (chat = main area
  only). Stale setting values are harmless (Object.assign ignores extras).
- Title click behavior: until Phase 3's panel exists, keep opening the existing picker modal
  (stopgap — noted for removal in Phase 3).
- **Verify:** build + settings tab shows the reduced set.

## 2.0 Exit criteria

- Composer block sits at the bottom and lifts above the keyboard in emulateMobile.
- All four button states behave per spec; model chip switches models on a live session.
- No sidebar placement anywhere.

## 3.0 Risks

- iOS keyboard: bottom composer is the classic failure zone (copilot PR #3892) — matrix row 4
  re-run on the phone after this phase.
- Auto-grow textarea + `--keyboard-height` interplay: height cap must not push the editor off
  screen when the keyboard is open (cap = min(lines, viewport - keyboard inset)).
