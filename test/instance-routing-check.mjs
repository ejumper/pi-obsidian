// Phase 13 regression: per-tab instance routing. Two views bound to different
// machines must send their requests to their own base URLs, and a machine
// switch must reset the tab to no-session. Uses dist/main.js + the obsidian
// stub with fetch mocked per base URL.
// Run via: npm run check (or node test/instance-routing-check.mjs)
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

const BASE_A = "http://machine-a.test";
const BASE_B = "http://machine-b.test";
const hits = []; // [base, path]

globalThis.fetch = async (url) => {
  const u = String(url);
  const base = u.startsWith(BASE_A) ? BASE_A : u.startsWith(BASE_B) ? BASE_B : "?";
  const path = u.slice(base.length);
  hits.push([base, path]);
  const json = (d) =>
    new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
  if (path.endsWith("/events"))
    return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
  if (path.startsWith("/api/agent/"))
    return json({ running: false });
  if (path.startsWith("/api/sessions/"))
    return json({
      sessionId: "s1",
      filePath: "/tmp/s1.jsonl",
      info: { name: "t", cwd: "/tmp", firstMessage: "x" },
      leafId: "l1",
      tree: [],
      live: false,
      context: { messages: [], entryIds: [], model: null },
    });
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
  },
};
const plugin = new PiPlugin(appStub, { version: "test", id: "pi-obsidian" });
await plugin.onload();

// two configured machines
plugin.settings.instances = [
  { id: "a", name: "Machine A", baseUrl: BASE_A },
  { id: "b", name: "Machine B", baseUrl: BASE_B },
];

const mkView = async (instanceId) => {
  const leaf = { app: appStub, updateHeader() {} };
  const view = plugin.__views["pi-chat"](leaf);
  await view.setState({ instanceId });
  await view.open();
  return view;
};

const v1 = await mkView("a");
const v2 = await mkView("b");
ok(v1.getInstanceId() === "a" && v2.getInstanceId() === "b", "views bound to their instances");

hits.length = 0;
await v1.getStore().openSession("s1");
await v2.getStore().openSession("s1");
const aHits = hits.filter(([b]) => b === BASE_A).map(([, p]) => p);
const bHits = hits.filter(([b]) => b === BASE_B).map(([, p]) => p);
ok(aHits.length > 0 && aHits.every((p) => !p.includes("/api/sessions/s1") || true) && aHits.some((p) => p.includes("/api/sessions/s1")),
  `view A's requests hit machine A (${JSON.stringify(aHits)})`);
ok(bHits.some((p) => p.includes("/api/sessions/s1")),
  `view B's requests hit machine B (${JSON.stringify(bHits)})`);
ok(hits.every(([b]) => b !== "?"), "no request escaped the configured bases");

// machine switch: tab resets and routes to the new base
hits.length = 0;
v1.setInstance("b");
ok(v1.getStore().state.sessionId === null, "machine switch resets the tab to no-session");
ok(v1.getInstanceId() === "b", "machine switch rebinds the tab");
await v1.getStore().openSession("s1");
ok(hits.every(([b]) => b === BASE_B), `after the switch, requests go to machine B (${JSON.stringify(hits)})`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
