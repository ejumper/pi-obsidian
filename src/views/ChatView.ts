// The chat view: session bar on top, transcript in the middle, composer block
// pinned to the bottom (auto-grow editor + button row). Per PLAN/PHASES/PHASE-2.md.

import { ItemView, Menu, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { AgentStore, type ThinkingLevelOption } from "../state/agent-store";
import type { AgentMessage, AttachedImageInput, CustomMessage } from "../api/types";
import type { SpeakController } from "./speak-context";
import { computeTranscriptUnits } from "./message-display";
import { stripVoiceBlocks, stripMessageVoiceBlocks } from "./voice/banner-state";
import { TranscriptRenderer } from "./react/Transcript";
import { AttachmentStage } from "./composer/attachments";
import { buildMentionPrefix, collectOpenFiles, mapServerPaths } from "./composer/mentions";
import { resolveServerPath } from "../state/paths";
import { attachKeyboardInset, composerBottomPx, phoneClassScreen, readKeyboardHeightPx } from "./keyboard";
import type PiPlugin from "../main";
import { BUILD_ID } from "../main";
import { VoiceController } from "./voice/voice-controller";
import { VoiceOverlay } from "./voice/voice-overlay";
import { invokeRibbonItem, listRibbonItems } from "./ribbon-items";
import { executeCommand, findNewTabCommand, findTabOverviewCommand, listCommands } from "./commands";
import { loadVoicePrompts } from "./voice/prompts";

export const VIEW_TYPE_PI_CHAT = "pi-chat";

const THINKING_LEVELS: ThinkingLevelOption[] = [
  "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

/** New-session titles show the bare cwd path, truncated to the TAIL (0.5.19,
 *  user spec): the far-right directory is the informative end. Truncation is
 *  CSS's job (.pi-title-path — left-ellipsis, works at any bar width); LRMs
 *  (0.5.20) pin trailing punctuation so a trailing "/" can't bidi-flip to
 *  the left edge under direction: rtl. */
function pathTitle(p: string): string {
  return `\u200e${p}\u200e`;
}

export class ChatView extends ItemView {
  private store!: AgentStore;
  private transcript!: TranscriptRenderer;
  private modelNames: Record<string, string> = {};
  private unsubscribe: (() => void) | null = null;

  // NOTE: field names must not collide with base-class instance properties —
  // ES2022 class fields are DEFINEd after super() and would clobber values the
  // Obsidian View constructor set (titleEl was exactly this bug: View.load()
  // calls titleEl.setText(getDisplayText()) before onOpen ever runs).
  private sessionTitleEl!: HTMLElement;
  /** Open inline rename input on the session title (dblclick rename), while
   *  non-null updateTitle() must leave the title alone. */
  private renameInputEl: HTMLInputElement | null = null;
  private barSizeEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private modelChipEl!: HTMLButtonElement;
  private modelChipNameEl!: HTMLElement;
  private attachBtnEl!: HTMLButtonElement;
  private sendBtnEl!: HTMLButtonElement;
  private queueBtnEl!: HTMLButtonElement;
  private stopBtnEl!: HTMLButtonElement;
  private sendGroupEl!: HTMLElement;
  private runGroupEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private transcriptHostEl!: HTMLElement;
  private loaderEl!: HTMLElement;

  private pendingCwd: string | null = null;
  /** Mobile composer tab button's count span (null on desktop — no button). */
  private tabCountEl: HTMLElement | null = null;
  private tabBtnEl: HTMLButtonElement | null = null;
  /** First tab-button action logs the resolved command so it can be corrected. */
  private tabCommandLogged = false;
  private attachments!: AttachmentStage;
  private detachKeyboard: (() => void) | null = null;
  private composerEl!: HTMLElement;
  private queueHostEl!: HTMLElement;
  private geometryTimer: ReturnType<typeof setInterval> | null = null;
  // Scroll-to-bottom bookkeeping: opening/switching a session (or a load
  // settling) must land at the end of the transcript even when the previous
  // scroll position wasn't "near bottom". Prefixed — see the note above.
  private prevSessionIdForScroll: string | null = null;
  private prevLoadingForScroll = false;
  /** Scroll-to-bottom intent window (0.4.6): the old one-shot flag burned
   *  on the first, still-empty render of a session load. While the window is
   *  open every commit and a set of timed passes re-scroll to the end. */
  private pinBottomUntil = 0;
  private prevShownForFocus = false;
  /** The machine this tab talks to (Phase 13) — persisted in leaf state. */
  private instanceId = "";
  /** PHASE-16 restore slot: setState can arrive before or after onOpen; the
   *  saved session/draft park here until the store and composer both exist. */
  private restorePending = false;
  private restoredSessionId: string | null = null;
  private restoredDraft = "";
  /** Read-aloud backend for the React subtree (module-global, re-pointed per
   *  render pass like api-base) — routes into the voice-mode TTS pipeline. */
  private speakController: SpeakController = {
    speak: (id, text) => {
      if (!this.voiceController) {
        new Notice("pi: TTS unavailable");
        return;
      }
      this.voiceController.speakMessage(id, text);
    },
    stop: () => this.voiceController?.stopSpeaking(),
    subscribe: (fn) => this.voiceController?.subscribeSpeak(fn) ?? (() => {}),
  };
  /** Voice mode (PHASE-14) — hands-free overlay over the transcript. */
  private voiceController: VoiceController | null = null;
  private voiceOverlay: VoiceOverlay | null = null;
  private voiceOn = false;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PiPlugin
  ) {
    super(leaf);
    // Construction stays trivial: anything heavier can throw, and a throw in
    // the constructor produces a silently blank leaf (onOpen never runs, so
    // even the error panel never paints). Heavy work happens in onOpen's
    // try/catch instead.
  }

  /** Leaf-state persistence (PHASE-16): tabs keep their machine, their session
   *  and their composer draft across restarts and iOS kills. Obsidian serializes
   *  this at quit and at app-pause — the two flows tabs get lost to. Older saved
   *  states carry only instanceId and restore exactly as before. */
  getState(): { instanceId: string; sessionId: string | null; draft: string } {
    return {
      instanceId: this.instanceId,
      sessionId: this.store?.state.sessionId ?? null,
      draft: (this.inputEl as HTMLTextAreaElement | undefined)?.value ?? "",
    };
  }

  async setState(state: { instanceId?: string; sessionId?: string | null; draft?: string } | null): Promise<void> {
    if (state?.instanceId) this.instanceId = state.instanceId;
    if (state?.sessionId || state?.draft) {
      this.restorePending = true;
      this.restoredSessionId = state.sessionId ?? null;
      this.restoredDraft = state.draft ?? "";
      void this.maybeRestore();
    }
    this.refreshLeafTitle();
  }

  /** PHASE-16: restore this tab's session and draft once the view is ready —
   *  called from setState and from onOpen, so either ordering works. Policy
   *  (user, 2026-11-17): a session that can't be opened falls back to a new
   *  session with a Notice — a deleted session isn't wanted anyway, and the
   *  notice covers "something was supposed to be here". The draft restores
   *  either way; typed text is worth keeping even if the session is gone. */
  private async maybeRestore(): Promise<void> {
    if (!this.restorePending || !this.store || !this.inputEl) return;
    this.restorePending = false;
    const id = this.restoredSessionId;
    const draft = this.restoredDraft;
    this.restoredSessionId = null;
    this.restoredDraft = "";
    if (draft) {
      (this.inputEl as HTMLTextAreaElement).value = draft;
      this.inputEl.dispatchEvent(new Event("input")); // re-run auto-grow
    }
    if (!id) return;
    const name =
      this.plugin.settings.instances.find((i) => i.id === this.instanceId)?.name ?? "the machine";
    try {
      // Verify-first so the fallback can stay silent-new-session + Notice;
      // the normal open path then loads transcript, stream and run state.
      await this.plugin.getClient(this.instanceId).getSession(id);
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      new Notice(
        status === 404
          ? `pi: the session this tab had open is gone on ${name} (deleted?) — opened a new one`
          : `pi: couldn't reach ${name} to restore this tab's session — opened a new one`
      );
      return;
    }
    void this.store.openSession(id);
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  /** Re-point this tab at another machine (panel pill): store rebinds and the
   *  tab drops to no-session — sessions are per-machine storage. */
  setInstance(id: string): void {
    if (!id || id === this.instanceId) return;
    this.instanceId = id;
    this.store.rebind(this.plugin.getClient(id));
    this.setVoiceMode(false);
    // The tab title names the target device (0.5.6) — refresh it on switches.
    this.refreshLeafTitle();
    this.render();
  }

  /** Hands-free voice mode (PHASE-14): overlay covers the transcript, composer
   *  hides (CSS class, not inline — the keyboard inset code flips display), and
   *  the banner state machine keeps per-send announcements flowing. */
  setVoiceMode(on: boolean): void {
    this.voiceOn = on;
    this.voiceController?.setVoiceMode(on);
    this.voiceOverlay?.setVisible(on);
    this.composerEl?.toggleClass("pi-voice-hidden", on);
  }

  isVoiceMode(): boolean {
    return this.voiceOn;
  }

  /** Build the voice controller + overlay after the DOM exists. Eager so the
   *  banner machine wraps EVERY send — a typed prompt after a voice turn must
   *  announce "voice mode off" even if this tab never opened voice mode. */
  /** Voice-mode send: the composer's session logic without the composer bits.
   *  Creates the session when none exists (the store's sendPrompt silently
   *  no-ops on a session-less tab — beta13's new-session bug), queues while a
   *  run is active (typing parity), else prompts. */
  private async voiceSendText(text: string): Promise<void> {
    const s = this.store.state;
    if (!s.sessionId) {
      let cwd = this.pendingCwd;
      if (!cwd) {
        try {
          cwd = await this.plugin.resolveNewSessionCwd(this.instanceId);
        } catch {
          // chain resolution failed — same fallback as the composer: give up
        }
      }
      if (!cwd) {
        new Notice("pi: could not resolve a working directory for a new session");
        return;
      }
      this.pendingCwd = null;
      void this.store.startNewSession(cwd, text, undefined, {
        model: this.plugin.settings.defaultModel ?? undefined,
      });
      return;
    }
    if (s.agentRunning) await this.store.queuePrompt(text, "followUp");
    else await this.store.sendPrompt(text);
  }

  private async initVoice(): Promise<void> {
    try {
      const prompts = await loadVoicePrompts(
        this.app.vault.adapter,
        this.plugin.manifest?.dir,
      );
      this.voiceController = new VoiceController({
        store: this.store,
        prompts,
        ttsUrl: this.plugin.settings.ttsUrl,
        sttUrl: this.plugin.settings.sttUrl,
        onUi: (phase, countdown, activity) => {
          this.voiceOverlay?.setPhase(phase);
          this.voiceOverlay?.setCountdown(countdown);
          this.voiceOverlay?.setActivity(activity);
        },
        onAmp: (amp) => this.voiceOverlay?.setAmp(amp),
        onNotice: (message) => {
          new Notice(`pi: ${message}`, 6000);
        },
        sendText: (t: string) => this.voiceSendText(t),
        abortRun: () => this.store.abort(),
      });
      this.voiceOverlay = new VoiceOverlay({
        handlers: {
          onTap: () => this.voiceController?.tap(),
          onDoubleTap: () => this.voiceController?.doubleTap(),
          onLongPress: () => this.voiceController?.longPress(),
          onLongRelease: (swiped: boolean) =>
            swiped
              ? this.voiceController?.holdCancel()
              : this.voiceController?.longRelease(),
          onStopRun: () => this.voiceController?.stopRun(),
        },
        onFirstGesture: () => this.voiceController?.unlock(),
        apiBase: this.plugin.getClient(this.instanceId).baseUrl,
        cwd: this.store.state.cwd,
        sessionId: this.store.state.sessionId ?? undefined,
        // beta8: pin to the CONTENT area, not the transcript — the transcript's
        // box is a ~108px band on mobile while its content flows past it; the
        // finger was landing ~400px below the gesture surface. The title bar is
        // kept clear of the gesture layer via avoidEl.
        container: this.contentEl,
        extendBottom: Platform.isMobile,
        avoidEl: this.contentEl.querySelector<HTMLElement>(".pi-chat-bar") ?? undefined,
      });
    } catch (e) {
      // Voice mode is optional sugar — its failure must never take the chat down.
      console.error("pi-obsidian voice init failed:", e);
      new Notice(
        `pi voice init failed — ${e instanceof Error ? e.message : String(e)}`,
        10000,
      );
      this.voiceController = null;
      this.voiceOverlay = null;
    }
  }

  private createStore(): AgentStore {
    return new AgentStore(this.plugin.getClient(this.instanceId || undefined), {
      defaultThinkingLevel: this.plugin.settings.defaultThinkingLevel,
      onNotice: (message, type) =>
        new Notice(`pi: ${message}`, type === "error" ? 8000 : 5000),
      onInsertText: (text) => {
        this.inputEl.value = this.inputEl.value
          ? `${this.inputEl.value}\n${text}` : text;
        this.growEditor();
      },
      onSessionRenamed: (_id, name) => this.updateTitle(name),
      onSessionCreated: (info) => {
        this.plugin.settings.lastCwd = info.cwd;
        void this.plugin.saveSettings();
      },
    });
  }

  async onOpen(): Promise<void> {
    // Tool view, not a file view: without this Obsidian's tab/file machinery
    // treats our leaf as "the leaf to navigate in" — the + button and file
    // opens land IN the pi tab (its content shows other tabs' views). Same
    // pattern as graph/kanban views.
    this.navigation = false;
    try {
      // Fresh tabs bind to last-used ?? default machine (Phase 13). Must run
      // before createStore — the store is created against this tab's client.
      if (!this.instanceId) this.instanceId = this.plugin.getInstanceForNewTab().id;
      this.refreshLeafTitle();
      this.store = this.createStore();
      this.attachments = new AttachmentStage({
        upload: (file) => this.plugin.client.uploadAttachment(file),
        onChange: () => this.updateComposerState(),
      });
      this.buildDom();
      void this.initVoice();
      // Tab count follows tab open/close anywhere in the workspace.
      this.registerEvent(
        this.app.workspace.on("layout-change", () => this.updateTabCount())
      );
      // The fixed composer tracks the view rect and hides with the view.
      this.geometryTimer = setInterval(() => {
        const rect = this.contentEl.getBoundingClientRect();
        const shown = this.containerEl.isShown();
        this.voiceOverlay?.syncPosition();
        // Visibility transition = the user switched to this pi tab → it is the
        // panel's target now. Only on the edge (false→true) so two pi panes
        // open side by side on desktop never flip-flop.
        if (shown && !this.prevShownForFocus) this.plugin.setActiveChatView(this);
        this.prevShownForFocus = shown;
        this.composerEl.style.display = shown ? "" : "none";
        if (shown) {
          this.composerEl.style.left = `${Math.round(rect.left)}px`;
          this.composerEl.style.width = `${Math.round(rect.width)}px`;
          this.composerEl.style.bottom = `${composerBottomPx()}px`;
          // Bottom padding as a DIRECT style (0.5.11): three selector/class
          // gates for this failed — platform flags masquerade, env() reads 0
          // in these webviews, and the composer is body-attached so
          // root-scoped selectors can never match it. Phone-class screens get
          // the 1.5u thumb lift when the keyboard is closed; everything else
          // gets the base 10px (equal to the editor↔buttons gap — user spec).
          this.composerEl.style.paddingBottom =
            phoneClassScreen() && readKeyboardHeightPx() <= 0
              ? "calc(var(--input-height, 40px) * 1.5)"
              : "10px";
          // The transcript must END at the composer top — the app's box chain
          // doesn't (it runs behind the composer/navbar and pads for the
          // keyboard). Screen geometry again: content height = composer top.
          const composerTop = this.composerEl.getBoundingClientRect().top;
          this.contentEl.style.height =
            `${Math.max(160, Math.round(composerTop - rect.top - 6))}px`;
        }
      }, 250);
      this.transcript = new TranscriptRenderer(this.transcriptHostEl, {
        app: this.app,
        sourcePath: "",
        component: this,
      });
      void this.plugin.client.getModels().then((models) => {
        this.modelNames = models.models ?? {};
      }).catch(() => {});
      // Panel targeting, interaction signal: whatever pi view the user last
      // touched wins. The composer lives on document.body (outside
      // containerEl) so it needs its own listeners.
      const reportFocus = () => this.plugin.setActiveChatView(this);
      this.registerDomEvent(this.containerEl, "pointerdown", reportFocus);
      this.registerDomEvent(this.containerEl, "focusin", reportFocus);
      this.registerDomEvent(this.composerEl, "pointerdown", reportFocus);
      this.registerDomEvent(this.composerEl, "focusin", reportFocus);
      this.detachKeyboard = attachKeyboardInset(this.contentEl);
      this.unsubscribe = this.store.subscribe(() => {
        try {
          this.render();
        } catch (e) {
          this.showError(e);
        }
      });
      this.render();
      // PHASE-16: setState may have arrived before this point — run the restore
      // now that the store and composer exist (no-op when nothing is pending).
      void this.maybeRestore();
    } catch (e) {
      this.showError(e);
    }
  }

  getViewType(): string {
    return VIEW_TYPE_PI_CHAT;
  }

  getDisplayText(): string {
    // 0.5.6 (user spec): the title says WHERE this session runs — the target
    // instance's device name. "pi" was decoration; the session name is
    // already displayed in the bar below. Obsidian calls this at View.load(),
    // before onOpen/setState assign instanceId — fall back to the instance a
    // fresh tab would use so even the first paint is right.
    const id = this.instanceId || this.plugin.getInstanceForNewTab().id;
    return this.plugin.settings.instances.find((i) => i.id === id)?.name || "pi";
  }

  /** Re-assert the leaf title once the instance is known (0.5.6): Obsidian
   *  sets titleEl from getDisplayText() before instanceId exists and never
   *  re-reads it — set it directly (and ask the leaf to sync its tab header
   *  where that API exists at runtime). */
  private refreshLeafTitle(): void {
    this.titleEl.setText(this.getDisplayText());
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
  }

  getIcon(): string {
    return "message-square";
  }

  async onClose(): Promise<void> {
    this.voiceController?.destroy();
    this.voiceOverlay?.destroy();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.detachKeyboard?.();
    this.detachKeyboard = null;
    if (this.geometryTimer) clearInterval(this.geometryTimer);
    this.geometryTimer = null;

    this.composerEl?.remove();
    this.transcript?.unmount();
    this.store?.destroy();
  }

  // ---------- DOM ----------

  private buildDom(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("pi-chat");
    // Obsidian pads view content at the bottom (mobile reserves navbar /
    // keyboard room there — the "phantom gap" of the keyboard saga). We own
    // the bottom edge: the composer is screen-fixed and the transcript ends
    // at the composer top, so the app's reserve padding is pure dead space.
    // Zeroing it is what full-height plugin views do (obsidian-chatting does
    // the same). Without this the box ends at the composer but the content
    // box ends one reserve-height early — the blank above the composer.
    root.style.paddingBottom = "0px";

    // Session bar (top): plain title + context size. Nothing else earns bar
    // space (0.5.17, user spec): run/compaction state is communicated by the
    // composer and the transcript tail — "running" up here was redundant.
    const bar = root.createDiv({ cls: "pi-chat-bar" });
    this.sessionTitleEl = bar.createEl("h1", { cls: "pi-chat-title", text: "pi" });
    // Double-click (fires for mobile double-tap too) → rename the open
    // session inline, file-explorer style.
    this.registerDomEvent(this.sessionTitleEl, "dblclick", () => this.beginTitleRename());
    this.barSizeEl = bar.createDiv({ cls: "pi-chat-size" });

    // Transcript (middle). React mounts into its own HOST (0.5.23): react-dom's
    // createRoot() CLEARS its container's existing children on first mount —
    // mounting into transcriptEl directly used to silently delete the session
    // loader created alongside it (the "loader never shows" bug). Everything
    // that is not React-rendered must live OUTSIDE the host, as a sibling.
    this.transcriptEl = root.createDiv({ cls: "pi-chat-transcript" });
    this.transcriptHostEl = this.transcriptEl.createDiv({ cls: "pi-transcript-host" });
    // Center-of-screen session loader (0.5.22, user spec): the top-right
    // "loading" status was removed in 0.5.17, so an opening session read as
    // a blank screen. openSession clears messages, so the transcript is empty
    // while loading and this full-height centered child sits mid-screen — no
    // fixed layer, no body-attach quirk.
    this.loaderEl = this.transcriptEl.createDiv({ cls: "pi-session-loader" });
    this.loaderEl.createSpan({ text: "loading" });
    const loaderDots = this.loaderEl.createSpan({ cls: "pi-loader-dots" });
    for (let i = 0; i < 3; i++) loaderDots.createSpan({ text: "." });
    this.loaderEl.style.display = this.store.state.loading ? "" : "none";

    // Composer block: body-attached + fixed (screen geometry — see styles.css).
    const composer = document.body.createDiv({ cls: "pi-chat-composer" });
    this.composerEl = composer;
    // Composer band (0.4.3): [separator line / loading bar] … queued pills …
    // attachment chips … editor … buttons.
    this.queueHostEl = composer.createDiv({ cls: "pi-queue-strip" });
    const chipHost = composer.createDiv({ cls: "pi-attach-host" });
    this.attachments.renderChips(chipHost);
    this.inputEl = composer.createEl("textarea", {
      cls: "pi-chat-input",
      placeholder: Platform.isMobile
        ? "Prompt… (return = newline, send button sends)"
        : "Prompt… (Enter sends, Shift+Enter newline)",
      // textareas default to rows=2 — that intrinsic height would defeat the
      // one-line min-height and become the auto-grow floor
      attr: { rows: "1", enterkeyhint: "enter" },
    });
    this.inputEl.addEventListener("input", () => this.growEditor());
    this.inputEl.addEventListener("keydown", (ev) => {
      // Mobile: the return key inserts a newline (no way to type newlines
      // otherwise) — the send button is the only send path. Desktop keeps the
      // chat convention: Enter sends, Shift+Enter newline. Hardware keyboards
      // on tablets get mobile behavior — accepted tradeoff (Phase 12).
      if (ev.key === "Enter" && !ev.shiftKey && !Platform.isMobile) {
        ev.preventDefault();
        void this.sendCurrent();
      }
    });
    // Paste and drop files into the composer (pi-web parity).
    this.inputEl.addEventListener("paste", (ev) => {
      const files = ev.clipboardData?.files;
      if (files && files.length > 0) {
        ev.preventDefault();
        this.attachments.addFiles(files);
      }
    });

    const row = composer.createDiv({ cls: "pi-chat-row" });
    const left = row.createDiv({ cls: "pi-chat-row-left" });
    this.sendGroupEl = row.createDiv({ cls: "pi-chat-row-right" });
    this.runGroupEl = row.createDiv({ cls: "pi-chat-row-right" });

    // Left: tab count (mobile only), attach, model chip. The include/exclude
    // mentions toggle lives in the panel's controls row now (T40).
    if (Platform.isMobile) this.buildTabButton(left);
    this.attachBtnEl = this.iconButton(left, "paperclip", "Attach files");
    this.attachBtnEl.addEventListener("click", () => this.attachments.pick());

    this.modelChipEl = left.createEl("button", { cls: "pi-model-chip" });
    setIcon(this.modelChipEl.createSpan({ cls: "pi-model-icon" }), "cpu");
    this.modelChipNameEl = this.modelChipEl.createSpan({ cls: "pi-model-name", text: "model" });
    this.modelChipEl.addEventListener("click", (ev) => void this.openModelMenu(ev));

    // Right, idle: send. Right, running: stop + queue.
    this.sendBtnEl = this.iconButton(this.sendGroupEl, "arrow-up", "Send", ["pi-send-btn"]);
    this.sendBtnEl.addEventListener("click", () => void this.sendCurrent());

    this.stopBtnEl = this.runGroupEl.createEl("button", { cls: "pi-stop-btn", text: "Stop" });
    this.stopBtnEl.addEventListener("click", () => {
      // Run Stop doubles as the compaction cancel (0.5.5) — wires the
      // previously-dead abortCompaction.
      const s = this.store.state;
      if (s.agentRunning) void this.store.abort();
      else if (s.isCompacting) void this.store.abortCompaction();
    });

    this.queueBtnEl = this.iconButton(this.runGroupEl, "arrow-right", "Queue (steer)", ["pi-queue-btn"]);
    this.queueBtnEl.addEventListener("click", () => void this.sendCurrent());
  }

  private iconButton(
    parent: HTMLElement, icon: string, label: string, extraCls: string[] = []
  ): HTMLButtonElement {
    const btn = parent.createEl("button", {
      cls: ["pi-icon-btn", ...extraCls].join(" "),
      attr: { "aria-label": label, title: label },
    });
    setIcon(btn, icon);
    return btn;
  }

  /** Mobile composer's far-left button. Press and long-press each run their
   *  configured action (0.5.19): a command (registry id, empty = built-in
   *  default) or a ribbon menu item by label. */
  private buildTabButton(parent: HTMLElement): void {
    const btn = parent.createEl("button", {
      cls: "pi-icon-btn pi-tab-btn",
      attr: { "aria-label": "Tabs", title: "Tabs" },
    });
    this.tabBtnEl = btn;
    this.tabCountEl = btn.createSpan({ cls: "pi-tab-count", text: "0" });
    this.updateTabCount();

    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let longPressed = false;
    const cancelPress = (): void => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
    };

    btn.addEventListener("pointerdown", () => {
      longPressed = false; // only suppresses the click right after a long-press
      cancelPress();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        longPressed = true;
        this.runTabButtonAction("longPress");
      }, 500);
    });
    btn.addEventListener("pointerup", cancelPress);
    btn.addEventListener("pointerleave", cancelPress);
    btn.addEventListener("pointercancel", cancelPress);
    btn.addEventListener("pointermove", cancelPress);
    btn.addEventListener("click", (ev) => {
      if (longPressed) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      this.runTabButtonAction("press");
    });
  }

  /** Run the configured press/long-press action (0.5.19): ribbon item by
   *  label, or a command — an empty id falls back to the built-in default
   *  (press: tab overview, long-press: new tab). */
  private runTabButtonAction(which: "press" | "longPress"): void {
    const s = this.plugin.settings;
    const kind = which === "press" ? s.tabPressKind : s.tabLongPressKind;
    if (kind === "ribbon") {
      const label = which === "press" ? s.tabPressRibbonItem : s.tabLongPressRibbonItem;
      if (label && invokeRibbonItem(label)) return;
      new Notice("pi: ribbon item not found");
      return;
    }
    const explicit = which === "press" ? s.tabPressCommand : s.tabLongPressCommand;
    const id = explicit ||
      (which === "press" ? findTabOverviewCommand(this.app) : findNewTabCommand(this.app));
    if (!id) {
      // Registry-less fallbacks keep the button useful on odd setups.
      if (which === "longPress") {
        this.app.workspace.getLeaf("tab");
        return;
      }
      new Notice("pi: tab overview command not found");
      return;
    }
    if (!executeCommand(this.app, id)) {
      new Notice("pi: command failed");
      return;
    }
    if (!this.tabCommandLogged) {
      this.tabCommandLogged = true;
      console.log(`pi: tab button ${which} -> ${id}`);
    }
  }

  /** Refresh the tab button's count from the workspace's root leaves. */
  /** Refresh the tab button's face. The FACE (0.5.17) is its own setting —
   *  count or icon, independent of the actions — while the aria label
   *  describes the PRESS action. Count and label refresh live via the
   *  layout-change listener; settings flips come through refreshTabButtons. */
  updateTabCount(): void {
    if (!this.tabCountEl) return;
    const ribbonPress = this.plugin.settings.tabPressKind === "ribbon";
    if (this.plugin.settings.tabButtonShowCount) {
      let n = 0;
      this.app.workspace.iterateRootLeaves(() => {
        n++;
      });
      this.tabCountEl.empty();
      this.tabCountEl.setText(String(n));
    } else if (ribbonPress) {
      this.tabCountEl.empty();
      // Mirror the press ribbon item's own icon so the button reads as it.
      const item = listRibbonItems().find(
        (it) => it.label === this.plugin.settings.tabPressRibbonItem
      );
      const svg = item?.el.querySelector("svg");
      if (svg) this.tabCountEl.appendChild(svg.cloneNode(true));
      else setIcon(this.tabCountEl, "zap");
    } else {
      this.tabCountEl.empty();
      setIcon(this.tabCountEl, "square");
    }
    const label = this.tabButtonLabel();
    this.tabBtnEl?.setAttribute("aria-label", label);
    this.tabBtnEl?.setAttribute("title", label);
  }

  /** Label = the press action's name (what a tap does). */
  private tabButtonLabel(): string {
    const s = this.plugin.settings;
    if (s.tabPressKind === "ribbon") {
      return listRibbonItems().find((it) => it.label === s.tabPressRibbonItem)?.label ?? "Ribbon item";
    }
    if (s.tabPressCommand) {
      return listCommands(this.app).find((c) => c.id === s.tabPressCommand)?.name ?? "Command";
    }
    return "Tabs";
  }

  /** Auto-grow editor: 1 row → grows with content → CSS caps it, then scrolls. */
  private growEditor(): void {
    const el = this.inputEl;
    el.style.height = "auto";
    // No +2 anymore: the border is none (0.4.4), and the extra 2px made a
    // one-line editor 2px taller than the 40px button row (0.4.11).
    el.style.height = `${el.scrollHeight}px`;
    this.updateComposerState();
  }

  private updateComposerState(): void {
    const hasText = this.inputEl.value.trim().length > 0;
    const running = this.store.state.agentRunning;
    // Compaction is run-shaped (0.5.5, user spec): sends gray out — steering
    // would interleave with the summary rewrite — and Stop appears to cancel.
    // Only Stop is SHOWN while compacting (0.5.21, user spec): disabled Send
    // and Queue buttons next to it were noise. Steer/follow-up stays visible
    // during normal runs.
    const compacting = this.store.state.isCompacting;
    this.sendBtnEl.disabled = !hasText || compacting;
    this.queueBtnEl.disabled = !hasText || compacting;
    this.queueBtnEl.classList.toggle("has-text", hasText);
    this.sendGroupEl.style.display = running || compacting ? "none" : "";
    this.queueBtnEl.style.display = compacting ? "none" : "";
    this.runGroupEl.style.display = running || compacting ? "" : "none";
  }

  /** Prefix open-file @mentions (pi-web format) when the panel toggle is on
   *  (settings-backed — the panel's controls row owns the write side). */
  private async prependMentions(text: string, cwd: string): Promise<string> {
    if (!this.plugin.settings.includeMentions) return text;
    try {
      const prefix = await resolveServerPath(
        this.plugin.getClient(this.instanceId),
        this.plugin.getInstancePaths(this.instanceId).pathPrefix
      );
      const files = mapServerPaths(collectOpenFiles(this.app), prefix);
      const lines = buildMentionPrefix(files, cwd);
      if (lines.length === 0) return text;
      return `${lines.join("\n")}\n${text}`;
    } catch (e) {
      new Notice(`pi: mentions failed — ${String(e)}`);
      return text;
    }
  }

  // ---------- composer actions ----------

  private async sendCurrent(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const s = this.store.state;

    // pi-web parity: never queue mid-run with staged attachments.
    if (s.agentRunning && this.attachments.staged.length > 0) {
      new Notice("pi: attachments can't be queued while a run is active — send or clear them first");
      return;
    }

    // Stage everything BEFORE clearing the editor so failures keep the draft.
    let prepared: { images: AttachedImageInput[]; prefixLines: string[] };
    try {
      prepared = await this.attachments.prepareSend();
    } catch (e) {
      new Notice(`pi: ${String(e)}`);
      return;
    }
    const withFileLines = (t: string): string =>
      prepared.prefixLines.length ? `${prepared.prefixLines.join("\n")}\n${t}` : t;
    const images = prepared.images.length ? prepared.images : undefined;

    if (!s.sessionId) {
      let cwd = this.pendingCwd;
      if (!cwd) {
        try {
          cwd = await this.plugin.resolveNewSessionCwd(this.instanceId);
        } catch {
          // chain resolution failed — fall back to the explicit-cwd modal
        }
      }
      if (cwd) {
        const finalText = withFileLines(await this.prependMentions(text, cwd));
        this.pendingCwd = null;
        this.inputEl.value = "";
        this.growEditor();
        void this.store.startNewSession(cwd, finalText, images, {
          model: this.plugin.settings.defaultModel ?? undefined,
        });
        return;
      }
      new Notice("pi: could not resolve a working directory for a new session");
      return;
    }

    const finalText = withFileLines(await this.prependMentions(text, s.cwd));
    const outgoing = this.voiceController?.wrapTyped(finalText) ?? finalText;
    this.inputEl.value = "";
    this.growEditor();
    if (s.agentRunning) {
      void this.store.steer(outgoing, images); // Queue button / Enter while running = steer
    } else {
      void this.store.sendPrompt(outgoing, images);
    }
  }

  /** Prepare a new session at the given cwd (no modal); first prompt creates it. */
  prepareNewSession(cwd: string): void {
    if (!this.store) return;
    this.pendingCwd = cwd;
    this.store.reset();
    this.updateTitle(undefined);
    this.inputEl.focus();
  }


  private async openModelMenu(ev: MouseEvent): Promise<void> {
    if (!this.store) return;
    const s = this.store.state;
    const cwd = s.cwd || this.plugin.settings.lastCwd;
    try {
      const models = await this.plugin.client.getModels(cwd);
      const menu = new Menu();
      for (const m of models.modelList ?? []) {
        menu.addItem((item) =>
          item
            .setTitle(`${m.provider}: ${m.name}`)
            .setChecked(
              s.currentModel?.provider === m.provider && s.currentModel?.modelId === m.id
            )
            .onClick(() => void this.store.setModel(m.provider, m.id))
        );
      }
      menu.addSeparator();
      for (const level of THINKING_LEVELS) {
        menu.addItem((item) =>
          item
            .setTitle(`thinking: ${level}`)
            .setChecked(s.thinkingLevel === level)
            .onClick(() => void this.store.setThinkingLevel(level))
        );
      }
      menu.showAtMouseEvent(ev);
    } catch (e) {
      new Notice(`pi: ${String(e)}`);
    }
  }

  // ---------- commands (called from the command palette / ribbon) ----------

  /** Open a session by id (panel-driven). */
  openSessionById(id: string): void {
    if (!this.store) return;
    // Soft guard (Phase 13): session storage is per-machine today, so this
    // should never fire — but if storage is ever shared, two machines writing
    // one session file is a hazard worth a warning.
    const clash = this.plugin
      .getChatViews()
      .find(
        (v) =>
          v !== this &&
          v.getInstanceId() !== this.instanceId &&
          v.getStore()?.state.sessionId === id
      );
    if (clash) {
      new Notice("pi: this session is also open on a tab bound to another machine");
    }
    void this.store.openSession(id);
  }

  /** Store accessor for the pi panel's controls. */
  getStore(): AgentStore | null {
    return this.store ?? null;
  }

  abortRun(): void {
    if (!this.store) return;
    void this.store.abort();
  }

  compactNow(): void {
    if (!this.store) return;
    void this.store.compact();
  }

  /** Hotkey/command entry (0.5.8): "Send prompt" — the bluetooth-keyboard
   *  send path (OSK Enter stays a newline). Empty input no-ops inside. */
  sendPrompt(): void {
    void this.sendCurrent();
  }

  cycleThinking(): void {
    if (!this.store) return;
    const cur = this.store.state.thinkingLevel;
    const next = THINKING_LEVELS[(THINKING_LEVELS.indexOf(cur) + 1) % THINKING_LEVELS.length];
    void this.store.setThinkingLevel(next);
    new Notice(`pi: thinking ${next}`);
  }

  /** Session-bar context size — pi-web's AppShell format translated:
   *  "<current>/<max> | <pct>%", k/M abbreviation per pi-web's fmt, and
   *  pi-web's warning thresholds (>70 warn, >90 crit) on theme colors. */
  /** Queued-message pills (0.4.3): full-width pills above the editor, one per
   *  queued steering/follow-up message, each with a down arrow that returns
   *  that message to the editor. */
  private renderQueue(q: { steering?: string[]; followUp?: string[] } | null): void {
    const host = this.queueHostEl;
    host.empty();
    const items: Array<{ kind: "steering" | "followUp"; index: number; text: string }> = [];
    (q?.steering ?? []).forEach((text, index) => items.push({ kind: "steering", index, text }));
    (q?.followUp ?? []).forEach((text, index) => items.push({ kind: "followUp", index, text }));
    for (const item of items) {
      const pill = host.createDiv({ cls: "pi-queue-pill" });
      pill.createDiv({ cls: "pi-queue-text", text: item.text });
      const btn = pill.createEl("button", {
        cls: "pi-queue-recall",
        attr: { "aria-label": "Return to editor", title: "Return to editor" },
      });
      setIcon(btn, "arrow-down");
      btn.addEventListener("click", () => void this.recallQueueItem(item));
    }
  }

  private async recallQueueItem(item: { kind: "steering" | "followUp"; index: number; text: string }): Promise<void> {
    const text = await this.store.recallQueueItem(item.kind, item.index);
    if (text === null) return;
    this.inputEl.value = this.inputEl.value.trim() ? `${this.inputEl.value}\n${text}` : text;
    this.growEditor();
    this.inputEl.focus();
  }

  /** pi-web's composer insertIfEmpty — used by message "edit from here". */
  insertIntoComposer(text: string): void {
    if (this.inputEl.value.trim()) return;
    this.inputEl.value = text;
    this.growEditor();
    this.inputEl.focus();
  }

  private renderContextSize(
    cu: { percent: number | null; contextWindow: number; tokens: number | null } | null
  ): void {
    const el = this.barSizeEl;
    if (!cu?.contextWindow) {
      el.setText("");
      return;
    }
    const fmt = (n: number) =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
    const cur = cu.tokens !== null ? fmt(cu.tokens) : "?";
    const pct = cu.percent !== null ? ` | ${cu.percent.toFixed(0)}%` : "";
    el.setText(`${cur}/${fmt(cu.contextWindow)}${pct}`);
    el.removeClass("pi-ctx-warn", "pi-ctx-crit");
    if (cu.percent !== null && cu.percent > 90) el.addClass("pi-ctx-crit");
    else if (cu.percent !== null && cu.percent > 70) el.addClass("pi-ctx-warn");
  }

  // ---------- rendering ----------

  private render(): void {
    const s = this.store.state;

    this.updateTitle(s.sessionName);
    this.renderContextSize(s.contextUsage);
    this.renderQueue(s.queuedMessages);
    // Working indicator: bouncing line on the composer's top border (styles.css).
    this.composerEl.toggleClass("pi-working", s.agentRunning || s.isCompacting);

    this.modelChipNameEl.setText(
      s.currentModel?.modelId ?? this.plugin.settings.defaultModel?.modelId ?? "model"
    );
    this.updateComposerState();
    this.updateTabCount();

    const stick = this.isNearBottom();

    // Session open/switch: scroll to the end once messages land (loading
    // true→false), and when the session id itself changes. Streaming
    // auto-scroll (the `stick` branch above) is untouched.
    const sessionChanged = this.prevSessionIdForScroll !== s.sessionId;
    const loadSettled = this.prevLoadingForScroll && !s.loading;
    // Loader follows the loading flag (toggle only on change — this handler
    // runs on every store update).
    if (s.loading !== this.prevLoadingForScroll) {
      this.loaderEl.style.display = s.loading ? "" : "none";
    }
    this.prevSessionIdForScroll = s.sessionId;
    this.prevLoadingForScroll = s.loading;
    if (sessionChanged || loadSettled) {
      this.pinBottomUntil = Date.now() + 1400;
      // Timed passes cover growth that happens without React commits (async
      // markdown rendering mutates the DOM directly).
      for (const ms of [150, 400, 800, 1300]) {
        setTimeout(() => {
          if (Date.now() <= this.pinBottomUntil) {
            this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
          }
        }, ms);
      }
    }

    // pi-web's MessageView components render the grouped units (see
    // react/Transcript.tsx + views/message-display.ts).
    this.transcript.update({
      units: computeTranscriptUnits(
        s.messages.map((m, i) => {
          const stripped = stripMessageVoiceBlocks(m);
          // Fresh compaction estimate rides on its message for the caret header
          // (0.5.5): historical blocks fall back to tokensBefore only.
          if (
            i === s.messages.length - 1 &&
            s.compactResult &&
            stripped.role === "custom" &&
            (stripped as CustomMessage).customType === "compaction"
          ) {
            return {
              ...stripped,
              details: {
                ...((stripped as CustomMessage).details as Record<string, unknown> | undefined),
                estimatedTokensAfter: s.compactResult.estimatedTokensAfter,
              },
            };
          }
          return stripped;
        }),
        s.agentRunning,
        s.entryIds,
      ),
      streaming: s.streamingMessage ? stripMessageVoiceBlocks(s.streamingMessage) : null,
      modelNames: this.modelNames,
      cwd: s.cwd,
      sessionId: s.sessionId ?? undefined,
      runError: s.runError,
      compacting: s.isCompacting,
      compactResult: s.compactResult,
      apiBase: this.plugin.getClient(this.instanceId).baseUrl,
      speak: this.speakController,
      onFork: async (entryId: string) => { const id = await this.store.fork(entryId); if (id) void this.store.openSession(id); return id; },
      onNavigate: (entryId: string) => { void this.store.navigateTo(entryId); },
      onEditContent: (content: string) => this.insertIntoComposer(stripVoiceBlocks(content)),
      onRendered: () => {
        // Fires after React commits — the only moment scrollHeight is real.
        if (Date.now() <= this.pinBottomUntil) {
          this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
        }
      },
    });

    this.voiceOverlay?.setLastMessage(
      [...s.messages].reverse().find((m) => m.role === "assistant") ?? null,
      s.streamingMessage,
    );

    if (stick || sessionChanged || loadSettled) {
      requestAnimationFrame(() => {
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
      });
    }
  }

  private isNearBottom(): boolean {
    const el = this.transcriptEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  /** Paint failures INTO the view — a blank pane hides the bug (iOS has no console). */
  private showError(e: unknown): void {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error("pi-obsidian view error:", msg);
    this.contentEl.empty();
    this.contentEl.createEl("pre", { cls: "pi-error-panel" }).setText(
      `pi-obsidian failed to render (v${this.plugin.manifest.version} (${BUILD_ID})):\n\n${msg}`
    );
  }

  private updateTitle(name: string | undefined): void {
    // While the inline rename input is open it owns the title — a store
    // update must not stomp it (the input keeps whatever the user typed).
    if (this.renameInputEl) return;
    const s = this.store.state;
    const first = stripVoiceBlocks(s.firstMessage).slice(0, 60);
    let text: string;
    let isPath = false;
    if (name) text = name;
    else if (s.sessionName) text = s.sessionName;
    else if (first) text = first;
    else if (this.pendingCwd) {
      // 0.5.19 (user spec): a new session shows ONLY its cwd path — "new
      // session ·" was wasted space — and the far-right directory must stay
      // visible, so the cut is CSS left-ellipsis (.pi-title-path), not a
      // char cap (a cap can't know the bar's width — 0.5.20 fix).
      text = pathTitle(this.pendingCwd);
      isPath = true;
    } else {
      text = "new session";
    }
    this.sessionTitleEl.toggleClass("pi-title-path", isPath);
    this.sessionTitleEl.setText(text);
  }

  /** Title-bar double-click → inline rename of the OPEN session: same input
   *  and Enter/blur/Escape semantics as the panel's session rows; commits via
   *  the store, which renames the active session and updates its own
   *  sessionName (→ render() repaints the new title once the input closes). */
  private beginTitleRename(): void {
    if (this.renameInputEl) return;
    const store = this.store;
    if (!store?.state.sessionId) return; // nothing open to rename
    // Pin the session the rename started for: a session switch under the
    // input must not rename the session that took over the tab.
    const sid = store.state.sessionId;
    const title = this.sessionTitleEl;
    const initial = title.textContent ?? "";
    title.empty();
    const input = title.createEl("input", { cls: "pi-session-rename", value: initial });
    this.renameInputEl = input;
    let finished = false;
    const finish = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      this.renameInputEl = null; // updateTitle() may paint again
      title.setText(initial); // restore the old title while the store round-trips
      if (commit && value && value !== initial && store.state.sessionId === sid) {
        void store.renameSession(value);
      }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("dblclick", (ev) => ev.stopPropagation());
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
  }
}
