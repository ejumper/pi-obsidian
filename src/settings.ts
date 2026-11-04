import { App, PluginSettingTab, Setting } from "obsidian";
import type PiPlugin from "./main";

export interface PiSettings {
  /** pi-web site base URL (desktop service or pi-web container). */
  baseUrl: string;
  /** Vault root → server path prefix, for open-file mentions (Phase 2). */
  pathPrefix: string;
  /** Where the pi view opens: main area tab or right sidebar. */
  placement: "main" | "sidebar";
  /** Last working directory used for new sessions. */
  lastCwd: string;
}

export const DEFAULT_SETTINGS: PiSettings = {
  baseUrl: "http://localhost:30141",
  pathPrefix: "~/HalfaCloud/Jumperpedia",
  placement: "main",
  lastCwd: "/home/ejumps",
};

export class PiSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: PiPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("The pi-web site this plugin talks to (e.g. http://localhost:30141 or https://pi-desktop.halfab.net)")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:30141")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Vault path prefix")
      .setDesc("Server-side path that corresponds to the vault root (used for open-file mentions)")
      .addText((text) =>
        text
          .setPlaceholder("~/HalfaCloud/Jumperpedia")
          .setValue(this.plugin.settings.pathPrefix)
          .onChange(async (value) => {
            this.plugin.settings.pathPrefix = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Open pi in")
      .setDesc("Where the pi chat view opens")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("main", "Main area (tab)")
          .addOption("sidebar", "Right sidebar")
          .setValue(this.plugin.settings.placement)
          .onChange(async (value) => {
            this.plugin.settings.placement = value === "sidebar" ? "sidebar" : "main";
            await this.plugin.saveSettings();
          })
      );
  }
}
