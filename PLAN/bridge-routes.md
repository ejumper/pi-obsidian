# bridge-routes — the exact pi-bridge handler scope (PHASE-15 step 0)

Traced 2026-11-17 from pi-obsidian call sites (`src/api/client.ts`, `src/api/sse.ts`,
`src/state/agent-store.ts`, `src/views/PanelView.ts`). These 12 pi-web handler files cover every
request the plugin makes. They are lifted **verbatim**; everything else in `app/api/` is
pi-web-UI surface and is NOT carried.

| # | Request | pi-web handler | Used for |
|---|---|---|---|
| 1 | GET `/api/sessions` | `app/api/sessions/route.ts` | session list incl. `runningSessionIds`/`liveSessionIds` |
| 2 | GET `/api/sessions/:id?deferThinking=1&deferMedia=1` | `app/api/sessions/[id]/route.ts` | transcript load |
| 3 | GET `/api/sessions/:id/context?leafId=` | `app/api/sessions/[id]/context/route.ts` | one tree leaf's messages |
| 4 | PATCH `/api/sessions/:id` `{name}` | `app/api/sessions/[id]/route.ts` | rename |
| 5 | DELETE `/api/sessions/:id` | `app/api/sessions/[id]/route.ts` | delete |
| 6 | GET `/api/models?cwd=` | `app/api/models/route.ts` | model picker |
| 7 | POST `/api/attachments` (multipart) | `app/api/attachments/route.ts` | uploads → server-side path |
| 8 | GET `/api/home` | `app/api/home/route.ts` | home dir + defaults |
| 9 | GET `/api/files/<path>?type=list` | `app/api/files/[...path]/route.ts` | panel folder tree (listDir) |
| 10 | POST `/api/agent/new` | `app/api/agent/new/route.ts` | create + first prompt |
| 11 | GET `/api/agent/:id` | `app/api/agent/[id]/route.ts` | `{running, state}` snapshot |
| 12 | POST `/api/agent/:id` (envelope) | `app/api/agent/[id]/route.ts` | prompt / abort / set_model / … |
| 13 | GET `/api/agent/:id/events` **SSE** | `app/api/agent/[id]/events/route.ts` | session stream |
| 14 | GET `/api/live/:id/events` **SSE** | `app/api/live/[id]/events/route.ts` | live-session stream |
| 15 | GET `/api/agent/running/events` **SSE** | `app/api/agent/running/events/route.ts` | running-markers feed |

Notes:
- Abort is NOT a DELETE: the store posts the `{type: "abort"}` envelope to `/api/agent/:id`.
- `live/` appears only for the events stream; sends still go to `/api/agent/:id`.
- Query-param flags (`deferThinking`, `deferMedia`, `type=list`, `leafId`, `cwd`) are handled by
  the verbatim handlers — no client knowledge needed in the bridge.
