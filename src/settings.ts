import { App, PluginSettingTab, Setting, type DropdownComponent, TextComponent } from "obsidian";
import type PiPlugin from "./main";
import type { ThinkingLevelOption } from "./state/agent-store";
import { listRibbonItems } from "./views/ribbon-items";
import { listCommands } from "./views/commands";

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

  /** Per-machine overrides (0.4.2) — empty/absent falls back to the global settings. */
  pathPrefix?: string;
  defaultSessionPath?: string;
  /** Folder-view tree root (0.5.19) — empty falls back to the vault path prefix. */
  folderRoot?: string;
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
  /** Voice-mode TTS endpoint (OpenAI-compatible /v1/audio/speech base). */
  ttsUrl: string;
  /** Voice-mode STT endpoint (OpenAI-compatible /v1/audio/transcriptions base). */
  sttUrl: string;
  /** Far-left composer button actions (0.5.19, user spec): press and
   *  long-press each trigger a command or a ribbon item — configured
   *  independently. An empty command id means the built-in default (press:
   *  tab overview, long-press: new tab), resolved against the command registry
   *  at run time (ids vary by device/plugin). */
  tabPressKind: "command" | "ribbon";
  tabPressCommand: string;
  tabPressRibbonItem: string;
  tabLongPressKind: "command" | "ribbon";
  tabLongPressCommand: string;
  tabLongPressRibbonItem: string;
  /** Button FACE (0.5.17): open-tab count (on) vs an icon (off) — independent
   *  of the actions. Off shows the tab square in command mode, the mirrored
   *  ribbon item's icon in ribbon mode. */
  tabButtonShowCount: boolean;
  /** Folder-view tree root (0.5.19) — decoupled from the vault path prefix
   *  (which only translates included-file paths). Empty = vault path prefix,
   *  preserving pre-0.5.19 behavior. */
  folderRoot: string;
  /** @deprecated pre-0.5.19 press action ("tabs" | "ribbon") + ribbon label —
   *  read once by the migration in loadSettings(), then dropped. */
  tabButtonAction?: "tabs" | "ribbon";
  tabButtonRibbonItem?: string;
}

