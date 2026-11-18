// 0.5.16 regression check — session list perf: the 50-row render cap with
// scroll-append growth, expansion preserved across refreshes, and the SWR
// poll-until-fresh loop (stale list self-updates when the bridge's background
// scan lands). Drives the REAL built bundle against the stub.
//
// Usage: npm run check                      (builds first)
//        node test/session-list-check.mjs   (uses existing dist/main.js)

import { createRequire, Module } from "node:module";

const stub = await import("./obsidian-stub.mjs");
const origLoad = Module._load;
Module._load = (id, parent, isMain) => (id === "obsidian" ? stub : origLoad(id, parent, isMain));
const require = createRequire(import.meta.url);
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const bundle = require("../dist/main.js");
const PiPlugin = bundle.default ?? bundle;

const appStub = {
  vault: { adapter: { read: async () => { throw new Error("stub: no vault files"); } } },
  workspace: {
    on: () => ({}),
    getLeavesOfType: () => [],
    iterateRootLeaves: () => {},
    activeLeaf: null,
    revealLeaf: () => {},
  },
};
const plugin = new PiPlugin(appStub, { version: "test", id: "pi-obsidian" });
await plugin.onload();

const fakeSessions = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `sess-${String(i).padStart(4, "0")}`,
    path: `/tmp/sess-${i}.jsonl`,
    cwd: "/tmp",
    name: "",
    created: "2026-11-17T00:00:00Z",
    modified: `2026-11-17T${String(23 - (i % 24)).padStart(2, "0")}:00:00Z`,
    messageCount: 3,
    firstMessage: `opening message ${i}`,
  }));

// Controllable bridge stand-in: stale flag + session count flip per scenario.
let respond = { sessions: fakeSessions(130), runningSessionIds: [], liveSessionIds: [], stale: false };
plugin.getClient = () => ({
  baseUrl: "http://machine-a.test", // startRunningStream builds its SSE URL from this
  listSessionsMeta: async () => respond,
  getSession: async () => { throw { status: 404 }; },
});

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const panel = plugin.__views["pi-panel"]({ app: appStub, updateHeader() {} });
await panel.open();
const list = panel.list;
const rowCount = () => list.rows.size;
const hasSentinel = () => list.moreSentinel !== null;

// 1 — cap: 130 sessions paint 50 rows + the sentinel.
respond = { sessions: fakeSessions(130), runningSessionIds: [], liveSessionIds: [], stale: false };
await panel.refresh();
ok(rowCount() === 50, `render cap: 130 sessions paint 50 rows (got ${rowCount()})`);
ok(hasSentinel(), "sentinel present while older sessions exist");

// 2 — growth: each showMore appends 50, exhaustion stops cleanly.
list.showMore();
ok(rowCount() === 100, `showMore appends 50 (got ${rowCount()})`);
list.showMore();
ok(rowCount() === 130 && !hasSentinel(), "exhausted list drops the sentinel (130 rows)");
list.showMore();
ok(rowCount() === 130, "showMore past exhaustion is a no-op");

// 3 — SWR loop: stale refresh paints instantly + schedules the poll; fresh
// poll lands the update and clears the timer.
respond = { sessions: fakeSessions(140), runningSessionIds: [], liveSessionIds: [], stale: true };
stub.Notice.messages.length = 0;
await panel.refresh();
ok(rowCount() === 130, `stale refresh keeps the expanded view (got ${rowCount()}, want 130)`);
ok(panel.sessionsPollTimer !== null, "stale list schedules the poll-until-fresh");
respond = { sessions: fakeSessions(140), runningSessionIds: [], liveSessionIds: [], stale: false };
await tick(2300); // first poll fires at 2s
ok(panel.sessionsPollTimer === null, "fresh poll clears the timer (loop stops)");
ok(panel.sessionsSnapshot.length === 140, "poll landed the refreshed list");
ok(stub.Notice.messages.length === 0, "SWR follow-ups stay quiet (no notice flash)");

// 4 — machine switch mid-poll: the timer must not cross machines.
respond = { sessions: fakeSessions(140), runningSessionIds: [], liveSessionIds: [], stale: true };
await panel.refresh();
ok(panel.sessionsPollTimer !== null, "stale again — poll scheduled");
panel.focusedInstanceId = () => "other-machine";
await tick(2300);
ok(panel.sessionsPollTimer === null, "poll aborts when the focused machine changed");

// 5 — small list: no cap, no sentinel.
respond = { sessions: fakeSessions(10), runningSessionIds: [], liveSessionIds: [], stale: false };
await panel.refresh();
ok(rowCount() === 10 && !hasSentinel(), "small lists render fully (no cap artifacts)");

await panel.close();
console.log(failures === 0 ? "session-list-check: all green" : `session-list-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
