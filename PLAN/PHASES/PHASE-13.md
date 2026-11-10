# Phase 13 — Multi-Instance Machines

**Goal:** configure named pi-web instances in settings and bind each pi tab to a machine. The
panel's pill switches the focused tab's machine; sessions, prompts and streams all route to the
tab's own instance. *(0.4.0, with Phase 12.)*

## 0.0 Design recap (decisions locked 2026-11-07)

- Environment: identical pi-web instances (same settings/models/extensions, same
  `~/HalfaCloud` paths via Nextcloud) on the server container, server, Server2, laptop,
  desktop. **Session storage is NOT synced** (kept outside Nextcloud deliberately) — so each
  machine has its own session list; "switch machine → reset to no-session" is honest.
- Settings: `baseUrl` migrates to `instances: [{ id, name, baseUrl }]`. Entry #0 is the
  "Default URL" (its own Name + URL fields), "Add URL" appends entries (URL 2, URL 3, …),
  each removable. The panel's three settings links are deleted (settings stay reachable via
  settings search); the machine pill replaces them.
- Routing: **one instance binding per pi tab** (ChatView carries `instanceId`; its store uses a
  cached per-instance `PiClient`). Prompts/streams/lists route through the tab's own client.
- Pill semantics: shows the focused pi tab's machine; switching resets THAT tab to
  no-session (its store rebinds to the new client) and the panel lists the new machine's
  sessions.
- New tabs open on the **last-used** machine (persisted `lastUsedInstanceId`); a fresh
  first-ever tab uses instances[0] (the default). Updated whenever a pi view gains focus.
- Soft warning if a session id is opened while the same id is open on another tab bound to a
  DIFFERENT machine (session storage could change later; should never fire today).
- Gotcha (in-repo knowledge): the verbatim React subtree fetches through a module-global API
  base (`api-base.ts`) — set it per transcript render pass (same pattern as the markdown
  context) so two tabs on different machines don't race it.

## 1.0 Tasks

### T45 — Settings schema, migration, instance clients, settings UI
- `PiInstance { id, name, baseUrl }`; `instances` in settings; `loadSettings` migrates a
  legacy `baseUrl` into instances[0] (id "instance-1", name "Default").
- Plugin-level `getClient(instanceId): PiClient` cache (rebuilt when settings change) and
  `getActiveClient()` (focused tab's, else default).
- Settings tab: entry 0 = "Default URL" (Name + URL fields), further entries "URL N" (Name +
  URL + remove button), "Add URL" button appends. Existing "Base URL" field is gone.

### T46 — Per-tab instance binding (the routing core)
- ChatView: `instanceId` field (default = last-used ?? instances[0]); `createStore()` uses
  `plugin.getClient(instanceId)`.
- `getState()/setState()` (Obsidian leaf state) persist `{ instanceId }` so tabs keep their
  machine across app restarts.
- `setInstance(id)`: store rebinds (close stream, reset to no-session state, swap client —
  or recreate the store; pick the cleaner at implementation), then re-render.
- `lastUsedInstanceId` persisted on focus (the existing setActiveChatView path).
- The transcript glue sets the global API base from the tab's client before each render pass.
- Soft warning on cross-machine duplicate session open (see 0.0).

### T47 — Panel machine pill
- Delete the three settings links from PanelView; add a PillSelect (same style as the
  include/exclude pill) listing instance names, value = focused tab's instance.
- Switching calls `withChatView((v) => v.setInstance(id))`; the session lists (Recent +
  Folders) fetch through the focused tab's client (`getActiveClient()`).
- The pill re-syncs when the focused tab changes (panel refresh path).

### T48 — Harness coverage
- Extend `test/context-usage-check.mjs` (or a sibling) with a two-instance case: mock fetch
  keyed by base URL; two views bound to different instances; assert each store's requests hit
  its own base and a machine switch resets the tab.

## 2.0 Verification

- Settings: add/rename/remove instances; legacy settings migrate cleanly on the phone.
- Two tabs on two machines: sessions list per machine, prompts/streams land on the right
  machine, context size per machine, restart keeps each tab's machine.
- Pill: shows focused tab's machine; switch resets the tab and re-lists sessions; new tab =
  last-used machine; first tab = default.
- Cross-machine duplicate-session warning fires when forced (same session id on both).
- `npm run check` green. Version 0.4.0 staged.
