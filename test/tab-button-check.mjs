// 0.5.19 regression check — tab-button ACTIONS (user spec): press and
// long-press each trigger a command or a ribbon menu item, configured
// independently. Empty command ids are the built-in defaults (press: tab
// overview, long-press: new tab) resolved against the command registry at run
// time. Plus the face toggle (count vs icon) from 0.5.17.
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

// The tab button is built only on mobile (the phone IS the target device).
stub.Platform.isMobile = true;

// Command registry fixture — records executions.
const executed = [];
const appStub = {
  vault: { adapter: { read: async () => { throw new Error("stub: no vault files"); } } },
  workspace: {
    on: () => ({}),
    getLeavesOfType: () => [],
    iterateRootLeaves: (cb) => { for (let i = 0; i < 3; i++) cb({}); },
    getLeaf: () => ({}),
    activeLeaf: null,
    revealLeaf: () => {},
  },
  commands: {
    listCommands: () => [
      { id: "workspace:show-tab-overview", name: "Show tab overview" },
      { id: "workspace:new-tab", name: "New tab" },
      { id: "editor:focus", name: "Some command" },
    ],
    executeCommandById: (id) => {
      executed.push(id);
      return true;
    },
  },
};

// Ribbon fixture — the ribbon is DOM-only (aria-label identity, click = run).
let ribbonClicks = 0;
globalThis.document.querySelectorAll = (sel) =>
  String(sel).includes("side-dock-ribbon-action")
    ? [{
        getAttribute: (k) => (k === "aria-label" ? "Quick Access" : null),
        click: () => { ribbonClicks++; },
        querySelector: () => null,
      }]
    : [];

const plugin = new PiPlugin(appStub, { version: "test", id: "pi-obsidian" });
await plugin.onload();
plugin.getClient = () => ({
  baseUrl: "http://machine.test",
  getModels: async () => ({ models: {}, modelList: [], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {} }),
});

const makeView = () => plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} });
const face = (v) => v.tabCountEl;
const s = plugin.settings;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (v) =>
  v.tabBtnEl.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {} });
const longPress = async (v) => {
  v.tabBtnEl.dispatchEvent({ type: "pointerdown" });
  await tick(560); // past the 500ms threshold
};

// Reset to the documented defaults before each scenario.
const resetActions = () => {
  s.tabPressKind = "command";
  s.tabPressCommand = "";
  s.tabPressRibbonItem = "";
  s.tabLongPressKind = "command";
  s.tabLongPressCommand = "";
  s.tabLongPressRibbonItem = "";
};

// 1 — default press: the tab-overview command (registry-ranked).
{
  resetActions();
  const v = makeView();
  await v.open();
  executed.length = 0;
  click(v);
  ok(executed[0] === "workspace:show-tab-overview",
    `default press runs the tab-overview command (got ${executed[0]})`);
  await v.close();
}

// 2 — default long-press: the new-tab command; the trailing click is swallowed.
{
  resetActions();
  const v = makeView();
  await v.open();
  executed.length = 0;
  await longPress(v);
  ok(executed[0] === "workspace:new-tab",
    `default long-press runs the new-tab command (got ${executed[0]})`);
  click(v); // the click that follows a long-press
  ok(executed.length === 1, "the post-long-press click does not re-fire the press action");
  await v.close();
}

// 3 — explicit command binding on press.
{
  resetActions();
  s.tabPressCommand = "editor:focus";
  const v = makeView();
  await v.open();
  executed.length = 0;
  click(v);
  ok(executed[0] === "editor:focus", `explicit press command runs (got ${executed[0]})`);
  await v.close();
}

// 4 — ribbon item on press.
{
  resetActions();
  s.tabPressKind = "ribbon";
  s.tabPressRibbonItem = "Quick Access";
  const v = makeView();
  await v.open();
  ribbonClicks = 0;
  click(v);
  ok(ribbonClicks === 1, `ribbon press clicks the ribbon item (got ${ribbonClicks})`);
  await v.close();
}

