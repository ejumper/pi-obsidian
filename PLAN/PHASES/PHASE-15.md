# PHASE-15 — pi-bridge: extract pi-web's API into a pi-native daemon

Status: **A ✅ parity proven at /opt/pi-web (2026-11-17) · B ✅ all four pi installs live · C ✅ pi-web
retirements done (staged removal: container stopped, desktop unit deleted; physical cleanup later).**
Phasing was: **A** extract + prove parity at `/opt/pi-web` → **B** propagate to all pi installs →
**C** retire pi-web deployments (archive codebase stays at `Projects/Repos/pi-web`).

## 0.0 Goal

pi-obsidian currently needs the pi-web *site* running to work. It doesn't need the site — it
needs pi-web's **API half**. Extract that half into `pi-bridge`, a small daemon that serves the
identical HTTP+SSE contract by driving pi's SDK in-process. Then "add a device" = sync the pi
install (the daemon rides along) + add an instance row in pi-obsidian settings.

## 1.0 Locked constraints

1. **1:1 extraction.** pi-web is known-good. Handler bodies and lib files are copied **verbatim**;
   only the framework seam changes (Next request/response types → a thin adapter). No cleanup,
   no renames, no re-derivations, no "improvements". Divergences are comments only.
2. **Rides the pi sync.** Source lives at `~/.pi/agent/bridge/` inside the `ejumper/pi` repo
   (tracked) — `sync.sh pull` delivers it to the server-global install, the pi-web container's
   `./data/pi-agent-repo`, and any future device. `node_modules/` is gitignored (like
   `agent/npm/node_modules`); first run bootstraps deps.
3. **pi-obsidian zero-change.** The contract is byte-identical (paths, bodies, SSE event shapes).
   Existing instance rows keep working; `api-base.ts` stays as is.
4. **Phase A deploys at `/opt/pi-web`** (the server) and proves parity there. Desktop pi-web
   keeps running untouched through Phase A.

## 2.0 Recon findings (verified 2026-11-17)

- **The seam is tiny**: `pi-web/lib/` (70 files) has **zero `next/` imports** — the SDK coupling
  (`@earendil-works/pi-coding-agent`, `pi-tui`) is already framework-free. Only `app/api/**`
  route handlers touch Next (request/response types). Everything else is lift-and-serve.
- **pi-obsidian's consumed surface** (traced from `src/api/`, `src/state/`, `src/views/`):
  `agent/new`, `agent/[id]` + `agent/[id]/events`, `agent/running/events`, `live/[id]/*`,
  `sessions` + `sessions/[id]/*` (incl. state/context), `attachments`, `files/*`, `models`,
  `home`. Build step 0 pins the exact handler list from call sites.
- **Not carried** (pi-web UI features pi-obsidian never calls): `chat/*`, `auth/*`, `skills/*`,
  `speak/*`, `notepad`, `plugins`, `voice-stack`, `transcribe`, `worktrees`, `browse/*`,
  `file-index`, `local-model`, `models-config`.
- **The sync**: `~/.pi` is the `ejumper/pi` git repo (`sync.sh`; desktop pushes, server-global +
  container pull). Only `agent/` is bind-mounted into the container
  (`./data/pi-agent-repo/agent` → `/home/node/.pi/agent`) — hence the daemon lives under `agent/`.
- **`/opt/pi-web`**: compose service `pi-web` (builds from `/opt/pi-web/src`, bun, user 1000:1000),
  bind-mounts the agent repo + `Jumperpedia`, env-file carries the household knobs
  (`PI_WEB_FILES_ROOT`, `PI_SAFEGUARD_DEFAULT=off`, web-search keys, …), publishes
  `127.0.0.1:30141` (nginx `pi.halfab.net` proxies to it).
- **Deps to match**: pi-web uses `@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` `^1.3.0`.
  Pin the **resolved** versions from pi-web's lockfile to avoid minor-version drift.

## 3.0 Architecture

```
pi-obsidian ──HTTP+SSE──▶ pi-bridge (bun, agent/bridge/server.ts) ──▶ pi SDK in-process
                          routes/: <copied handlers>   lib/: <copied pi-web lib>
```

Layout inside `~/.pi/agent/bridge/` (all tracked except node_modules):

