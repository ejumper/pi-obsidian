import { MarkdownView, Notice, Plugin } from "obsidian";
import { PiClient } from "./api/client";
import { DEFAULT_SETTINGS, PiSettingTab, type PiSettings } from "./settings";
import { SpikeView, VIEW_TYPE_PI_SPIKE } from "./views/SpikeView";

// Convention layout (see PLAN/OVERVIEW.md):
//   src/api/     transport (REST client, SSE reader)
//   src/state/   protocol state store (ported useAgentSession logic) — Phase 1
//   src/views/   Obsidian views
//   src/settings.ts  plugin settings tab

export default class PiPlugin extends Plugin {
  settings: PiSettings = DEFAULT_SETTINGS;
  client: PiClient = new PiClient(DEFAULT_SETTINGS.baseUrl);

  async onload(): Promise<void> {
    await this.loadSettings();
    this.client = new PiClient(this.settings.baseUrl);

    this.registerView(VIEW_TYPE_PI_SPIKE, (leaf) => new SpikeView(leaf, this));
    this.addSettingTab(new PiSettingTab(this.app, this));

    this.addCommand({
      id: "open-spike",
      name: "Open spike view",
      callback: () => void this.activateSpikeView(),
    });

    // Validation-matrix probe (row 11): groundwork for open-file mentions.
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

    this.addRibbonIcon("message-square", "Open pi spike view", () => void this.activateSpikeView());

    console.log("pi-obsidian loaded", this.manifest.version);
  }

  onunload(): void {}

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
