import { App, PluginSettingTab, Setting, type DropdownComponent } from "obsidian";
import type PiPlugin from "./main";

export interface PiSettings {
  /** pi-web site base URL (desktop service or pi-web container). */
  baseUrl: string;
  /** Vault root → server path prefix, for open-file mentions (Phase 2). */
  pathPrefix: string;
  /** Last working directory used for new sessions. */
  lastCwd: string;
  /** "Default Session Path" — home-page analog for new sessions (empty = use the cwd chain). */
  defaultSessionPath: string;
  /** Default model for new sessions (null = pi's own default). */
  defaultModel: { provider: string; modelId: string } | null;
  /** Include open-file @mentions in outgoing prompts. */
  includeMentions: boolean;
}

export const DEFAULT_SETTINGS: PiSettings = {
  baseUrl: "http://localhost:30141",
  pathPrefix: "~/HalfaCloud/Jumperpedia",
  lastCwd: "/home/ejumps",
  defaultSessionPath: "",
  defaultModel: null,
  includeMentions: false,
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
      .setName("Default session path")
      .setDesc("Home-page analog for new sessions. Empty = current session's cwd, then last used, then the vault path prefix")
      .addText((text) =>
        text
          .setPlaceholder("(cwd chain)")
          .setValue(this.plugin.settings.defaultSessionPath)
          .onChange(async (value) => {
            this.plugin.settings.defaultSessionPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Models").setHeading();

    const modelSetting = new Setting(containerEl)
      .setName("Default model")
      .setDesc("Model for new sessions (pi default = the harness's own choice)");
    let modelDropdown: DropdownComponent | null = null;
    modelSetting.addDropdown((dropdown) => {
      modelDropdown = dropdown;
      dropdown.addOption("", "pi default");
      dropdown.onChange(async (value) => {
        if (!value) {
          this.plugin.settings.defaultModel = null;
        } else {
          const [provider, modelId] = value.split("::");
          this.plugin.settings.defaultModel = { provider, modelId };
        }
        await this.plugin.saveSettings();
      });
    });

    // Populate asynchronously once the model list is known.
    void this.plugin.client.getModels().then((models) => {
      if (!modelDropdown) return;
      for (const m of models.modelList ?? []) {
        modelDropdown.addOption(`${m.provider}::${m.id}`, `${m.provider}: ${m.name}`);
      }
      const current = this.plugin.settings.defaultModel;
      modelDropdown.setValue(current ? `${current.provider}::${current.modelId}` : "");
    }).catch(() => {
      modelDropdown?.setDisabled(true);
      modelSetting.setDesc("Model list unavailable — is the pi-web site running?");
    });

    new Setting(containerEl)
      .setName("Provider auth & API keys")
      .setDesc("Managed on the pi-web site's Models panel for now (a later phase ports it here).");
  }
}
