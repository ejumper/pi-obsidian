# Phase 3 — Right Panel (pi panel)

**Goal:** a dedicated `pi-panel` view in the right sidebar that owns session switching, run
controls, and settings shortcuts — replacing pi-web's left panel. The right sidebar is no longer
a chat placement; it is pi's control center (chat stays main-area only, per Phase 2).

## 0.0 Design recap

Contents (all sessions data from `GET /api/sessions`):
1. **Settings buttons row** — Models / Skills / Plugins (open the plugin settings tab).
2. **View toggle** — Recent | Folders (segmented two-button control; Folders lands Phase 4 —
   toggle present but Folders shows a placeholder).
3. **Session list (Recent)** — all sessions sorted by `modified` desc; rows: name/firstMessage,
   date, running dot. Click → open in the chat view.
4. **Control buttons** — New session, thinking level (pill-selector), compact.

Layout is mirrored like Obsidian's own sidebars:
- **Mobile** (bottom→top): tab-selector (app chrome) / control buttons group / view toggle /
  session list / **settings row pinned to top**.
- **Desktop** (top→bottom): control buttons / view toggle / session list / **settings row
  pinned to bottom**.

## 1.0 Tasks

### T16 — Panel view shell *(architect)*
- `VIEW_TYPE_PI_PANEL` registered; opened into the right split (`getRightLeaf(false)`), command
  "Open pi panel" + ribbon-menu entry. On mobile it is a drawer (Obsidian convention).
- Store targeting: panel controls act on the **most recently active ChatView's store** — the
  plugin tracks the active chat leaf (on open/focus) and exposes `activeStore()`. Panel renders
  from that store's state (thinking level, running) and refreshes via its subscription.
- **Verify:** build + panel opens on desktop & emulateMobile; controls move the live session.

### T17 — Pill-selector component *(executor, background)*
- Clone of Obsidian mobile's tab-selector pill (see NOTES/IMG_6276.jpg closed, IMG_6277.jpg
  open): rounded pill = icon + label + chevron; tap opens a rounded overlay listing options with
  icons, current option highlighted; selecting closes and applies.
- API: `class PillSelect<T>` — `constructor(opts: {icon, label, options: {value, label, icon}[], value, onChange})`,
  renders into a container. Pure DOM + Obsidian CSS vars; must work at narrow panel widths.
- **Verify:** typecheck/build + visual review in emulateMobile.

### T18 — Session list (Recent) *(executor, background)*
- Reusable `SessionList` component: rows (name/firstMessage truncated, `YYYY-MM-DD HH:MM`, `●`
  running), grouped newest-first, click callback. Refreshes when panel opens + manual refresh
  icon. Skeleton rows while loading.
- **Verify:** typecheck/build + review.

### T19 — Control buttons *(architect)*
- New session → new-session flow (Phase 4 replaces modal with tree-pin behavior; until then
  open NewSessionModal).
- Thinking level → T17 pill (`store.setThinkingLevel`), reflects active session state.
- Compact → `store.compact()` on the active session (confirm-lean: single tap, like pi-web).
- **Verify:** build + manual against a running session.

### T20 — Settings buttons *(architect)*
- Models / Skills / Plugins buttons (icon + label) that open the plugin settings tab.
- **Models works now**: settings gains a **Models** section — minimal port of pi-web's
  ModelsConfig: default-model picker + read-only model list (`GET /api/models`). Provider
  auth/API-key management stays in the pi-web site for now (port is its own project).
- Skills / Plugins buttons present but disabled with "coming soon" tooltip.
- **Verify:** build + Models section changes the default for new sessions.

## 2.0 Exit criteria

- Panel drives a live session end-to-end (switch session, change thinking, compact, new session)
  from both desktop sidebar and mobile drawer layouts.
- Recent list is the primary session switcher; the picker modal from Phase 1 is retired.

## 3.0 Risks

- Active-store targeting with multiple chat leaves: v1 = most recently active leaf; revisit if
  split-view use shows confusion.
- Pill overlay on iOS must respect the safe-area bottom (it opens near the screen edge).
