# Phase 10 (group D) — Bottom-Bar Takeover

**Goal:** while pi is open, the composer block covers Obsidian's mobile bottom nav
(back/forward/search/new-tab/tab-count/terminal — dead weight inside pi), controls sit lower
for easier reach, and the session reclaims the space. The nav's one useful button — the tab
button — joins our button row. Everything is exactly unchanged when the keyboard is open.

## 0.0 Design recap (user decision 2026-11-08)

- Units: **u = button-row button height** (`--input-height`, ~40–44px). The user's targets are
  ruler estimates — buttons end up starting ~1.5u above the screen bottom, the block moves down
  ~1u from today, and the composer's background padding extends to the bottom edge so controls
  aren't flush against it. Tune against real pixels; intent beats literal numbers.
- Keyboard OPEN: composer bottom stays `keyboard height + 6px` exactly as today — the nav is
  already covered by the keyboard and padding controls upward there would waste the only screen
  space that matters. The takeover is a **closed-state geometry change only**
  (`composerBottomPx()` closed branch + composer `padding-bottom`).
- The cover only exists while the pi view is shown (the composer already hides with the view);
  other tabs look normal. Nothing on the covered nav is lost — it's reachable in any other tab.
- Tab button (far left of the button row): square, current tab count in the center (same idea
  as the nav's), **tap = tab overview** (invoke the command the user pointed at — find its id
  via `app.commands.listCommands()` during implementation), **long-press = menu** with
  "Open new tab" and "Close current tab" (invoke the existing commands through `app.commands`
  if a clean API isn't available; Obsidian `Menu` renders the menu at the touch point).
- The mentions toggle moves to the panel's Controls row **on both desktop and mobile** (no
  divergence), styled like the removed thinking pill: file icon + "Include" / file-x icon +
  "Exclude". Desktop's button row becomes attach / model / send.

## 1.0 Tasks

### T38 — Closed-state composer geometry
- Measure on-device: nav height, safe-area, u. Rework the closed branch of
  `composerBottomPx()` in `src/views/keyboard.ts` and the composer's `padding-bottom`
  (`styles.css`) per the recap. The transcript end (content-height anchoring in ChatView's
  geometry loop) follows automatically — verify it does.
- Desktop closed state: unchanged or minimally adjusted (no nav to cover there) — keep it
  looking right in splits too.

### T39 — Tab button in the button row
- New button (mobile-first; show on desktop only if it stays coherent): square tab icon with
  tab-count center, tap → tab overview command, long-press → Menu (new tab / close current tab).
- Tab count = open workspace leaves (the mentions enumeration logic already walks leaves —
  reuse its traversal semantics, count tabs not file leaves).
- Long-press handling on iOS: `pointerdown`/`touchstart` timer (~500ms) + suppress the click.

### T40 — Mentions toggle → panel Controls row
- Move the include/exclude toggle from the composer button row to PanelView's Controls row
  (filling the slot freed by T35). Same PillSelect style as the old thinking pill; both
  layouts identical. Settings binding unchanged.

## 2.0 Verification

- Phone, keyboard closed: nav is covered, controls sit at the target height (thumb-reachable,
  not flush against the edge), session visibly gains the space; last message clears the
  composer. Keyboard open: pixel-identical to today.
- Tab button: count matches open tabs; tap opens the overview; long-press menu's both items
  work. Nav visible again the moment pi isn't the active view.
- Mentions toggle behaves identically from its new home; button row = attach / model / send.
