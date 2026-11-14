// T43/#6 regression: end-to-end store+render check with the REAL wire shapes
// captured from pi.halfab.net (2026-11-06 probe): GET /api/agent/{id} returns
// {running, state:{...contextUsage...}} and the bar must render it.
// Run via: node test/context-usage-check.mjs (uses dist/main.js + the stub)
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

// ---- fetch mock with the real payloads ----
const AGENT_STATE = {
  running: true,
  state: {
    sessionId: "s1",
    isStreaming: false,
    isPromptRunning: false,
    isCompacting: false,
    contextUsage: { percent: 0.2682, contextWindow: 1000000, tokens: 2682 },
    queuedMessages: null,
  },
};
const SESSION = {
  sessionId: "s1",
  filePath: "/tmp/s1.jsonl",
  info: { name: "test", cwd: "/tmp", firstMessage: "hello" },
  leafId: "leaf1",
  tree: [],
  live: false,
  context: { messages: [], entryIds: ["e1"], model: null },
};

globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (d) =>
    new Response(JSON.stringify(d), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (u.includes("/api/agent/") && u.endsWith("/events"))
    return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
  if (u.includes("/api/agent/")) return json(AGENT_STATE);
  if (u.includes("/api/sessions/")) return json(SESSION);
  return json({});
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

const leaf = { app: appStub, updateHeader() {} };
const view = plugin.__views["pi-chat"](leaf);
await view.open();

// run the real openSession against the mocked wire
const store = view.store;
await store.openSession("s1");

ok(
  store.state.contextUsage?.contextWindow === 1000000,
  `store.state.contextUsage populated (got ${JSON.stringify(store.state.contextUsage)})`
);
const sizeEl = view.barSizeEl;
ok(
  sizeEl?.textContent?.includes("/1.0M"),
  `bar renders context size (got "${sizeEl?.textContent}")`
);
ok(
  sizeEl?.textContent?.includes("0%") || sizeEl?.textContent?.includes("1%"),
  `bar renders percent (got "${sizeEl?.textContent}")`
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
