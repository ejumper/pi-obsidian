// 0.4.1 regression: mid-run session rows must carry .is-running + the spinner.
// Run via: node test/running-marker-check.mjs
import { createRequire, Module } from "node:module";

const stub = await import("./obsidian-stub.mjs");
const origLoad = Module._load;
Module._load = (id, parent, isMain) =>
  id === "obsidian" ? stub : origLoad(id, parent, isMain);
const require = createRequire(import.meta.url);

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const SESSIONS = {
  sessions: [
    { path: "/a", id: "s-running", cwd: "/tmp", created: "2026-11-10T00:00:00Z", modified: "2026-11-10T12:00:00Z", messageCount: 3, firstMessage: "running one" },
    { path: "/b", id: "s-idle", cwd: "/tmp", created: "2026-11-10T00:00:00Z", modified: "2026-11-10T11:00:00Z", messageCount: 1, firstMessage: "idle one" },
  ],
  runningSessionIds: ["s-running"],
  liveSessionIds: [],
};

globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (d) =>
    new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("/api/agent/running/events"))
    return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
  if (u.includes("/api/sessions")) return json(SESSIONS);
  return json({});
};

const bundle = require("../dist/main.js");
const PiPlugin = bundle.default ?? bundle;
const appStub = {
  workspace: {
    on: () => ({}),
    getLeavesOfType: () => [],
    iterateRootLeaves: () => {},
    activeLeaf: null,
    revealLeaf: () => {},
    getRightLeaf: () => ({ app: appStub, updateHeader() {} }),
  },
};
const plugin = new PiPlugin(appStub, { version: "test", id: "pi-obsidian" });
await plugin.onload();

const leaf = { app: appStub, updateHeader() {} };
const panel = plugin.__views["pi-panel"](leaf);
await panel.open();
await new Promise((r) => setTimeout(r, 150)); // let the async refresh land

// walk the panel's DOM for rows
const rows = [];
const walk = (el) => {
  if (el.classes?.has("pi-session-row")) rows.push(el);
  for (const c of el.children ?? []) walk(c);
};
walk(panel.contentEl);

ok(rows.length === 2, `two session rows rendered (${rows.length})`);
const runningRow = rows.find((r) => r.classes.has("is-running"));
const idleRow = rows.find((r) => !r.classes.has("is-running") && !r.classes.has("pi-session-empty"));
ok(!!runningRow, "the running session's row has .is-running");
ok(!!idleRow, "the idle session's row does not");
const spin = [];
const walk2 = (el) => {
  if (el.classes?.has("pi-session-running")) spin.push(el);
  for (const c of el.children ?? []) walk2(c);
};
if (runningRow) walk2(runningRow);
ok(spin.length === 1, `running row carries the spinner span (${spin.length})`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
