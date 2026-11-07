// The pi panel: right-sidebar control center (session picker + controls +
// settings shortcuts). Per PLAN/PHASES/PHASE-3.md. Mobile and desktop layouts
// mirror Obsidian's own sidebar conventions via CSS `order` (see styles.css).

import { ItemView, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { resolveServerPath } from "../state/paths";
import type { SessionInfo } from "../api/types";
import { ServerTree } from "./panel/ServerTree";
import { SessionList } from "./panel/SessionList";
import type PiPlugin from "../main";

export const VIEW_TYPE_PI_PANEL = "pi-panel";

type PanelMode = "recent" | "folders";

export class PanelView extends ItemView {
  private list!: SessionList;
  private toggleRecentEl!: HTMLButtonElement;
  private toggleFoldersEl!: HTMLButtonElement;
  private tree: ServerTree | null = null;
  private sessionsSnapshot: SessionInfo[] = [];
  private runningSnapshot: string[] = [];
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
      onOpen: (id) => {
        void this.plugin.openSessionInChat(id);
        this.collapse();
      },
    });
    this.mainEl.appendChild(this.list.el);

    // Controls row: new session, compact.
    const controls = root.createDiv({ cls: "pi-panel-controls" });
    const newBtn = this.panelButton(controls, "plus", "New session");
    newBtn.addEventListener("click", () => {
      void this.plugin.prepareNewSession();
      this.collapse();
    });
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

  /** Close the right sidebar/drawer after an action that leaves the panel
   *  (session selected, new session started). */
  private collapse(): void {
    try {
      const split = (this.app.workspace as unknown as {
        rightSplit?: { collapse?: () => void };
      }).rightSplit;
      split?.collapse?.();
    } catch {
      // never let a chrome nicety break the action itself
    }
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
    if (recent) {
      if (this.tree) this.tree.el.style.display = "none";
      void this.refresh();
    } else {
      void this.ensureTree();
    }
  }

  /** Lazily build the folders tree — always rooted at the vault path prefix
   *  (confined to it: no navigation above it, per design). */
  private async ensureTree(): Promise<void> {
    if (this.tree) {
      this.tree.el.style.display = "";
      this.tree.refresh();
      return;
    }
    try {
      const root = await resolveServerPath(
        this.plugin.client,
        this.plugin.settings.pathPrefix
      );
      this.tree = new ServerTree({
        rootPath: root,
        listDir: (path) => this.plugin.client.listDir(path).then((r) => r.entries),
        getSessions: (dir) => this.sessionsSnapshot.filter((s) => s.cwd === dir),
        runningIds: () => this.runningSnapshot,
        onNewSession: (cwd) => {
          void this.plugin.withChatView((v) => v.prepareNewSession(cwd));
          this.collapse();
        },
        onOpenSession: (id) => {
          void this.plugin.openSessionInChat(id);
          this.collapse();
        },
      });
      this.mainEl.appendChild(this.tree.el);
    } catch (e) {
      new Notice(`pi: ${String(e)}`);
    }
  }

  // ---------- data ----------

  async refresh(): Promise<void> {
    this.list.setLoading();
    try {
      const res = await this.plugin.client.listSessions();
      const sessions = [...res.sessions].sort((a, b) =>
        b.modified.localeCompare(a.modified)
      );
      this.sessionsSnapshot = sessions;
      this.runningSnapshot = res.runningSessionIds;
      this.list.setSessions(sessions, res.runningSessionIds);
      this.tree?.refresh();
    } catch (e) {
      this.list.setSessions([], []);
      new Notice(`pi: ${String(e)}`);
    }
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
