import { MarkdownView, Menu, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import { PiClient } from "./api/client";
import { DEFAULT_SETTINGS, PiSettingTab, type PiInstance, type PiSettings } from "./settings";
import type { AgentStore } from "./state/agent-store";
import { resolveNewSessionCwd as resolveCwdChain } from "./state/paths";
import { setApiBase } from "./views/react/pi-web/api-base";
import { ChatView, VIEW_TYPE_PI_CHAT } from "./views/ChatView";
import { PanelView, VIEW_TYPE_PI_PANEL } from "./views/PanelView";

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
  client: PiClient = new PiClient(DEFAULT_SETTINGS.instances[0].baseUrl);
  /** Per-instance client cache, keyed by instance id (rebuilt lazily). */
  private clients = new Map<string, PiClient>();
  /** The most recently active chat view (T41) — panel/ribbon/commands target it. */
  private activeChatView: ChatView | null = null;

  async onload(): Promise<void> {
    try {
      await this.loadSettings();
      this.clients.clear();
      this.client = this.getClient(null);
      setApiBase(this.getDefaultInstance().baseUrl);

    this.registerView(VIEW_TYPE_PI_CHAT, (leaf) => this.createChatView(leaf));
    this.registerView(VIEW_TYPE_PI_PANEL, (leaf) => new PanelView(leaf, this));
    this.addSettingTab(new PiSettingTab(this.app, this));

    // Track the most recently active chat view — the panel and the commands
    // act through it instead of a singleton (T41).
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        const view = leaf?.view;
        if (
          view instanceof ChatView &&
          view.getViewType() === VIEW_TYPE_PI_CHAT &&
          "store" in view
        ) {
          this.activeChatView = view;
        }
      })
    );

    this.addCommand({
      id: "open-pi",
      name: "Open pi",
      callback: () => void this.activateChatView(),
    });
    this.addCommand({
      id: "open-pi-new-tab",
      name: "Open pi in new tab",
      callback: () => void this.activateChatViewInNewTab(),
    });
    this.addCommand({
      id: "open-pi-panel",
      name: "Open pi panel",
      callback: () => void this.activatePanelView(),
    });
    this.addCommand({
      id: "new-pi-session",
      name: "New session",
      callback: () => void this.prepareNewSession(),
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
      // Navigation only — session actions live in the right sidebar panel
      // (New session / Compact there) and in the composer (Stop, model menu).
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle("Open pi").setIcon("message-square").onClick(() => void this.openPiHere())
      );
      menu.addItem((item) =>
        item.setTitle("Open pi in new tab").setIcon("plus").onClick(() => void this.activateChatViewInNewTab())
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

  /** Open pi IN the current tab (ribbon "Open pi"): replaces the active
   *  tab's view with pi unless it is already pi. Two guards: a sidebar leaf
   *  is never the target (the ribbon is invoked from sidebar drawers on
   *  mobile — that case opens a tab instead), and main-area membership is
   *  checked via iterateRootLeaves (the documented main-area traversal). */
  async openPiHere(): Promise<void> {
    const leaf = this.app.workspace.activeLeaf;
    if (leaf?.view instanceof ChatView) {
      this.app.workspace.setActiveLeaf(leaf);
      return;
    }
    let inMain = false;
    if (leaf) this.app.workspace.iterateRootLeaves((l) => { if (l === leaf) inMain = true; });
    const target = inMain && leaf ? leaf : this.app.workspace.getLeaf("tab");
    await target.setViewState({ type: VIEW_TYPE_PI_CHAT, active: true });
  }

  /** Open the chat view in the main area (T42): focus an existing pi tab,
   *  create one only when none exists. */
  async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_PI_CHAT)[0];
    if (existing) {
      this.app.workspace.setActiveLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_PI_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Always open a FRESH pi tab (T42) — never reuses an existing leaf. */
  async activateChatViewInNewTab(): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_PI_CHAT, active: true });
  }

  /** Create a chat view wired for active-view bookkeeping (T41): its onClose
   *  drops the plugin's reference when it points at this view, so a closed
   *  tab never pins the view — and its store — in memory. The hook lives in
   *  the factory so ChatView's onClose stays per-instance lifecycle cleanup. */
  private createChatView(leaf: WorkspaceLeaf): ChatView {
    const view = new ChatView(leaf, this);
    const closeOriginal = view.onClose.bind(view);
    view.onClose = async () => {
      if (this.activeChatView === view) this.activeChatView = null;
      await closeOriginal();
    };
    return view;
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

  /** Resolve the cwd for a new session via the settings chain (Phase 4). */
  async resolveNewSessionCwd(): Promise<string> {
    return resolveCwdChain(this.client, {
      defaultPath: this.settings.defaultSessionPath,
      currentCwd: this.getActiveStore()?.state.cwd || null,
      lastCwd: this.settings.lastCwd,
      fallbackRoot: this.settings.pathPrefix,
    });
  }

  /** New-session flow: cwd from the chain, first prompt creates the session. */
  async prepareNewSession(): Promise<void> {
    const cwd = await this.resolveNewSessionCwd();
    await this.withChatView((view) => view.prepareNewSession(cwd));
  }

  /** Open a session in the chat view (panel-driven). */
  async openSessionInChat(id: string): Promise<void> {
    await this.withChatView((view) => view.openSessionById(id));
  }

  /** The active chat view while its leaf is still in the workspace — a
   *  closed tab must never be targeted (T41). */
  private attachedActiveChatView(): ChatView | null {
    const active = this.activeChatView;
    if (!active) return null;
    const attached = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_PI_CHAT)
      .some((leaf) => leaf.view === active);
    return attached ? active : null;
  }

  /** The first chat leaf's view — the singleton-era fallback (T41). */
  private firstChatView(): ChatView | null {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_PI_CHAT)[0]?.view;
    return view instanceof ChatView ? view : null;
  }

  /** Record the pi view the user is working in (panel actions target it).
   *  Called by ChatView on visibility transitions and pointer/focus events —
   *  mobile tab switches don't reliably deliver active-leaf-change, which
   *  left the panel aimed at the first tab (sessions opened invisibly into
   *  hidden tabs). */
  setActiveChatView(view: ChatView): void {
    this.activeChatView = view;
    // "New tab opens on the last-used machine" (Phase 13) — only persist a
    // change, focus events are frequent.
    const id = view.getInstanceId();
    if (id && this.settings.lastUsedInstanceId !== id) {
      this.settings.lastUsedInstanceId = id;
      void this.saveSettings();
    }
  }

  /** The instance a freshly created pi tab binds to: last-used, else the
   *  default (instances[0]). */
  getInstanceForNewTab(): PiInstance {
    const last = this.getInstances().find((i) => i.id === this.settings.lastUsedInstanceId);
    return last ?? this.getDefaultInstance();
  }

  /** All live chat views (cross-machine duplicate checks, panel targeting). */
  getChatViews(): ChatView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_PI_CHAT)
      .map((l) => l.view)
      .filter((v): v is ChatView => v instanceof ChatView);
  }

  /** The store of the most recently active chat view, if any. */
  getActiveStore(): AgentStore | null {
    return (this.attachedActiveChatView() ?? this.firstChatView())?.getStore() ?? null;
  }

  /** Run an action against the chat view, opening it first if needed. */
  async withChatView(action: (view: ChatView) => void): Promise<void> {
    const attached = this.attachedActiveChatView();
    if (attached) {
      action(attached);
      return;
    }
    await this.activateChatView();
    const view = this.firstChatView();
    if (view) action(view);
  }


  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<PiSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
    // Migration: pre-multi-instance settings stored a single `baseUrl`.
    if (raw?.baseUrl && !raw.instances) {
      this.settings.instances = [{ id: "instance-1", name: "Default", baseUrl: raw.baseUrl }];
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // URLs may have changed — drop the cached clients and rebuild the default.
    this.clients.clear();
    this.client = this.getClient(null);
    setApiBase(this.getDefaultInstance().baseUrl);
  }

  /** All configured instances (first = default). */
  getInstances(): PiInstance[] {
    return this.settings.instances;
  }

  /** The default instance — the first entry of the list. */
  getDefaultInstance(): PiInstance {
    return this.settings.instances[0];
  }

  /** The client for an instance id — falls back to the default instance when
   *  the id is unknown/absent. Cached per id and rebuilt lazily. */
  getClient(instanceId: string | null | undefined): PiClient {
    const instances = this.settings.instances;
    const instance = (instanceId ? instances.find((i) => i.id === instanceId) : null) ?? instances[0];
    let client = this.clients.get(instance.id);
    if (!client) {
      client = new PiClient(instance.baseUrl);
      this.clients.set(instance.id, client);
    }
    return client;
  }
}
