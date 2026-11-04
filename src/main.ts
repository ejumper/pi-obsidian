import { MarkdownView, Menu, Notice, Plugin } from "obsidian";
import { PiClient } from "./api/client";
import { DEFAULT_SETTINGS, PiSettingTab, type PiSettings } from "./settings";
import type { AgentStore } from "./state/agent-store";
import { ChatView, VIEW_TYPE_PI_CHAT } from "./views/ChatView";
import { PanelView, VIEW_TYPE_PI_PANEL } from "./views/PanelView";
import { SpikeView, VIEW_TYPE_PI_SPIKE } from "./views/SpikeView";

// Injected at build time (esbuild define) — short git hash.
declare const __BUILD_ID__: string;
export const BUILD_ID: string = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";

// Convention layout (see PLAN/OVERVIEW.md):
//   src/api/     transport (REST client, SSE reader)
//   src/state/   protocol state store (ported useAgentSession logic)
//   src/views/   Obsidian views
//   src/settings.ts  plugin settings tab

export default class PiPlugin extends Plugin {
  settings: PiSettings = DEFAULT_SETTINGS;
  client: PiClient = new PiClient(DEFAULT_SETTINGS.baseUrl);
  private lastChatView: ChatView | null = null;

  async onload(): Promise<void> {
    try {
      await this.loadSettings();
      this.client = new PiClient(this.settings.baseUrl);

    this.registerView(VIEW_TYPE_PI_CHAT, (leaf) => new ChatView(leaf, this));
    this.registerView(VIEW_TYPE_PI_PANEL, (leaf) => new PanelView(leaf, this));
    this.registerView(VIEW_TYPE_PI_SPIKE, (leaf) => new SpikeView(leaf, this));
    this.addSettingTab(new PiSettingTab(this.app, this));

    // Track the most recently active chat view — the panel drives its store.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof ChatView) this.lastChatView = leaf.view;
      })
    );

    this.addCommand({
      id: "open-pi",
      name: "Open pi",
      callback: () => void this.activateChatView(),
    });
    this.addCommand({
      id: "open-pi-panel",
      name: "Open pi panel",
      callback: () => void this.activatePanelView(),
    });
    this.addCommand({
      id: "new-pi-session",
      name: "New session",
      callback: () => void this.withChatView((view) => view.newSession()),
    });
    this.addCommand({
      id: "open-pi-session-picker",
      name: "Open session picker",
      callback: () => void this.withChatView((view) => view.openPicker()),
    });
    this.addCommand({
      id: "pi-abort-run",
      name: "Abort run",
      callback: () => this.withChatView((view) => view.abortRun()),
    });
    this.addCommand({
      id: "pi-compact",
      name: "Compact session",
      callback: () => this.withChatView((view) => view.compactNow()),
    });
    this.addCommand({
      id: "pi-cycle-thinking",
      name: "Cycle thinking level",
      callback: () => this.withChatView((view) => view.cycleThinking()),
    });

    this.addCommand({
      id: "open-spike-view",
      name: "Debug: open spike view",
      callback: () => void this.activateSpikeView(),
    });

    // Validation-matrix probe (Phase-0 row 11): groundwork for open-file mentions.
    this.addCommand({
      id: "debug-open-tabs",
      name: "Debug: log open tabs",
      callback: () => {
        const lines: string[] = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
          const view = leaf.view;
          const file = view instanceof MarkdownView ? view.file : null;
          lines.push(`${view.getViewType()} → ${file?.path ?? "(no file)"}`);
        });
        console.log(`pi-obsidian open tabs:\n${lines.join("\n")}`);
        new Notice("Open tabs logged to console");
      },
    });

    // Ribbon button opens the secondary-actions menu (PLAN/OVERVIEW §3).
    this.addRibbonIcon("message-square", "pi", (ev) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle("Open pi").setIcon("message-square").onClick(() => void this.activateChatView())
      );
      menu.addItem((item) =>
        item.setTitle("Open pi panel").setIcon("panel-right").onClick(() => void this.activatePanelView())
      );
      menu.addItem((item) =>
        item.setTitle("New session").setIcon("plus").onClick(() => void this.withChatView((v) => v.newSession()))
      );
      menu.addItem((item) =>
        item.setTitle("Open session picker").setIcon("search").onClick(() => void this.withChatView((v) => v.openPicker()))
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle("Cycle thinking level").setIcon("brain").onClick(() => this.withChatView((v) => v.cycleThinking()))
      );
      menu.addItem((item) =>
        item.setTitle("Compact session").setIcon("minimize-2").onClick(() => this.withChatView((v) => v.compactNow()))
      );
      menu.addItem((item) =>
        item.setTitle("Abort run").setIcon("square").onClick(() => this.withChatView((v) => v.abortRun()))
      );
      menu.showAtMouseEvent(ev);
    });

    console.log(`pi-obsidian loaded ${this.manifest.version} (${BUILD_ID})`);
    } catch (e) {
      // Never die silently: a load failure would otherwise leave restored
      // workspace leaves blank with no explanation.
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error("pi-obsidian failed to load:", msg);
      new Notice(`pi-obsidian failed to load: ${e instanceof Error ? e.message : String(e)}`, 10000);
    }
  }

  onunload(): void {}

  /** Open the chat view in the main area. */
  async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_PI_CHAT)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_PI_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Open the pi panel in the right sidebar. */
  async activatePanelView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_PI_PANEL)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false)!;
    await leaf.setViewState({ type: VIEW_TYPE_PI_PANEL, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Open a session in the chat view (panel-driven). */
  async openSessionInChat(id: string): Promise<void> {
    await this.withChatView((view) => view.openSessionById(id));
  }

  /** The store of the most recently active chat view, if any. */
  getActiveStore(): AgentStore | null {
    return this.lastChatView?.getStore() ?? null;
  }

  /** Run an action against the chat view, opening it first if needed. */
  async withChatView(action: (view: ChatView) => void): Promise<void> {
    await this.activateChatView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PI_CHAT)[0];
    const view = leaf?.view;
    if (view instanceof ChatView) action(view);
  }

  async activateSpikeView(): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_PI_SPIKE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.client = new PiClient(this.settings.baseUrl);
  }
}
