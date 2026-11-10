import { App, PluginSettingTab, Setting, type DropdownComponent } from "obsidian";
import type PiPlugin from "./main";
import type { ThinkingLevelOption } from "./state/agent-store";

const THINKING_LEVELS: { value: ThinkingLevelOption; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
];

/** A named pi-web instance the plugin can talk to (multiple servers). */
export interface PiInstance {
  id: string;
  name: string;
  baseUrl: string;
}

export interface PiSettings {
  /** Named pi-web instances — the first entry is the default. */
  instances: PiInstance[];
  /** @deprecated Single-instance base URL from pre-multi-instance settings;
   *  kept only for migration reads in loadSettings(). */
  baseUrl?: string;
  /** Vault root → server path prefix, for open-file mentions (Phase 2). */
  pathPrefix: string;
  /** Last working directory used for new sessions. */
  lastCwd: string;
  /** "Default Session Path" — home-page analog for new sessions (empty = use the cwd chain). */
  defaultSessionPath: string;
  /** Default model for new sessions (null = pi's own default). */
  defaultModel: { provider: string; modelId: string } | null;
  /** Default thinking level for new sessions ("auto" = pi's own default). */
  defaultThinkingLevel: ThinkingLevelOption;
  /** Instance the most recent pi tab is bound to — new tabs start here. */
  lastUsedInstanceId?: string;
  /** Include open-file @mentions in outgoing prompts. */
  includeMentions: boolean;
}

export const DEFAULT_SETTINGS: PiSettings = {
  instances: [{ id: "instance-1", name: "Default", baseUrl: "http://localhost:30141" }],
  pathPrefix: "~/HalfaCloud/Jumperpedia",
  lastCwd: "/home/ejumps",
  defaultSessionPath: "",
  defaultModel: null,
  defaultThinkingLevel: "auto",
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

    new Setting(containerEl).setName("Servers").setHeading();

    const renderServers = (): void => {
      const instances = this.plugin.settings.instances;

      instances.forEach((instance, index) => {
        const setting = new Setting(containerEl).setName(
          index === 0 ? "Default URL" : instance.name.trim() || `URL ${index + 1}`
        );
        setting.addText((text) =>
          text
            .setPlaceholder("Name")
            .setValue(instance.name)
            .onChange(async (value) => {
              instance.name = value;
              await this.plugin.saveSettings();
            })
        );
        setting.addText((text) =>
          text
            .setPlaceholder("URL")
            .setValue(instance.baseUrl)
            .onChange(async (value) => {
              instance.baseUrl = value.trim();
              await this.plugin.saveSettings();
            })
        );
        // Entry #0 is the default — it can be edited but never removed.
        if (index > 0) {
          setting.addExtraButton((button) =>
            button
              .setIcon("trash")
              .setTooltip("Remove")
              .onClick(async () => {
                this.plugin.settings.instances.splice(index, 1);
                await this.plugin.saveSettings();
                this.display();
              })
          );
        }
      });

      new Setting(containerEl).addButton((button) =>
        button
          .setButtonText("Add URL")
          .setCta()
          .setIcon("plus")
          .onClick(async () => {
            const n = this.plugin.settings.instances.length + 1;
            this.plugin.settings.instances.push({
              id: `instance-${n}-${Date.now()}`,
              name: `URL ${n}`,
              baseUrl: "",
            });
            await this.plugin.saveSettings();
            this.display();
          })
      );
    };
    renderServers();

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
      .setName("Default thinking level")
      .setDesc("Thinking level for new sessions (Auto = leave pi's current setting untouched)")
      .addDropdown((dropdown) => {
        for (const level of THINKING_LEVELS) dropdown.addOption(level.value, level.label);
        dropdown.setValue(this.plugin.settings.defaultThinkingLevel);
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultThinkingLevel = value as ThinkingLevelOption;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Provider auth & API keys")
      .setDesc("Managed on the pi-web site's Models panel for now (a later phase ports it here).");
  }
}
