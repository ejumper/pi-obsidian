// Minimal Obsidian API stub for the headless check (test/headless-check.mjs).
// Mirrors the real behaviors the plugin depends on — including the base-class
// `titleEl` pattern that caused the blank-view bug (View.load() calls
// titleEl.setText(getDisplayText())), so class-field clobbering regressions
// reproduce here instead of on a device.

export class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.style = {
      display: "",
      setProperty() {},
      removeProperty() {},
    };
    this.classes = new Set();
    this.attrs = {};
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 500;
    this.offsetHeight = 90;
    this.value = "";
    this.disabled = false;
    this.listeners = {};
    this.classList = {
      toggle: (c, on) => { if (on) this.classes.add(c); else this.classes.delete(c); },
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
    };
  }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  removeEventListener() {}
  empty() { this.children = []; }
  addClass(...cs) { cs.forEach((c) => this.classes.add(c)); }
  removeClass(...cs) { cs.forEach((c) => this.classes.delete(c)); }
  setAttr(k, v) { this.attrs[k] = v; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setText(v) { this.textContent = String(v); }
  getText() { return this.textContent; }
  isShown() { return true; }
  createEl(tag, o = {}) {
    const el = new FakeElement(tag);
    if (typeof o === "string") el.textContent = o;
    else {
      if (o.cls) (Array.isArray(o.cls) ? o.cls : [o.cls]).forEach((c) => el.classes.add(c));
      if (o.text !== undefined) el.textContent = o.text;
      if (o.type) el.attrs.type = o.type;
      if (o.value !== undefined) el.value = o.value;
      if (o.placeholder) el.attrs.placeholder = o.placeholder;
      if (o.attr) Object.assign(el.attrs, o.attr);
    }
    this.children.push(el);
    return el;
  }
  createDiv(o = {}) { return this.createEl("div", o); }
  createSpan(o = {}) { return this.createEl("span", o); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  remove() {}
  focus() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

// ---------- globals ----------
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  visibilityState: "visible",
  documentElement: new FakeElement("html"),
  body: new FakeElement("body"),
  createElement: (tag) => {
    const el = new FakeElement(tag);
    el.type = "";
    el.multiple = false;
    el.accept = "";
    el.files = null;
    el.click = () => {};
    return el;
  },
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "", paddingBottom: "0px", marginBottom: "0px" });
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
for (const tag of ["div", "span", "p", "pre", "button", "input", "textarea", "ul", "li"]) {
  globalThis[`create${tag[0].toUpperCase()}${tag.slice(1)}`] ??= (o) => {
    const el = new FakeElement(tag);
    if (typeof o === "string") el.textContent = o;
    else if (o) {
      if (o.cls) (Array.isArray(o.cls) ? o.cls : [o.cls]).forEach((c) => el.classes.add(c));
      if (o.text !== undefined) el.textContent = o.text;
      if (o.attr) Object.assign(el.attrs, o.attr);
    }
    return el;
  };
}
globalThis.createDiv = globalThis.createDiv ?? ((o) => globalThis.createDivImpl(o));
globalThis.createDivImpl = (o) => {
  const el = new FakeElement("div");
  if (typeof o === "string") el.textContent = o;
  else if (o) {
    if (o.cls) (Array.isArray(o.cls) ? o.cls : [o.cls]).forEach((c) => el.classes.add(c));
    if (o.text !== undefined) el.textContent = o.text;
    if (o.attr) Object.assign(el.attrs, o.attr);
  }
  return el;
};
globalThis.DOMException = globalThis.DOMException ?? class DOMException extends Error {
  constructor(msg, name) { super(msg); this.name = name ?? "Error"; }
};

// ---------- obsidian module ----------
export class Component {
  load() {
    this._loaded = true;
    if (this.onLoad) this.onLoad();
    // Mirrors Obsidian View.load(): unguarded base titleEl use.
    const { titleEl: i } = this;
    i.setText(this.getDisplayText ? this.getDisplayText() : "");
  }
  unload() { this._loaded = false; if (this.onUnload) this.onUnload(); }
  addChild() {}
  register() {}
  registerEvent() {}
}
export class View extends Component {
  constructor(leaf) {
    super();
    this.titleEl = new FakeElement(); // base-class-initialized — the blank-view trap
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = new FakeElement();
    this.contentEl = new FakeElement();
  }
  getViewType() { return ""; }
  getDisplayText() { return ""; }
  getIcon() { return ""; }
  async open() { this.load(); await this.onOpen(); }
  async close() { await this.onClose(); this.unload(); }
}
export class ItemView extends View {}
export class Modal extends Component {
  constructor(app) { super(); this.app = app; this.contentEl = new FakeElement(); }
  setTitle() {}
  open() { this.load(); if (this.onOpen) this.onOpen(); }
  close() { if (this.onClose) this.onClose(); this.unload(); }
}
export class SuggestModal extends Modal {
  setPlaceholder() {}
  getSuggestions() { return []; }
  renderSuggestion() {}
  onChooseSuggestion() {}
}
export class Plugin extends Component {
  constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this.__views = {}; }
  registerView(type, creator) { this.__views[type] = creator; }
  addCommand() {}
  addRibbonIcon() {}
  addSettingTab() {}
  async loadData() { return null; }
  async saveData() {}
}
export class Menu { addItem() { return this; } addSeparator() { return this; } showAtMouseEvent() {} }
export class Notice { constructor() {} }
export class Setting {
  setName() { return this; } setDesc() { return this; } setHeading() { return this; }
  addText() { return this; } addDropdown() { return this; } addToggle() { return this; }
}
export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new FakeElement(); } display() {} }
export class MarkdownView extends View {}
export class FileView extends View {}
export class TFile {}
export const Platform = { isMobile: false, isDesktopApp: true, isIosApp: false, isAndroidApp: false };
export const MarkdownRenderer = { render: async () => {} };
export function setIcon(el, name) { if (el) el.attrs["data-icon"] = name; }
export class App {}
