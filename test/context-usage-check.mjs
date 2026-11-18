// Context-size regressions — the bar must show the TUI's context size for the
// open session at ALL times (0.5.17): from the session-detail estimate at open
// (cold sessions — was: empty until the first run), from runtime state once a
// run reports it, and the top-right slot carries NOTHING but the size (the
// status text ("running" etc.) was removed — the composer and transcript tail
// own that communication). Drives the REAL built bundle against the stub.
//
// Usage: npm run check                  (builds first)
//        node test/context-usage-check.mjs   (uses existing dist/main.js)

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

// Mutable wire mocks — flipped per scenario.
let AGENT_STATE = {
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
let SESSION = {
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

const tick = () => new Promise((r) => setTimeout(r, 20));
const openView = async () => {
  const view = plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} });
  await view.open();
  return view;
};

// 1 — runtime state populates the bar (post-run truth).
{
  const view = await openView();
  await view.store.openSession("s1");
  await tick();
  ok(
    view.store.state.contextUsage?.contextWindow === 1000000,
    `store.state.contextUsage populated (got ${JSON.stringify(view.store.state.contextUsage)})`
  );
  const sizeEl = view.barSizeEl;
  ok(sizeEl?.textContent?.includes("/1.0M"), `bar renders context size (got "${sizeEl?.textContent}")`);
  ok(
    sizeEl?.textContent?.includes("0%") || sizeEl?.textContent?.includes("1%"),
    `bar renders percent (got "${sizeEl?.textContent}")`
  );
  await view.close();
}

// 2 — COLD open (no runtime at all): the session-detail estimate fills the bar
// immediately — the TUI parity case ("shown as soon as the session opens").
{
  AGENT_STATE = { running: false };
  SESSION = {
    ...SESSION,
    contextUsage: { percent: 5, contextWindow: 1000000, tokens: 50123 },
  };
  const view = await openView();
  await view.store.openSession("s1");
  await tick();
  const sizeEl = view.barSizeEl;
  ok(
    sizeEl?.textContent?.includes("50k/1.0M"),
    `cold open shows the detail-estimated size (got "${sizeEl?.textContent}")`
  );
  ok(sizeEl?.textContent?.includes("5%"), `cold open shows the percent (got "${sizeEl?.textContent}")`);
  await view.close();
}

// 3 — just-compacted (tokens unknown, window known): "?" parity like the TUI.
{
  SESSION = {
    ...SESSION,
    contextUsage: { percent: null, contextWindow: 1000000, tokens: null },
  };
  const view = await openView();
  await view.store.openSession("s1");
  await tick();
  const sizeEl = view.barSizeEl;
  ok(
    sizeEl?.textContent?.includes("?/1.0M"),
    `post-compaction shows the TUI's ? (got "${sizeEl?.textContent}")`
  );
  await view.close();
}

// 4 — the top-right slot is context-size ONLY: no status element, and no
// "running"/"loading" text may leak into the bar (0.5.17 user spec).
{
  AGENT_STATE = {
    running: true,
    state: {
      sessionId: "s1",
      isStreaming: true,
      isPromptRunning: true,
      isCompacting: true,
      contextUsage: { percent: 3, contextWindow: 1000000, tokens: 30000 },
      queuedMessages: null,
    },
  };
  const view = await openView();
  await view.store.openSession("s1");
  await tick();
  ok(view.barStatusEl === undefined, "the status slot no longer exists");
  // FakeElement.textContent does not aggregate children (real DOM does) —
  // walk the bar's children to read what actually displays.
  const bar = view.contentEl.children[0];
  const texts = [];
  const walk = (el) => {
    if (el.textContent) texts.push(el.textContent);
    for (const c of el.children ?? []) walk(c);
  };
  walk(bar);
  const barText = texts.join(" | ");
  ok(
    !barText.includes("running") && !barText.includes("loading") && !barText.includes("compacting"),
    `bar carries only the context size (got "${barText}")`
  );
  ok(barText.includes("30k/1.0M"), `bar still renders the size under load (got "${barText}")`);
  await view.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
