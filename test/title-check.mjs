// 0.5.19/0.5.20 regression check — chat-bar title for new sessions (user
// spec): the title shows ONLY the cwd path (no "new session ·" prefix) and the
// path is truncated to the TAIL — the far-right directory must stay visible.
// Truncation itself is CSS's (.pi-title-path — left-ellipsis at any bar width;
// 0.5.19's char cap couldn't know the width and got right-clipped again), so
// the contract asserted here is: full path in the text (LRM-wrapped), the
// path class on, and the CSS rule present in styles.css.
// Drives the REAL built bundle against the stub.
//
// Usage: npm run check           (builds first)
//        node test/title-check.mjs   (uses existing dist/main.js)

import { createRequire, Module } from "node:module";
import { readFileSync } from "node:fs";

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
const isPathTitle = (v) => v.sessionTitleEl.classes.has("pi-title-path");

// 1 — short path: shown in full, no "new session" prefix, path class on.
{
  const v = makeView();
  await v.open();
  v.prepareNewSession("/home/ejumps/notes");
  ok(titleOf(v).includes("/home/ejumps/notes"),
    `title carries the bare path (got "${titleOf(v)}")`);
  ok(!titleOf(v).includes("new session"), "no 'new session' prefix");
  ok(isPathTitle(v), "path title gets the left-ellipsis class");
  await v.close();
}

// 2 — long path: kept whole in the text (CSS truncates to the tail visually)
// and wrapped in LRMs so trailing punctuation can't bidi-flip.
{
  const v = makeView();
  await v.open();
  const p = "/home/ejumps/HalfaCloud/Jumperpedia/Guides/Desktop/Programs/Pi-Obsidian";
  v.prepareNewSession(p);
  ok(titleOf(v).includes(p), `path is not JS-cut (got "${titleOf(v)}")`);
  ok(titleOf(v).startsWith("\u200e") && titleOf(v).endsWith("\u200e"),
    "path is LRM-pinned against bidi flips");
  ok(isPathTitle(v), "long path keeps the left-ellipsis class");
  await v.close();
}

// 3 — the CSS rule carrying the tail-first truncation exists.
{
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  ok(/pi-title-path[^}]*direction:\s*rtl/.test(css), "styles.css has the left-ellipsis rule (direction: rtl)");
  ok(/pi-title-path[^}]*text-align:\s*left/.test(css), "the rule keeps the title left-anchored");
}

// 4 — a named session wins over the path (unchanged behavior, no path class).
{
  const v = makeView();
  await v.open();
  v.prepareNewSession("/home/ejumps/notes");
  v.getStore().update({ sessionName: "My Session" });
  await tick();
  ok(titleOf(v) === "My Session", `session name still wins (got "${titleOf(v)}")`);
  ok(!isPathTitle(v), "names do not get the left-ellipsis class");
  await v.close();
}

// 5 — no cwd at all: plain "new session" fallback stays.
{
  const v = makeView();
  await v.open();
  v.prepareNewSession("");
  ok(titleOf(v) === "new session", `empty path falls back (got "${titleOf(v)}")`);
  await v.close();
}

console.log(failures === 0 ? "title-check: all green" : `title-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
