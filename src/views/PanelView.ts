// The pi panel: right-sidebar control center (session picker + controls +
// machine pill). Per PLAN/PHASES/PHASE-3.md. Mobile and desktop layouts
// mirror Obsidian's own sidebar conventions via CSS `order` (see styles.css).

import { ItemView, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { resolveServerPath } from "../state/paths";
import { openSse } from "../api/sse";
import type { SessionInfo } from "../api/types";
import { ServerTree } from "./panel/ServerTree";
import { SessionList } from "./panel/SessionList";
import { PillSelect } from "./panel/PillSelect";
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
  private runningStream: { close(): void } | null = null;
  private runningStreamInstance: string | null = null;
  private unsubActive: (() => void) | null = null;
  private lastActiveKey = "";
  private mainEl!: HTMLElement;
  private mode: PanelMode = "recent";
  /** Include/exclude open-file @mentions pill (settings-backed). */
  private mentionsPill: PillSelect<boolean> | null = null;
  /** Voice-mode toggle — focused pi tab (PHASE-14). */
  private voiceBtnEl: HTMLElement | null = null;
  /** Machine pill — the focused pi tab's instance selector (Phase 13 / T47). */
  private machinePill: PillSelect<string> | null = null;

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
    // Tool view — never a file-navigation target (see ChatView.onOpen).
    this.navigation = false;
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

  async onClose(): Promise<void> {
    this.unsubActive?.();
    this.unsubActive = null;
    this.stopRunningStream();
  }

  // ---------- DOM ----------

  private buildDom(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("pi-panel");
    root.addClass(Platform.isMobile ? "pi-panel--mobile" : "pi-panel--desktop");

    // Machine pill — which machine the focused pi tab talks to. Keeps the old
    // settings-row slot and its `pi-panel-settings` class: same pinned
    // placement (top on mobile, bottom on desktop) and full-width row; the
    // settings shortcuts it replaces stay reachable via Obsidian's settings
    // search.
    const instances = this.plugin.getInstances();
    const current = this.currentMachine();
    const machinePill = new PillSelect<string>({
      icon: "monitor",
      label: current.name,
      value: current.id,
      options:
        instances.length > 0
          ? instances.map((i) => ({ value: i.id, label: i.name }))
          : [{ value: "", label: "Default" }], // defensive: nothing configured
      onChange: (id) => {
        if (!id) return; // inert "Default" placeholder (nothing configured)
        // Re-point the focused tab first, then refetch — the store reset
        // drops the old machine's sessions, so reload the lists.
        void this.plugin
          .withChatView((v) => v.setInstance(id))
          .then(() => this.refresh());
      },
    });
    this.machinePill = machinePill;
    root.createDiv({ cls: "pi-panel-settings" }).appendChild(machinePill.el);


    // Re-sync when the focused pi tab changes, and on pill open — mobile tab
    // switches don't reliably deliver active-leaf-change (see main.ts), so a
    // tap re-reads the focused tab before the user picks a machine.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.syncMachinePill())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.syncVoiceButton())
    );
    machinePill.el.addEventListener("click", () => this.syncMachinePill(), true);

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
      app: this.app,
      onOpen: (id) => {
        void this.plugin.openSessionInChat(id);
        this.collapse();
      },
      renameSession: (id, name) =>
        this.plugin.getClient(this.focusedInstanceId()).renameSession(id, name),
      deleteSession: (id) => this.deleteSession(id),
      onSessionsChanged: () => void this.refresh(),
    });
    this.mainEl.appendChild(this.list.el);

    // Controls row: new session, compact, then the mentions pill.
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
    const include = this.plugin.settings.includeMentions;
    const mentionsPill = new PillSelect<boolean>({
      icon: include ? "file" : "file-x",
      label: include ? "Include" : "Exclude",
      value: include,
      options: [
        { value: true, label: "Include", icon: "file" },
        { value: false, label: "Exclude", icon: "file-x" },
      ],
      onChange: (next) => {
        this.plugin.settings.includeMentions = next;
        void this.plugin.saveSettings();
        this.syncMentionsPill();
      },
    });
    this.mentionsPill = mentionsPill;
    controls.appendChild(mentionsPill.el);

    // Voice-mode button (beta14): inline with the controller buttons, right of
    // the include/exclude pill — a round icon button like its neighbors.
    const voiceBtn = this.panelButton(controls, "mic", "Voice mode — hands-free");
    voiceBtn.addEventListener("click", () => {
      void this.plugin
        .withChatView((v) => v.setVoiceMode(!v.isVoiceMode()))
        .then(() => this.syncVoiceButton());
    });
    this.voiceBtnEl = voiceBtn;
    this.syncVoiceButton();
  }

  /** Re-sync the mentions pill (icon + label) to plugin settings — load,
   *  after a change, and from refresh() for external changes. */
  private syncMentionsPill(): void {
    const pill = this.mentionsPill;
    if (!pill) return;
    const include = this.plugin.settings.includeMentions;
    const iconEl = pill.el.querySelector<HTMLElement>(".pi-pill-icon");
    if (iconEl) setIcon(iconEl, include ? "file" : "file-x");
    pill.setValue(include);
  }

  /** Re-sync the voice button to the focused pi tab's mode (same active-view
   *  identity match as the machine pill). */
  private syncVoiceButton(): void {
    const btn = this.voiceBtnEl;
    if (!btn) return;
    const active =
      this.plugin
        .getChatViews()
        .find((v) => v.getStore() === this.plugin.getActiveStore())
        ?.isVoiceMode() ?? false;
    btn.toggleClass("is-active", active);
    btn.empty();
    setIcon(btn, active ? "mic-off" : "mic");
    btn.setAttribute("aria-label", active ? "Voice mode on — tap to turn off" : "Voice mode — hands-free");
    btn.setAttribute("title", active ? "Voice mode on" : "Voice mode");
  }

  /** Re-sync the machine pill (label + selection) to the focused pi tab's
   *  instance — from refresh(), focus changes, and pill open, mirroring how
   *  the mentions pill re-syncs in refresh(). */
  private syncMachinePill(): void {
    const pill = this.machinePill;
    if (!pill) return;
    const current = this.currentMachine();
    pill.setValue(current.id, current.name);
  }

  /** The machine pill's current value: the focused tab's instance, else the
   *  default instance — or the inert "Default" placeholder when no instance
   *  is configured (defensive, T47). */
  private currentMachine(): { id: string; name: string } {
    const instances = this.plugin.getInstances();
    if (instances.length === 0) return { id: "", name: "Default" };
    const id = this.focusedInstanceId();
    return instances.find((i) => i.id === id) ?? instances[0];
  }

  /** The focused pi tab's instance id, through the plugin's existing
   *  active-view tracking (no second tracker): getActiveStore() resolves via
   *  the tracked active view, so the view whose store it returns — matched by
   *  identity across getChatViews() — is the focused tab. No pi tab (or an
   *  unbound one) → the instance a fresh tab would bind to. */
  private focusedInstanceId(): string {
    if (this.plugin.getInstances().length === 0) return ""; // defensive
    const active = this.plugin.getActiveStore();
    const view = active
      ? this.plugin.getChatViews().find((v) => v.getStore() === active)
      : undefined;
    return view?.getInstanceId() || this.plugin.getInstanceForNewTab().id;
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
      // Folders are per-machine too: resolve and browse through the focused
      // tab's client. listDir re-resolves per call, so a machine switch is
      // picked up by the next refresh() → tree.refresh().
      const root = await resolveServerPath(
        this.plugin.getClient(this.focusedInstanceId()),
        this.plugin.getInstancePaths(this.focusedInstanceId()).pathPrefix
      );
      this.tree = new ServerTree({
        rootPath: root,
        listDir: (path) =>
          this.plugin
            .getClient(this.focusedInstanceId())
            .listDir(path)
            .then((r) => r.entries),
        getSessions: (dir) => this.sessionsSnapshot.filter((s) => s.cwd === dir),
        runningIds: () => this.runningSnapshot,
        app: this.app,
        renameSession: (id, name) =>
          this.plugin.getClient(this.focusedInstanceId()).renameSession(id, name),
        deleteSession: (id) => this.deleteSession(id),
        onSessionsChanged: () => void this.refresh(),
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

  /** Delete a session on the focused machine, then drop it from any chat tab
   *  that has it open — that store would keep operating on a session which
   *  no longer exists. */
  private async deleteSession(id: string): Promise<void> {
    await this.plugin.getClient(this.focusedInstanceId()).deleteSession(id);
    for (const view of this.plugin.getChatViews()) {
      const store = view.getStore();
      if (store?.state.sessionId === id) store.reset();
    }
  }

  async refresh(): Promise<void> {
    this.syncMentionsPill();
    this.syncMachinePill();
    this.list.setLoading();
    try {
      // Sessions are per-machine: list them from the focused tab's client.
      const res = await this.plugin
        .getClient(this.focusedInstanceId())
        .listSessions();
      const sessions = [...res.sessions].sort((a, b) =>
        b.modified.localeCompare(a.modified)
      );
      this.sessionsSnapshot = sessions;
      this.runningSnapshot = res.runningSessionIds ?? [];
      // The list is BUILT here (0.4.12) — renderRunning() only patches markers
      // onto existing rows from here on.
      this.list.setSessions(sessions, [...this.runningIdsUnion()]);
      this.renderRunning();
      this.watchActiveStore();
      // The fetch's running set is only a fallback — the live feed owns it
      // once connected (pi-web's model).
      this.startRunningStream();
    } catch (e) {
      this.list.setSessions([], []);
      new Notice(`pi: ${String(e)}`);
    }
  }

  /** Union of the server's running set and the focused tab's own run state —
   *  the local store is an instant, authoritative signal for the session the
   *  user is looking at, independent of the feed. */
  private runningIdsUnion(): Set<string> {
    const ids = new Set(this.runningSnapshot);
    const store = this.plugin.getActiveStore();
    if (store?.state.agentRunning && store.state.sessionId) {
      ids.add(store.state.sessionId);
    }
    return ids;
  }

  /** Patch running markers onto existing rows (0.4.12) — no rebuild, so live
   *  run state can't clobber renames, scroll, or folder collapse state. */
  private renderRunning(): void {
    const ids = this.runningIdsUnion();
    this.list.setRunningIds(ids);
    this.tree?.setRunningIds(ids);
  }

  /** Re-render when the focused tab's run state flips (send → running, done). */
  private watchActiveStore(): void {
    this.unsubActive?.();
    this.unsubActive = null;
    const store = this.plugin.getActiveStore();
    if (!store) return;
    this.lastActiveKey = `${store.state.sessionId}:${store.state.agentRunning}`;
    this.unsubActive = store.subscribe(() => {
      const key = `${store.state.sessionId}:${store.state.agentRunning}`;
      if (key === this.lastActiveKey) return;
      this.lastActiveKey = key;
      this.renderRunning();
    });
  }

  /** Live run-state feed (pi-web's GET /api/agent/running/events): the server
   *  pushes the running id set whenever any session starts/stops — across all
   *  of a machine's clients, which is the point (0.4.1). Re-points when the
   *  focused tab's machine changes; a dropped stream is re-established by the
   *  next refresh rather than looping here. */
  private startRunningStream(): void {
    const instanceId = this.focusedInstanceId();
    if (this.runningStream && this.runningStreamInstance === instanceId) return;
    this.runningStream?.close();
    this.runningStreamInstance = instanceId;
    const base = this.plugin.getClient(instanceId).baseUrl.replace(/\/+$/, "");
    this.runningStream = openSse(`${base}/api/agent/running/events`, {
      onFrame: (_name, data) => {
        const ev = data as { type?: string; runningSessionIds?: string[] };
        if (ev?.type !== "running" || !Array.isArray(ev.runningSessionIds)) return;
        this.runningSnapshot = ev.runningSessionIds;
        this.renderRunning();
      },
      onError: (e) => {
        // Not silent: a dead feed is exactly the bug class that hides here.
        console.warn("[pi-obsidian] running feed error:", e.message);
      },
      onClose: () => {
        this.runningStream = null;
        // One lazy retry — refresh()/machine switches re-establish too.
        setTimeout(() => {
          if (!this.runningStream && this.runningStreamInstance) this.startRunningStream();
        }, 5000);
      },
    });
  }

  private stopRunningStream(): void {
    this.runningStream?.close();
    this.runningStream = null;
    this.runningStreamInstance = null;
  }
}
