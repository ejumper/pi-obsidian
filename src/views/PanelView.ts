// The pi panel: right-sidebar control center (session picker + controls +
// settings shortcuts). Per PLAN/PHASES/PHASE-3.md. Mobile and desktop layouts
// mirror Obsidian's own sidebar conventions via CSS `order` (see styles.css).

import { ItemView, Menu, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { SessionList } from "./panel/SessionList";
import type PiPlugin from "../main";

export const VIEW_TYPE_PI_PANEL = "pi-panel";

type PanelMode = "recent" | "folders";

export class PanelView extends ItemView {
  private list!: SessionList;
  private toggleRecentEl!: HTMLButtonElement;
  private toggleFoldersEl!: HTMLButtonElement;
  private foldersEl!: HTMLElement;
  private mainEl!: HTMLElement;
  private mode: PanelMode = "recent";

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PiPlugin
  ) {
    super(leaf);
    // Keep construction trivial — throws here produce a silently blank leaf.
  }

  getViewType(): string {
    return VIEW_TYPE_PI_PANEL;
  }

  getDisplayText(): string {
    return "pi";
  }

  getIcon(): string {
    return "panel-right";
  }

  async onOpen(): Promise<void> {
    try {
      this.buildDom();
      await this.refresh();
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error("pi-obsidian panel error:", msg);
      this.contentEl.empty();
      this.contentEl.createEl("pre", { cls: "pi-error-panel" }).setText(
        `pi panel failed to render:\n\n${msg}`
      );
    }
  }

  async onClose(): Promise<void> {}

  // ---------- DOM ----------

  private buildDom(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("pi-panel");
    root.addClass(Platform.isMobile ? "pi-panel--mobile" : "pi-panel--desktop");

    // Settings shortcuts (pinned: top on mobile, bottom on desktop).
    const settings = root.createDiv({ cls: "pi-panel-settings" });
    const modelsBtn = this.panelButton(settings, "cpu", "Models settings");
    modelsBtn.addEventListener("click", () => this.openPluginSettings());
    const skillsBtn = this.panelButton(settings, "book-open", "Skills settings (coming soon)");
    skillsBtn.disabled = true;
    const pluginsBtn = this.panelButton(settings, "blocks", "Plugins settings (coming soon)");
    pluginsBtn.disabled = true;

    // Recent | Folders toggle.
    const toggle = root.createDiv({ cls: "pi-panel-toggle" });
    this.toggleRecentEl = toggle.createEl("button", {
      cls: "pi-panel-toggle-btn is-active",
      text: "Recent",
    });
    this.toggleFoldersEl = toggle.createEl("button", {
      cls: "pi-panel-toggle-btn",
      text: "Folders",
    });
    this.toggleRecentEl.addEventListener("click", () => this.setMode("recent"));
    this.toggleFoldersEl.addEventListener("click", () => this.setMode("folders"));

    // Session area.
    this.mainEl = root.createDiv({ cls: "pi-panel-main" });
    this.list = new SessionList({
      onOpen: (id) => void this.plugin.openSessionInChat(id),
    });
    this.mainEl.appendChild(this.list.el);
    this.foldersEl = this.mainEl.createDiv({
      cls: "pi-panel-folders",
      text: "Folders view lands in Phase 4",
    });
    this.foldersEl.style.display = "none";

    // Controls row.
    const controls = root.createDiv({ cls: "pi-panel-controls" });
    const newBtn = this.panelButton(controls, "plus", "New session");
    newBtn.addEventListener("click", () => void this.plugin.withChatView((v) => v.newSession()));
    // Temporary plain button — replaced by the pill-selector in T19.
    const thinkBtn = this.panelButton(controls, "brain", "Thinking level");
    thinkBtn.addEventListener("click", (ev) => void this.openThinkingMenu(ev));
    const compactBtn = this.panelButton(controls, "minimize-2", "Compact session");
    compactBtn.addEventListener("click", () => {
      const store = this.plugin.getActiveStore();
      if (!store) {
        new Notice("pi: open a session first");
        return;
      }
      void store.compact();
    });
  }

  private panelButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const btn = parent.createEl("button", {
      cls: "pi-panel-btn",
      attr: { "aria-label": label, title: label },
    });
    setIcon(btn, icon);
    return btn;
  }

  private setMode(mode: PanelMode): void {
    this.mode = mode;
    this.toggleRecentEl.classList.toggle("is-active", mode === "recent");
    this.toggleFoldersEl.classList.toggle("is-active", mode === "folders");
    const recent = mode === "recent";
    this.list.el.style.display = recent ? "" : "none";
    this.foldersEl.style.display = recent ? "none" : "";
    if (recent) void this.refresh();
  }

  // ---------- data ----------

  async refresh(): Promise<void> {
    this.list.setLoading();
    try {
      const res = await this.plugin.client.listSessions();
      const sessions = [...res.sessions].sort((a, b) =>
        b.modified.localeCompare(a.modified)
      );
      this.list.setSessions(sessions, res.runningSessionIds);
    } catch (e) {
      this.list.setSessions([], []);
      new Notice(`pi: ${String(e)}`);
    }
  }

  private async openThinkingMenu(ev: MouseEvent): Promise<void> {
    const store = this.plugin.getActiveStore();
    if (!store) {
      new Notice("pi: open a session first");
      return;
    }
    const levels = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    const menu = new Menu();
    for (const level of levels) {
      menu.addItem((item) =>
        item
          .setTitle(`thinking: ${level}`)
          .setChecked(store.state.thinkingLevel === level)
          .onClick(() => void store.setThinkingLevel(level))
      );
    }
    menu.showAtMouseEvent(ev);
  }

  private openPluginSettings(): void {
    // Not in the public API surface, but stable across versions.
    const setting = (this.app as unknown as {
      setting: { open(): void; openTabById(id: string): void };
    }).setting;
    setting.open();
    setting.openTabById(this.plugin.manifest.id);
  }
}