export const DEFAULT_SETTINGS: PiSettings = {
  instances: [{ id: "instance-1", name: "Default", baseUrl: "http://localhost:30141" }],
  pathPrefix: "~/HalfaCloud/Jumperpedia",
  lastCwd: "/home/ejumps",
  defaultSessionPath: "",
  defaultModel: null,
  defaultThinkingLevel: "auto",
  includeMentions: false,
  ttsUrl: "https://piper.halfab.net",
  sttUrl: "https://stt.halfab.net",
  tabPressKind: "command",
  tabPressCommand: "",
  tabPressRibbonItem: "",
  tabLongPressKind: "command",
  tabLongPressCommand: "",
  tabLongPressRibbonItem: "",
  tabButtonShowCount: true,
  folderRoot: "",
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
        // One card per server: the field rows below live inside this same
        // setting element so the entry reads as one group.
        setting.settingEl.style.flexWrap = "wrap";
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
        // Per-machine paths (0.4.2): vault prefix + default session path live
        // with the server entry. Empty = fall back to the global values.
        const addFieldRow = (
          placeholder: string,
          value: string,
          onCh: (v: string) => Promise<void>
        ): void => {
          const row = setting.settingEl.createDiv({ cls: "pi-server-field" });
          new TextComponent(row).setPlaceholder(placeholder).setValue(value).onChange(onCh);
        };
        addFieldRow(
          this.plugin.settings.pathPrefix || "Vault path prefix",
          instance.pathPrefix ?? "",
          async (value) => {
            instance.pathPrefix = value.trim();
            await this.plugin.saveSettings();
          }
        );
        addFieldRow(
          "Default session path (empty = cwd chain)",
          instance.defaultSessionPath ?? "",
          async (value) => {
            instance.defaultSessionPath = value.trim();
            await this.plugin.saveSettings();
          }
        );
        addFieldRow(
          this.plugin.settings.folderRoot || "Folder view root (empty = vault path prefix)",
          instance.folderRoot ?? "",
          async (value) => {
            instance.folderRoot = value.trim();
            await this.plugin.saveSettings();
          }
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
              pathPrefix: "",
              defaultSessionPath: "",
              folderRoot: "",
            });
            await this.plugin.saveSettings();
            this.display();
          })
      );
    };
    renderServers();

    // Vault path prefix + default session path moved into the server entries
    // (0.4.2) — they are per-machine; the global fields remain as fallbacks.

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

    new Setting(containerEl).setName("Interface").setHeading();

    // Press + long-press actions (0.5.19, user spec): each binds a command or
    // a ribbon item, and the target dropdown follows the chosen kind — the
    // command registry in command mode, the ribbon DOM in ribbon mode. An
    // empty command id is the built-in default (press: tab overview,
    // long-press: new tab).
    const renderActionSetting = (which: "press" | "longPress"): void => {
      const isPress = which === "press";
      const setting = new Setting(containerEl)
        .setName(isPress ? "Tab button: press" : "Tab button: long press")
        .setDesc(
          isPress
            ? "What a tap on the far-left button under the prompt editor does."
            : "What holding the far-left button under the prompt editor does."
        );
      setting.addDropdown((dropdown) => {
        dropdown.addOption("command", "Command");
        dropdown.addOption("ribbon", "Ribbon menu item");
        dropdown.setValue(isPress ? this.plugin.settings.tabPressKind : this.plugin.settings.tabLongPressKind);
        dropdown.onChange(async (value) => {
          const kind = value === "ribbon" ? "ribbon" : "command";
          if (isPress) this.plugin.settings.tabPressKind = kind;
          else this.plugin.settings.tabLongPressKind = kind;
          await this.plugin.saveSettings();
          this.display();
        });
      });
      setting.addDropdown((dropdown) => {
        const ribbonMode = (isPress ? this.plugin.settings.tabPressKind : this.plugin.settings.tabLongPressKind) === "ribbon";
        if (ribbonMode) {
          const items = listRibbonItems();
          if (items.length === 0) {
            dropdown.addOption("", "No ribbon items found");
            dropdown.setDisabled(true);
            return;
          }
          for (const it of items) dropdown.addOption(it.label, it.label);
          const current = isPress ? this.plugin.settings.tabPressRibbonItem : this.plugin.settings.tabLongPressRibbonItem;
          if (!current || !items.some((it) => it.label === current)) {
            // First use: default to the user's "quick access" item when present.
            const guess = items.find((it) => /quick\s*access/i.test(it.label))?.label ?? items[0].label;
            if (isPress) this.plugin.settings.tabPressRibbonItem = guess;
            else this.plugin.settings.tabLongPressRibbonItem = guess;
            void this.plugin.saveSettings();
          }
          dropdown.setValue(isPress ? this.plugin.settings.tabPressRibbonItem : this.plugin.settings.tabLongPressRibbonItem);
          dropdown.onChange(async (value) => {
            if (isPress) this.plugin.settings.tabPressRibbonItem = value;
            else this.plugin.settings.tabLongPressRibbonItem = value;
            await this.plugin.saveSettings();
            this.plugin.refreshTabButtons();
          });
          return;
        }
        // Command mode: the full registry plus the built-in default entry.
        dropdown.addOption("", isPress ? "Default (Tab overview)" : "Default (New tab)");
        for (const c of listCommands(this.app)) dropdown.addOption(c.id, c.name || c.id);
        dropdown.setValue(isPress ? this.plugin.settings.tabPressCommand : this.plugin.settings.tabLongPressCommand);
        dropdown.onChange(async (value) => {
          if (isPress) this.plugin.settings.tabPressCommand = value;
          else this.plugin.settings.tabLongPressCommand = value;
          await this.plugin.saveSettings();
          this.plugin.refreshTabButtons();
        });
      });
    };
    renderActionSetting("press");
    renderActionSetting("longPress");

    new Setting(containerEl)
      .setName("Show tab count")
      .setDesc(
        "What the button shows: the number of open tabs (on) or an icon (off). Off shows the tab square in command mode, the ribbon item's icon in ribbon mode."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.tabButtonShowCount).onChange(async (value) => {
          this.plugin.settings.tabButtonShowCount = value;
          await this.plugin.saveSettings();
          this.plugin.refreshTabButtons();
        })
      );

    new Setting(containerEl).setName("Voice mode").setHeading();
    new Setting(containerEl)
      .setName("TTS endpoint")
      .setDesc("OpenAI-compatible /v1/audio/speech base for voice mode's read-aloud.")
      .addText((text) =>
        text
          .setPlaceholder("https://piper.halfab.net")
          .setValue(this.plugin.settings.ttsUrl)
          .onChange(async (value) => {
            this.plugin.settings.ttsUrl = value.trim() || "https://piper.halfab.net";
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("STT endpoint")
      .setDesc("OpenAI-compatible /v1/audio/transcriptions base for voice mode dictation.")
      .addText((text) =>
        text
          .setPlaceholder("https://stt.halfab.net")
          .setValue(this.plugin.settings.sttUrl)
          .onChange(async (value) => {
            this.plugin.settings.sttUrl = value.trim() || "https://stt.halfab.net";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Provider auth & API keys")
      .setDesc("Managed on the pi-web site's Models panel for now (a later phase ports it here).");
  }
}