// 5 — ribbon item on long-press (independent of press).
{
  resetActions();
  s.tabLongPressKind = "ribbon";
  s.tabLongPressRibbonItem = "Quick Access";
  const v = makeView();
  await v.open();
  ribbonClicks = 0;
  executed.length = 0;
  await longPress(v);
  ok(ribbonClicks === 1 && executed.length === 0,
    `ribbon long-press clicks the ribbon item (clicks=${ribbonClicks}, commands=${executed.length})`);
  await v.close();
}

// 6 — vanished ribbon item: a notice, not a silent no-op.
{
  resetActions();
  s.tabPressKind = "ribbon";
  s.tabPressRibbonItem = "Gone item";
  const v = makeView();
  await v.open();
  stub.Notice.messages.length = 0;
  click(v);
  ok(stub.Notice.messages.some((m) => m.includes("ribbon item not found")),
    "missing ribbon item raises the notice");
  await v.close();
}

// 7 — face toggle (0.5.17 semantics kept): count in either mode; off = square
// icon in command mode, mirrored ribbon icon in ribbon mode.
{
  resetActions();
  s.tabButtonShowCount = true;
  const v = makeView();
  await v.open();
  v.updateTabCount();
  ok(face(v).getText() === "3", `count face shows open-tab count (got "${face(v).getText()}")`);
  s.tabButtonShowCount = false;
  v.updateTabCount();
  ok(face(v).attrs["data-icon"] === "square", `off + command press shows the square icon (got ${face(v).attrs["data-icon"]})`);
  s.tabPressKind = "ribbon";
  s.tabPressRibbonItem = "Quick Access";
  v.updateTabCount();
  ok(face(v).getText() === "" || face(v).attrs["data-icon"] === undefined,
    "off + ribbon press mirrors the ribbon icon (no number)");
  await v.close();
}

// 8 — label describes the press action.
{
  resetActions();
  s.tabPressCommand = "editor:focus";
  const v = makeView();
  await v.open();
  v.updateTabCount();
  ok(v.tabBtnEl.getAttribute("aria-label") === "Some command",
    `label follows the press action (got "${v.tabBtnEl.getAttribute("aria-label")}")`);
  await v.close();
}

// 9 — settings flip reaches ALL open chat views (twin tabs), not just active.
{
  resetActions();
  const a = makeView();
  const b = makeView();
  await a.open();
  await b.open();
  appStub.workspace.getLeavesOfType = () => [a, b].map((view) => ({ view }));
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
if (failures !== 0) process.exit(1);

// 10 — settings migration from pre-0.5.19 fields (the phone's actual upgrade
// path): the old press action maps over, long-press gets its default.
{
  const orig = PiPlugin.prototype.loadData;
  PiPlugin.prototype.loadData = async () => ({ tabButtonAction: "ribbon", tabButtonRibbonItem: "Quick Access" });
  const p2 = new PiPlugin(appStub, { version: "test", id: "pi-obsidian" });
  await p2.loadSettings();
  ok(p2.settings.tabPressKind === "ribbon" && p2.settings.tabPressRibbonItem === "Quick Access",
    "legacy ribbon press action migrates");
  ok(p2.settings.tabLongPressKind === "command" && p2.settings.tabLongPressCommand === "",
    "legacy long-press maps to the new-tab default");
  ok(p2.settings.tabButtonAction === undefined, "legacy fields dropped after migration");
  PiPlugin.prototype.loadData = async () => ({ tabButtonAction: "tabs" });
  const p3 = new PiPlugin(appStub, { version: "test", id: "pi-obsidian" });
  await p3.loadSettings();
  PiPlugin.prototype.loadData = orig;
  ok(p3.settings.tabPressKind === "command" && p3.settings.tabPressCommand === "",
    "legacy tabs press action becomes the tab-overview default");
}

console.log(failures === 0 ? "migration checks: all green" : `migration checks: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
