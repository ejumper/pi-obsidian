// 0.5.19 regression check — chat-bar title for new sessions (user spec):
// the title shows ONLY the cwd path (no "new session ·" prefix) and long
// paths are cut on the LEFT — the far-right directory is the informative end.
// Drives the REAL built bundle against the stub.
//
// Usage: npm run check           (builds first)
//        node test/title-check.mjs   (uses existing dist/main.js)

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
    getLeaf: () => ({}),
    activeLeaf: null,
    revealLeaf: () => {},
  },
};
const plugin = new PiPlugin(appStub, { version: "test", id: "pi-obsidian" });
await plugin.onload();
plugin.getClient = () => ({
  baseUrl: "http://machine.test",
  getModels: async () => ({ models: {}, modelList: [], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {} }),
});

const makeView = () => plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} });
const tick = () => new Promise((r) => setTimeout(r, 20));
const titleOf = (v) => v.sessionTitleEl.textContent ?? "";

// 1 — short path: shown in full, no "new session" prefix.
{
  const v = makeView();
  await v.open();
  v.prepareNewSession("/home/ejumps/notes");
  ok(titleOf(v) === "/home/ejumps/notes",
    `title is the bare path (got "${titleOf(v)}")`);
  ok(!titleOf(v).includes("new session"), "no 'new session' prefix");
  await v.close();
}

// 2 — long path: cut on the LEFT (tail visible, ellipsis at the head).
{
  const v = makeView();
  await v.open();
  const p = "/home/ejumps/HalfaCloud/Jumperpedia/Guides/Desktop/Programs/Pi-Obsidian";
  v.prepareNewSession(p);
  const t = titleOf(v);
  ok(t.startsWith("…"), `long path is cut at the head (got "${t}")`);
  ok(t.endsWith("/Programs/Pi-Obsidian"), `tail directory is preserved (got "${t}")`);
  ok(t === `…${p.slice(-48)}`, `cut keeps the last 48 chars (got "${t}")`);
  await v.close();
}

// 3 — a named session wins over the path (unchanged behavior).
{
  const v = makeView();
  await v.open();
  v.prepareNewSession("/home/ejumps/notes");
  v.getStore().update({ sessionName: "My Session" });
  await tick();
  ok(titleOf(v) === "My Session", `session name still wins (got "${titleOf(v)}")`);
  await v.close();
}

// 4 — no cwd at all: plain "new session" fallback stays.
{
  const v = makeView();
  await v.open();
  v.prepareNewSession("");
  ok(titleOf(v) === "new session", `empty path falls back (got "${titleOf(v)}")`);
  await v.close();
}

console.log(failures === 0 ? "title-check: all green" : `title-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