| path | contents |
|---|---|
| `server.ts` | router + SSE plumbing + CORS/header behavior of pi-web's `proxy.ts` middleware |
| `next-shim.ts` | the ONLY adapter: `NextRequest`/`NextResponse`-shaped helpers over fetch-API types |
| `routes/**` | copied `app/api/**` handlers (in-scope only), bodies verbatim |
| `lib/**` | transitive closure of those handlers' imports from `pi-web/lib/`, verbatim |
| `package.json` | deps: `pi-coding-agent`, `pi-ai`, `pi-tui` (pinned) — nothing else unless copied lib needs it |
| `README.md` | what this is, how to run, sync placement, the 1:1 rule |

Runtime: **bun** (same as the pi-web container), TypeScript direct — no bundler, so review
against upstream is trivial (diff = the seam).

## 4.0 Deployment at /opt/pi-web (Phase A)

- New compose service `pi-bridge` **alongside** the running `pi-web` service (nothing is torn
  down in Phase A): same image base, same mounts (agent repo + Jumperpedia), same env file minus
  UI-only vars, command = `bun run /home/node/.pi/agent/bridge/server.ts`.
- Publishes `100.75.135.87:30142` (tailnet, like piper's `:8900`) so the phone/desktop can hit it
  directly for testing without touching nginx or the existing instance rows.
- Both services see the **same agent tree** → the session lists match exactly, ideal for
  side-by-side parity. Constraint: do not attach the same session in both processes at once
  (rpc-manager owns sessions in-process).

## 5.0 Parity checklist (Phase A exit criteria)

Run against the `pi-bridge` instance row with the `pi-web` row as reference:

1. Session list + refresh; machine honesty (per-install sessions).
2. Open session → full transcript incl. thinking blocks and tool cards.
3. Send prompt → SSE stream: deltas, toolcalls, finish; scroll-anchoring behavior.
4. Running markers (the `runningSessionIds`/`liveSessionIds` union) and running-error surfacing.
5. Stop/abort mid-run.
6. Attachment upload (binary POST) lands in the prompt.
7. Panel folder tree (`files/*` listDir) incl. the `[ New session ]` rows.
8. Context-usage bar (`sessions/[id]/context`).
9. New session: cwd chain, provider/model/thinking preselects, `ensure_session`.
10. Voice-mode round trip (record → STT → send → stream → TTS) — the whole Phase-14 chain over
    the bridge.
11. Multi-tab + multi-instance binding.

Exit = checklist green on 30142. Only then does Phase B flip anything over.

## 6.0 Build steps (Phase A order)

0. **Trace** the exact handler list from pi-obsidian call sites → `PLAN/bridge-routes.md`
   (mechanical, checked in).
1. Scaffold `agent/bridge/` in the `ejumper/pi` repo: `package.json` (pinned deps), `server.ts`
   skeleton, `README.md`.
2. Lift `lib/**` verbatim (transitive closure of the handlers).
3. Lift `routes/**` verbatim + `next-shim.ts` (the seam; keep it under ~100 lines).
4. Wire `server.ts`: router, SSE streams, CORS/headers per `proxy.ts`.
5. Local smoke on the desktop (different port, read-only: `/api/sessions`, `/api/models`,
   `/api/home`) — desktop pi-web untouched.
6. Deploy `pi-bridge` service at `/opt/pi-web`; `sync.sh push` from desktop delivers the source.
7. Run the parity checklist (phone + desktop instance rows).
8. Changelog + doc note; Guides edits (bridge README cross-links) for approval as usual.

## 7.0 Risks & mitigations

| risk | mitigation |
|---|---|
| SSE/event shape drift breaks pi-obsidian's state machine | handlers verbatim; compare event streams side by side during checklist #3–5 |
| env-var surface drift (pi-web reads many knobs) | carry the same env file minus UI-only; checklist covers env-driven behaviors |
| dependency minor drift vs pi-web's lockfile | pin resolved versions from `bun.lock` |
| two owners on one agent tree during testing | never attach the same session in both; testing uses distinct sessions |
| copied lib pulls in a pi-web-only helper chain | lift it too (1:1 rule beats minimality); note anything odd in the README |

## 8.0 Out of scope

- **pi-obsidian changes** (none expected).
- **Phase B** (propagation to desktop/server-global/laptop installs) and **Phase C** (retiring the
  desktop systemd unit + server container, archiving the pi-web codebase) — separate plans later.
  Phase C note for then: the archive location the user gave is `~/HalfaCloud/Projects/Repos/pi-web`
  (current path is `~/HalfaCloud/Jumperpedia/Projects/Repos/pi-web` — confirm intent at C time).
