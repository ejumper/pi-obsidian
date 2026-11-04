# Phase 4 — Folders Picker & Session Paths

**Goal:** the second session-picker view (Folders): a server-side file tree styled like Obsidian's
explorer, session-oriented, plus the "Default Session Path" setting and the new-session cwd
fallback chain.

## 0.0 Design recap

- **Settings: "Default Session Path"** (optional) — the browser-homepage analog. New sessions
  resolve their cwd via the chain: **default path (if set) → currently open session's cwd →
  last created session's cwd (persisted) → `pathPrefix`** (the vault-mapping setting, reused as
  "the configured root"). `pathPrefix`'s leading `~` is expanded server-side-safe via
  `GET /api/home` at use time (never send `~` to `existsSync`-checked endpoints).
- **Folders view**: tree root = Default Session Path if set, else `pathPrefix` resolved. Up-
  navigation (".." row / breadcrumbs) climbs above the root. Tree data comes from the **server**
  (`GET /api/files/<path>?type=list`), NOT the vault — the vault tree may drift from the server's
  and must never seed a bogus cwd. Rendering copies Obsidian's explorer look (indent guides,
  collapse chevrons, theme vars).
- Each directory lists, in order: pinned **`[ New session ]`** entry first, then sessions whose
  `cwd` is exactly that dir, **most recent first** (per-dir recency; the Recent view stays
  global-recency).

## 1.0 Tasks

### T21 — Path resolution *(architect)*
- `src/state/paths.ts`: `resolveServerPath(settingValue)` — expands leading `~` via a cached
  `GET /api/home`; `resolveNewSessionCwd()` implementing the fallback chain; persist
  `lastSessionCwd` on session creation (replaces the old `lastCwd` usage).
- Settings UI: "Default Session Path" text field (placeholder shows the chain fallback).
- **Verify:** typecheck/build + chain exercised against the desktop instance.

### T22 — Tree component *(executor, background)*
- `src/views/panel/ServerTree.ts`: lazy-expanding tree (dirs only), indent guides + chevrons,
  Obsidian file-explorer styling via theme vars; rows injected per dir: pinned `[ New session ]`
  action row + session rows (reuse Phase 3's SessionList row rendering). API:
  `constructor(rootPath, client, { onNewSession(cwd), onOpenSession(id) })`.
- Handles: empty dirs, unlistable dirs (graceful error row), `~` display (show the literal
  setting-form path in breadcrumbs).
- **Verify:** typecheck/build + review.

### T23 — Folders view wiring *(architect)*
- Panel's Folders mode mounts T22's tree with root per the settled rules; view toggle switches
  Recent|Folders (state persists across panel opens).
- `[ New session ]` → sets the chat view's **pending-new-session cwd** (no modal): the chat
  shows "new session · <cwd>" and the first sent prompt creates it there via
  `store.startNewSession(cwd, message)`. (Small store/view change: a prepared-cwd state.)
- **Verify:** build + manual: create sessions in two dirs via the tree, confirm cwd lands right.

## 2.0 Exit criteria

- Folders view navigates the server tree, creates sessions in-place, opens existing ones.
- The cwd fallback chain behaves per spec in every branch (default set/unset × session
  open/closed).

## 3.0 Risks

- `GET /api/files` allow-roots: pi-web's file API gates paths (`allowFileRoot`); if the tree 403s
  outside known roots, fall back to `/api/browse/allow` + `cwd/validate` endpoints as pi-web does.
- Server list caching (30s session-list cache) means fresh sessions may lag in the tree —
  refresh-on-open covers it.
