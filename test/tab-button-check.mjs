// 0.5.17 regression check — tab-button face toggle (Show tab count): the
// composer button's FACE (open-tab count vs icon) is its own setting,
// independent of the tap action (tab overview / ribbon item). Spec: on = the
// number of open tabs in EITHER mode; off = the square icon in tabs mode,
// the ribbon item's icon in ribbon mode. Labels always describe the action.
// Drives the REAL built bundle against the stub.
//
// Usage: npm run check              (builds first)
//        node test/tab-button-check.mjs   (uses existing dist/main.js)

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

// The tab button is built only on mobile (ChatView:510) — the phone IS the
// target device for this face toggle.
stub.Platform.isMobile = true;

// Three root leaves → the count face must read "3".
const appStub = {
  vault: { adapter: { read: async () => { throw new Error("stub: no vault files"); } } },
  workspace: {
    on: () => ({}),
    getLeavesOfType: () => [],
    iterateRootLeaves: (cb) => { for (let i = 0; i < 3; i++) cb({}); },
    activeLeaf: null,
    revealLeaf: () => {},
  },
};
const plugin = new PiPlugin(appStub, { version: "test", id: "pi-obsidian" });
await plugin.onload();
plugin.getClient = () => ({ baseUrl: "http://machine.test" });

const makeView = () => plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} });
const face = (v) => v.tabCountEl;
const s = plugin.settings;

// 1 — default: count face in tab-overview mode (existing behavior preserved).
{
  const v = makeView();
  await v.open();
  s.tabButtonAction = "tabs";
  s.tabButtonShowCount = true;
  v.updateTabCount();
  ok(face(v).getText() === "3", `count face shows open-tab count (got "${face(v).getText()}")`);
  ok(v.tabBtnEl.getAttribute("aria-label") === "Tabs", "tabs mode labels the action (Tabs)");
  await v.close();
}

// 2 — off + tab overview: the square icon, no number.
{
  const v = makeView();
  await v.open();
  s.tabButtonAction = "tabs";
  s.tabButtonShowCount = false;
  v.updateTabCount();
  ok(face(v).attrs["data-icon"] === "square", `off + tabs shows the square icon (got ${face(v).attrs["data-icon"]})`);
  ok(face(v).getText() === "", "icon face carries no number");
  await v.close();
}

// 3 — on + ribbon item: the number wins even in ribbon mode (user spec).
{
  const v = makeView();
  await v.open();
  s.tabButtonAction = "ribbon";
  s.tabButtonRibbonItem = "Quick Access";
  s.tabButtonShowCount = true;
  v.updateTabCount();
  ok(face(v).getText() === "3", `on + ribbon shows the tab count (got "${face(v).getText()}")`);
  ok(v.tabBtnEl.getAttribute("aria-label") === "Ribbon item", "label still describes the action (ribbon item fallback with no ribbon DOM)");
  await v.close();
}

// 4 — off + ribbon item: mirrored icon (fallback zap with no ribbon items in stub).
{
  const v = makeView();
  await v.open();
  s.tabButtonAction = "ribbon";
  s.tabButtonShowCount = false;
  v.updateTabCount();
  ok(face(v).attrs["data-icon"] === "zap", `off + ribbon mirrors the ribbon icon (got ${face(v).attrs["data-icon"]})`);
  ok(face(v).getText() === "", "ribbon icon face carries no number");
  await v.close();
}

// 5 — settings flip reaches ALL open chat views (twin tabs), not just active.
{
  const a = makeView();
  const b = makeView();
  await a.open();
  await b.open();
  appStub.workspace.getLeavesOfType = () => [a, b].map((view) => ({ view }));
  s.tabButtonAction = "tabs";
  s.tabButtonShowCount = true;
  a.updateTabCount();
  b.updateTabCount();
  s.tabButtonShowCount = false;
  plugin.refreshTabButtons();
  ok(face(a).attrs["data-icon"] === "square" && face(b).attrs["data-icon"] === "square",
    "one settings flip updates every open chat view");
  await a.close();
  await b.close();
}

console.log(failures === 0 ? "tab-button-check: all green" : `tab-button-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
