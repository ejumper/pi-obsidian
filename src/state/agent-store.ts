// Protocol state store for one pi session — a framework-agnostic port of the
// semantics in pi-web's hooks/useAgentSession.ts. Views subscribe and render
// `store.state`; all server interaction flows through here.
//
// Semantics preserved from pi-web (do not "simplify" away):
//  - messages[] holds COMMITTED messages only; the in-flight assistant message
//    lives in `streamingMessage` as cumulative snapshots (the wire resends the
//    full message on every message_update) and is committed on message_end.
//  - Optimistic user bubble with content-key dedupe: the run's own prompt echo
//    (user message_end) replaces the adjacent optimistic bubble; later queue
//    deliveries of the same text must still render.
//  - Late-event guards: streaming events after the run finished are dropped
//    (they would resurrect ghost bubbles after a reconcile).
//  - System messages (pi 1.3 section deltas) are never rendered.
//  - Lazy session creation: ensure_session → connect SSE → prompt (so no early
//    events are missed). A failed send rolls the optimistic bubble back.
//  - Reconciliation net: 15s state poll while running + visibilitychange +
//    online; if the server is idle while we think it is running, finish the
//    run through the same path as prompt_done.

import { PiClient, PiApiError } from "../api/client";
import { openSse, type SseHandle } from "../api/sse";
import type {
  AgentCommand,
  AgentMessage,
  AgentRuntimeState,
  AnyAgentFrame,
  AttachedImageInput,
  ExtensionStatusItem,
  ExtensionUiCustomRequest,
  ExtensionUiDialogRequest,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
} from "../api/types";

// ---------- constants (ported from useAgentSession) ----------

const AGENT_STATE_RECONCILE_MS = 15_000;
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 5_000;
const RECONNECT_DELAY_MS = 1_000;
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;

// ---------- public types ----------

export type ThinkingLevelOption =
  | "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

export interface CompactResultInfo {
  reason: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export type NoticeType = "info" | "success" | "warning" | "error";

export interface StoreState {
  sessionId: string | null;
  loading: boolean;
  error: string | null;
  /** Session is owned by a running terminal pi (live-bridge) — read-only tail. */
  live: boolean;
  cwd: string;
  filePath: string;
  sessionName: string | undefined;
  messages: AgentMessage[];
  entryIds: string[];
  streamingMessage: AgentMessage | null;
  agentRunning: boolean;
  agentPhase: AgentPhase;
  queuedMessages: QueuedMessages;
  isCompacting: boolean;
  compactResult: CompactResultInfo | null;
  compactError: string | null;
  retryInfo: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  thinkingLevel: ThinkingLevelOption;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  currentModel: { provider: string; modelId: string } | null;
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  extensionDialog: ExtensionUiDialogRequest | null;
  extensionCustomUi: ExtensionUiCustomRequest | null;
  extensionStatuses: ExtensionStatusItem[];
  extensionWidgets: ExtensionWidgetItem[];
  externalQueued: boolean;
}

export interface AgentStoreHooks {
  onNotice?: (message: string, type: NoticeType) => void;
  onSessionCreated?: (info: SessionInfo) => void;
  onSessionRenamed?: (sessionId: string, name: string | undefined) => void;
  /** extension `set_editor_text` — insert into the composer. */
  onInsertText?: (text: string) => void;
  onAgentEnd?: () => void;
}

// ---------- message helpers (ported from pi-web lib/normalize + hook) ----------

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/** Normalize toolCall blocks (id/name/arguments aliases) before storing. */
export function normalizeToolCalls(msg: AgentMessage): AgentMessage {
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;
  const content = msg.content.map((block) => {
    if (!isObject(block) || block.type !== "toolCall") return block;
    const b = block as Record<string, unknown>;
    return {
      type: "toolCall" as const,
      toolCallId: typeof b.toolCallId === "string" ? b.toolCallId : (typeof b.id === "string" ? b.id : ""),
      toolName: typeof b.toolName === "string" ? b.toolName : (typeof b.name === "string" ? b.name : ""),
      input: isObject(b.input) ? b.input : (isObject(b.arguments) ? b.arguments : {}),
    };
  });
  return { ...msg, content } as AgentMessage;
}

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      isObject(block) && block.type === "text" && typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!isObject(block) || block.type !== "image") return "";
  const source = block.source;
  if (isObject(source)) {
    return [
      source.type === "url" ? "url" : "base64",
      typeof source.media_type === "string" ? source.media_type : "",
      typeof source.data === "string" ? source.data : "",
      typeof source.url === "string" ? source.url : "",
    ].join(":");
  }
  return ["base64", typeof block.mimeType === "string" ? block.mimeType : "",
    typeof block.data === "string" ? block.data : "", ""].join(":");
}

/** Content identity key for optimistic-user-bubble dedupe. */
export function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!isObject(result)) return null;
  const before = result.tokensBefore;
  const after = result.estimatedTokensAfter;
  if (typeof before !== "number" || typeof after !== "number") return null;
  return { reason, tokensBefore: before, estimatedTokensAfter: after };
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- the store ----------

export class AgentStore {
  private listeners = new Set<() => void>();
  private sse: SseHandle | null = null;
  private sseConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private runId = 0;
  private optimisticUserMessageKey: string | null = null;
  private ensuringSession: Promise<string | null> | null = null;
  private seenEntryIds = new Set<string>();
  private destroyed = false;

  private readonly onVisible = () => {
    if (document.visibilityState === "visible") void this.reconcile();
  };
  private readonly onOnline = () => void this.reconcile();

  constructor(
    private client: PiClient,
    private hooks: AgentStoreHooks = {}
  ) {
    document.addEventListener("visibilitychange", this.onVisible);
    window.addEventListener("online", this.onOnline);
  }

  state: StoreState = {
    sessionId: null,
    loading: false,
    error: null,
    live: false,
    cwd: "",
    filePath: "",
    sessionName: undefined,
    messages: [],
    entryIds: [],
    streamingMessage: null,
    agentRunning: false,
    agentPhase: null,
    queuedMessages: { steering: [], followUp: [] },
    isCompacting: false,
    compactResult: null,
    compactError: null,
    retryInfo: null,
    thinkingLevel: "auto",
    contextUsage: null,
    currentModel: null,
    tree: [],
    activeLeafId: null,
    extensionDialog: null,
    extensionCustomUi: null,
    extensionStatuses: [],
    extensionWidgets: [],
    externalQueued: false,
  };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.destroyed = true;
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("online", this.onOnline);
    this.closeStream();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    this.listeners.clear();
  }

  private update(patch: Partial<StoreState>): void {
    Object.assign(this.state, patch);
    for (const l of this.listeners) l();
    this.syncReconcileTimer();
  }

  /** The reconcile interval only runs while the agent is running (pi-web parity). */
  private syncReconcileTimer(): void {
    if (this.state.agentRunning && !this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => void this.reconcile(), AGENT_STATE_RECONCILE_MS);
    } else if (!this.state.agentRunning && this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  // ---------- session lifecycle ----------

  /** Open a session: history + state, then subscribe if anything is running. */
  async openSession(id: string): Promise<void> {
    this.closeStream();
    this.runId++;
    this.optimisticUserMessageKey = null;
    this.update({
      sessionId: id,
      loading: true,
      error: null,
      messages: [],
      entryIds: [],
      streamingMessage: null,
      agentRunning: false,
      agentPhase: null,
      queuedMessages: { steering: [], followUp: [] },
      isCompacting: false,
      retryInfo: null,
    });

    try {
      const d = await this.client.getSession(id);
      if (this.state.sessionId !== id) return;
      this.seenEntryIds = new Set(d.context.entryIds ?? []);
      const patch: Partial<StoreState> = {
        loading: false,
        live: !!d.live,
        messages: d.context.messages,
        entryIds: d.context.entryIds ?? [],
        tree: d.tree,
        activeLeafId: d.leafId,
        cwd: d.info?.cwd ?? d.filePath,
        filePath: d.filePath,
        sessionName: d.info?.name,
      };
      if (d.context.model) patch.currentModel = d.context.model;
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        patch.thinkingLevel = d.context.thinkingLevel as ThinkingLevelOption;
      }
      this.update(patch);

      if (d.live) {
        this.connectStream(id, "live");
        return;
      }

      const agentState = await this.client.getState(id);
      if (this.state.sessionId !== id) return;
      this.applyRuntimeState(agentState);

      if (agentState.running && agentState.state) {
        const s = agentState.state;
        if (s.isStreaming || s.isPromptRunning) {
          this.update({
            agentRunning: true,
            agentPhase: s.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" },
          });
          this.connectStream(id, "agent");
          if (!s.isStreaming && s.isPromptRunning) void this.waitForPromptSettlement(id);
        }
      }
    } catch (e) {
      if (this.state.sessionId !== id) return;
      this.update({ loading: false, error: String(e) });
    }
  }

  /** Start a brand-new session and send the first prompt (lazy create flow). */
  async startNewSession(
    cwd: string,
    message: string,
    images?: AttachedImageInput[],
    opts?: { model?: { provider: string; modelId: string }; thinkingLevel?: string }
  ): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed && !images?.length) return;

    const userMsg = this.appendOptimisticUser(trimmed, images);
    const runId = ++this.runId;
    this.update({ agentRunning: true, agentPhase: { kind: "waiting_model" }, error: null });

    try {
      const sid = await this.ensureSession(cwd, opts);
      if (!sid) throw new Error("Session creation returned no id");
      await this.ensureConnected(sid);
      await this.client.sendCommand(sid, {
        type: "prompt",
        message: trimmed,
        ...(images?.length ? { images } : {}),
      });
      this.hooks.onSessionCreated?.({
        id: sid, path: "", cwd, name: undefined,
        created: new Date().toISOString(), modified: new Date().toISOString(),
        messageCount: 1, firstMessage: trimmed || "(no messages)",
      });
    } catch (e) {
      this.rollbackOptimisticUser(userMsg);
      if (runId === this.runId) {
        this.update({ agentRunning: false, agentPhase: null, streamingMessage: null });
      }
      this.hooks.onNotice?.(`Message not sent — ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  /** Send a prompt on the open session (refuses while running — use steer/followUp). */
  async sendPrompt(message: string, images?: AttachedImageInput[]): Promise<void> {
    const sid = this.state.sessionId;
    const trimmed = message.trim();
    if (!sid || this.state.live) return;
    if (!trimmed && !images?.length) return;
    if (this.state.agentRunning) return;

    const userMsg = this.appendOptimisticUser(trimmed, images);
    ++this.runId;
    this.update({ agentRunning: true, agentPhase: { kind: "waiting_model" } });

    try {
      await this.ensureConnected(sid);
      await this.client.sendCommand(sid, {
        type: "prompt",
        message: trimmed,
        ...(images?.length ? { images } : {}),
      });
    } catch (e) {
      this.rollbackOptimisticUser(userMsg);
      this.update({ agentRunning: false, agentPhase: null, streamingMessage: null });
      this.hooks.onNotice?.(`Message not sent — ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  /** Steer the running agent. No optimistic bubble — the delivery echo renders. */
  async steer(message: string, images?: AttachedImageInput[]): Promise<void> {
    await this.sendSimple({ type: "steer", message, ...(images?.length ? { images } : {}) },
      "Steer message not sent");
  }

  /** Queue a follow-up for after the current run. */
  async followUp(message: string, images?: AttachedImageInput[]): Promise<void> {
    await this.sendSimple({ type: "follow_up", message, ...(images?.length ? { images } : {}) },
      "Follow-up not queued");
  }

  /** Queue a prompt with streaming behavior (steer|followUp semantics server-side). */
  async queuePrompt(message: string, behavior: "steer" | "followUp"): Promise<void> {
    await this.sendSimple({ type: "prompt", message, streamingBehavior: behavior },
      "Message not queued");
  }

  async abort(): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid) return;
    await this.sendSimple({ type: "abort" }, "Abort failed", false);
  }

  async compact(customInstructions?: string): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid || this.state.isCompacting) return;
    this.update({ isCompacting: true, compactError: null, compactResult: null });
    try {
      const result = await this.client.sendCommand(sid, {
        type: "compact", ...(customInstructions ? { customInstructions } : {}),
      });
      const info = readCompactResult(result.data, "manual");
      if (info) this.update({ compactResult: info });
      await this.refreshFromDisk();
    } catch (e) {
      this.update({ compactError: e instanceof Error ? e.message : String(e) });
    } finally {
      this.update({ isCompacting: false });
    }
  }

  async abortCompaction(): Promise<void> {
    await this.sendSimple({ type: "abort_compaction" }, "Abort compaction failed", false);
  }

  /** clear_queue + put the recalled texts where the composer can use them. */
  async recallQueue(): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid) return;
    try {
      const result = await this.client.sendCommand(sid, { type: "clear_queue" });
      this.update({ queuedMessages: { steering: [], followUp: [] } });
      const q = result.data as { steering?: string[]; followUp?: string[] } | null;
      const texts = [...(q?.steering ?? []), ...(q?.followUp ?? [])];
      if (texts.length > 0) this.hooks.onInsertText?.(texts.join("\n\n"));
    } catch {
      this.hooks.onNotice?.("Failed to recall queued messages", "error");
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const sid = this.state.sessionId;
    this.update({ currentModel: { provider, modelId } });
    if (!sid) return;
    await this.sendSimple({ type: "set_model", provider, modelId }, "Failed to set model", false);
  }

  async setThinkingLevel(level: ThinkingLevelOption): Promise<void> {
    this.update({ thinkingLevel: level });
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = this.state.sessionId;
    if (!sid) return;
    await this.sendSimple({ type: "set_thinking_level", level }, "Failed to set thinking level", false);
  }

  async fork(entryId: string): Promise<string | null> {
    const sid = this.state.sessionId;
    if (!sid) return null;
    try {
      const result = await this.client.sendCommand(sid, { type: "fork", entryId });
      const r = result.data as { cancelled?: boolean; newSessionId?: string } | null;
      return r?.cancelled ? null : (r?.newSessionId ?? null);
    } catch {
      this.hooks.onNotice?.("Fork failed", "error");
      return null;
    }
  }

  /** Branch navigation (store-level; tree UI lands in a later phase). */
  async navigateTo(entryId: string): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid) return;
    this.update({ activeLeafId: entryId });
    void this.client.sendCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    try {
      const d = await this.client.getSessionContext(sid, entryId);
      if (this.state.sessionId !== sid) return;
      this.update({ messages: d.context.messages, entryIds: d.context.entryIds ?? [] });
    } catch {
      this.hooks.onNotice?.("Failed to load branch", "error");
    }
  }

  async renameSession(name: string): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid) return;
    await this.sendSimple({ type: "set_session_name", name }, "Rename failed", false);
    this.update({ sessionName: name });
  }

  // ---------- extension UI responses (state kept; panel UI is Phase 2) ----------

  async respondExtensionUi(
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true }
  ): Promise<void> {
    const sid = this.state.sessionId;
    this.update({
      extensionDialog: this.state.extensionDialog?.id === request.id ? null : this.state.extensionDialog,
    });
    if (!sid) return;
    await this.sendSimple(
      { type: "extension_ui_response", id: request.id, ...response }, "Extension response failed", false);
  }

  async sendExtensionCustomInput(request: ExtensionUiCustomRequest, data: string): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid) return;
    await this.sendSimple({ type: "extension_ui_input", id: request.id, data }, "Extension input failed", false);
  }

  async sendExtensionCustomFocus(
    request: ExtensionUiCustomRequest, flags: { focused?: boolean; hidden?: boolean }
  ): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid) return;
    await this.sendSimple(
      { type: "extension_ui_focus", id: request.id, ...flags }, "Extension focus failed", false);
  }

  async sendExtensionCustomResize(request: ExtensionUiCustomRequest, cols: number): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid) return;
    await this.sendSimple({ type: "extension_ui_resize", id: request.id, cols }, "Extension resize failed", false);
  }

  // ---------- internals ----------

  private async sendSimple(
    cmd: AgentCommand, errorPrefix: string, notify = true
  ): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid) return;
    try {
      await this.client.sendCommand(sid, cmd);
    } catch (e) {
      if (notify) {
        this.hooks.onNotice?.(`${errorPrefix} — ${e instanceof Error ? e.message : String(e)}`, "error");
      } else {
        console.error(`${errorPrefix}:`, e);
      }
    }
  }

  private appendOptimisticUser(message: string, images?: AttachedImageInput[]): AgentMessage {
    const imageBlocks = images?.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mimeType, data: img.data },
    }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    this.optimisticUserMessageKey = userMessageKey(userMsg);
    this.update({ messages: [...this.state.messages, userMsg] });
    return userMsg;
  }

  private rollbackOptimisticUser(userMsg: AgentMessage): void {
    const key = this.optimisticUserMessageKey;
    this.optimisticUserMessageKey = null;
    if (!key) return;
    const messages = this.state.messages;
    const last = messages[messages.length - 1];
    if (last === userMsg || (last?.role === "user" && userMessageKey(last) === key)) {
      this.update({ messages: messages.slice(0, -1) });
    }
  }

  /** Lazy session creation (ensure_session), mirroring pi-web's ensureNewSession. */
  private async ensureSession(
    cwd: string,
    opts?: { model?: { provider: string; modelId: string }; thinkingLevel?: string }
  ): Promise<string | null> {
    if (this.state.sessionId) return this.state.sessionId;
    if (this.ensuringSession) return this.ensuringSession;

    const promise = (async () => {
      const { sessionId } = await this.client.createSession(cwd, {
        type: "ensure_session",
        ...(opts?.model ? { provider: opts.model.provider, modelId: opts.model.modelId } : {}),
        ...(opts?.thinkingLevel && opts.thinkingLevel !== "auto" ? { thinkingLevel: opts.thinkingLevel } : {}),
      });
      this.update({
        sessionId,
        cwd,
        messages: this.state.messages, // keep the optimistic bubble
        live: false,
      });
      return sessionId;
    })();

    this.ensuringSession = promise;
    try {
      return await promise;
    } finally {
      this.ensuringSession = null;
    }
  }

  // ---------- SSE stream ----------

  private closeStream(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sse?.close();
    this.sse = null;
    this.sseConnected = false;
  }

  private async ensureConnected(sid: string): Promise<void> {
    if (this.sse && this.sseConnected && this.state.sessionId === sid) return;
    this.connectStream(sid, this.state.live ? "live" : "agent");
    const deadline = Date.now() + EVENT_STREAM_CONNECT_TIMEOUT_MS;
    while (!this.sseConnected && Date.now() < deadline) {
      await delay(50);
    }
    if (!this.sseConnected) {
      this.closeStream();
      throw new Error("Timed out connecting to the agent event stream.");
    }
  }

  private connectStream(sid: string, mode: "agent" | "live"): void {
    this.closeStream();
    const base = this.client.baseUrl;
    const url = mode === "live"
      ? `${base}/api/live/${encodeURIComponent(sid)}/events`
      : `${base}/api/agent/${encodeURIComponent(sid)}/events`;

    this.sse = openSse(url, {
      onFrame: (_name, data) => {
        this.sseConnected = true;
        this.handleFrame(data);
      },
      onError: (err) => {
        console.error("[pi-obsidian] SSE error:", err.message);
        this.handleStreamDown(sid, mode);
      },
      onClose: () => {
        this.sseConnected = false;
        this.handleStreamDown(sid, mode);
      },
    });
  }

  /** Fatal stream loss while work is pending → manual reconnect (pi-web parity). */
  private handleStreamDown(sid: string, mode: "agent" | "live"): void {
    if (this.destroyed) return;
    if (this.state.sessionId !== sid) return;
    if (!this.state.agentRunning && !this.state.live) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state.sessionId === sid && (this.state.agentRunning || this.state.live)) {
        this.connectStream(sid, mode);
      }
    }, RECONNECT_DELAY_MS);
  }

  // ---------- event handling (port of handleAgentEvent) ----------

  private handleFrame(data: unknown): void {
    const ev = data as AnyAgentFrame;
    switch (ev.type) {
      case "agent_start":
        this.update({ agentRunning: true, agentPhase: { kind: "waiting_model" }, streamingMessage: null });
        break;

      case "agent_end": {
        // Late agent_end after reconcile already finished → don't re-trigger.
        if (!this.state.agentRunning) break;
        this.finishRun();
        void this.refreshFromDisk();
        break;
      }

      case "prompt_done":
        if (!this.state.agentRunning) break;
        this.finishRun();
        void this.refreshFromDisk();
        break;

      case "prompt_error":
        this.hooks.onNotice?.(
          (ev as { errorMessage?: string }).errorMessage ?? "Command failed", "error");
        break;

      case "extension_error": {
        const e = ev as { extensionPath?: string; event?: string; error?: string };
        const label = e.extensionPath ? (e.extensionPath.split("/").pop() || e.extensionPath) : "extension";
        const where = e.event ? `${label} · ${e.event}` : label;
        this.hooks.onNotice?.(`[${where}] ${e.error ?? "Extension command failed"}`, "error");
        break;
      }

      case "message_start":
      case "message_update": {
        // Late-event guard: drop streaming events after the run finished.
        if (!this.state.agentRunning && !this.state.live) break;
        const msg = (ev as { message?: AgentMessage }).message;
        if (!msg || msg.role === "user") break;
        this.update({ streamingMessage: normalizeToolCalls(msg), agentPhase: null });
        break;
      }

      case "message_end": {
        if (!this.state.agentRunning && !this.state.live) break;
        const completed = (ev as { message?: AgentMessage }).message;
        if (!completed || completed.role === "system") break; // pi 1.3 section delta — never render

        if (this.state.live) {
          // Tail mode: dedupe entries that landed between history-read and subscribe.
          const entryId = (ev as { entryId?: string }).entryId;
          if (entryId) {
            if (this.seenEntryIds.has(entryId)) break;
            this.seenEntryIds.add(entryId);
          }
          this.update({
            messages: [...this.state.messages, normalizeToolCalls(completed)],
            streamingMessage: null,
          });
          break;
        }

        const delivered = normalizeToolCalls(completed);
        if (completed.role === "user") {
          // Consume the still-adjacent optimistic bubble; later same-text queue
          // deliveries must render as their own messages.
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = this.optimisticUserMessageKey;
          this.optimisticUserMessageKey = null;
          const prev = this.state.messages;
          const last = prev[prev.length - 1];
          if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
            this.update({
              messages: optimisticKey === deliveredKey ? prev : [...prev.slice(0, -1), delivered],
              streamingMessage: null,
            });
          } else {
            this.update({ messages: [...prev, delivered], streamingMessage: null });
          }
        } else {
          this.update({
            messages: [...this.state.messages, delivered],
            streamingMessage: null,
          });
        }
        this.update({ agentPhase: { kind: "waiting_model" } });
        break;
      }

      case "tool_execution_start": {
        const { toolCallId: id, toolName: name } = ev as { toolCallId: string; toolName: string };
        const prev = this.state.agentPhase;
        const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
        if (!tools.some((t) => t.id === id)) tools.push({ id, name });
        this.update({ agentPhase: { kind: "running_tools", tools } });
        break;
      }

      case "tool_execution_end": {
        const id = (ev as { toolCallId?: string }).toolCallId;
        const prev = this.state.agentPhase;
        if (prev?.kind !== "running_tools") break;
        const tools = prev.tools.filter((t) => t.id !== id);
        this.update({
          agentPhase: tools.length === 0 ? { kind: "waiting_model" } : { kind: "running_tools", tools },
        });
        break;
      }

      case "queue_update":
        this.update({
          queuedMessages: {
            steering: [...((ev as { steering?: string[] }).steering ?? [])],
            followUp: [...((ev as { followUp?: string[] }).followUp ?? [])],
          },
        });
        break;

      case "queue_pending":
        if (this.state.live) {
          this.update({ externalQueued: (ev as { pending?: boolean }).pending === true });
        }
        break;

      case "session_info_changed": {
        const name = (ev as { name?: string }).name;
        if (this.state.sessionId) this.hooks.onSessionRenamed?.(this.state.sessionId, name);
        this.update({ sessionName: name });
        break;
      }

      case "auto_retry_start": {
        const e = ev as { attempt?: number; maxAttempts?: number; errorMessage?: string };
        this.update({
          retryInfo: { attempt: e.attempt ?? 0, maxAttempts: e.maxAttempts ?? 0, errorMessage: e.errorMessage },
        });
        break;
      }
      case "auto_retry_end":
        this.update({ retryInfo: null });
        break;

      case "auto_compaction_start":
      case "compaction_start":
        this.update({ isCompacting: true, compactError: null, compactResult: null });
        break;

      case "auto_compaction_end":
      case "compaction_end": {
        const e = ev as { result?: unknown; aborted?: boolean; errorMessage?: string; reason?: string };
        const patch: Partial<StoreState> = { isCompacting: false };
        if (e.errorMessage) {
          patch.compactError = e.errorMessage;
          patch.compactResult = null;
        } else if (!e.aborted) {
          patch.compactResult = readCompactResult(e.result, e.reason ?? "auto");
          void this.refreshFromDisk();
        }
        this.update(patch);
        break;
      }

      case "extension_ui_request":
        this.handleExtensionUiRequest(ev as ExtensionUiRequest);
        break;

      default:
        break; // unknown frames ignored by design
    }
  }

  private handleExtensionUiRequest(request: ExtensionUiRequest): void {
    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        this.update({ extensionDialog: request });
        break;
      case "notify":
        this.hooks.onNotice?.(request.message, request.notifyType ?? "info");
        break;
      case "setStatus": {
        const rest = this.state.extensionStatuses.filter((i) => i.key !== request.statusKey);
        this.update({
          extensionStatuses: request.statusText
            ? [...rest, { key: request.statusKey, text: request.statusText }] : rest,
        });
        break;
      }
      case "setWidget": {
        const rest = this.state.extensionWidgets.filter((i) => i.key !== request.widgetKey);
        this.update({
          extensionWidgets: request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest,
        });
        break;
      }
      case "setTitle":
        break; // Obsidian owns the window title; skip
      case "set_editor_text":
        this.hooks.onInsertText?.(request.text);
        break;
      case "custom":
        this.update({
          extensionCustomUi: request.closed
            ? (this.state.extensionCustomUi?.id === request.id ? null : this.state.extensionCustomUi)
            : request,
        });
        break;
    }
  }

  // ---------- completion + reconciliation ----------

  private finishRun(): void {
    this.update({
      agentRunning: false,
      agentPhase: null,
      retryInfo: null,
      streamingMessage: null,
    });
    this.hooks.onAgentEnd?.();
  }

  /** Reload messages from the session file (post-run / post-compaction truth). */
  private async refreshFromDisk(): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid) return;
    try {
      const d = await this.client.getSession(sid);
      if (this.state.sessionId !== sid) return;
      this.seenEntryIds = new Set(d.context.entryIds ?? []);
      const patch: Partial<StoreState> = {
        messages: d.context.messages,
        entryIds: d.context.entryIds ?? [],
        tree: d.tree,
        activeLeafId: d.leafId,
        sessionName: d.info?.name,
      };
      if (d.context.model) patch.currentModel = d.context.model;
      this.update(patch);
    } catch {
      // keep current view; next reconcile retries
    }
  }

  private applyRuntimeState(agentState: { running: boolean; state?: AgentRuntimeState }): void {
    const s = agentState.state;
    const patch: Partial<StoreState> = {};
    if (s) {
      if (s.contextUsage !== undefined) patch.contextUsage = s.contextUsage ?? null;
      if (s.thinkingLevel !== undefined) {
        patch.thinkingLevel = (s.thinkingLevel as ThinkingLevelOption) ?? "auto";
      }
      if (s.extensionStatuses !== undefined) patch.extensionStatuses = s.extensionStatuses ?? [];
      if (s.extensionWidgets !== undefined) patch.extensionWidgets = s.extensionWidgets ?? [];
      if (s.queuedMessages !== undefined) patch.queuedMessages = normalizeQueuedMessages(s.queuedMessages);
      if (s.isCompacting !== undefined) patch.isCompacting = s.isCompacting;
    } else if (!agentState.running) {
      patch.queuedMessages = { steering: [], followUp: [] };
    }
    this.update(patch);
  }

  /** Recovery net for missed SSE events (pi-web's reconcileAgentState). */
  private async reconcile(): Promise<void> {
    const sid = this.state.sessionId;
    if (!sid || !this.state.agentRunning) return;
    const runId = this.runId;
    try {
      const data = await this.client.getState(sid);
      // A slow response can straddle a run boundary — drop stale results.
      if (this.runId !== runId || this.state.sessionId !== sid) return;
      const s = data.state;
      // Mirror compaction/queue unconditionally: missed compaction_end would
      // otherwise leave "Stop compaction" stuck.
      this.update({
        isCompacting: s?.isCompacting ?? false,
        queuedMessages: normalizeQueuedMessages(s?.queuedMessages),
      });
      const busy = data.running && s && (s.isStreaming || s.isPromptRunning || s.isCompacting);
      if (busy || !this.state.agentRunning) return;
      this.applyRuntimeState(data);
      this.finishRun();
      await this.refreshFromDisk();
    } catch {
      // network still down — next tick retries
    }
  }

  /** Slash-command-style prompts that never stream: settle via state polling. */
  private async waitForPromptSettlement(sid: string): Promise<void> {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const start = Date.now();
    const runId = this.runId;
    while (this.state.agentRunning && Date.now() - start < PROMPT_SETTLE_MAX_MS) {
      if (this.runId !== runId) return;
      try {
        const data = await this.client.getState(sid);
        const s = data.state;
        if (!data.running || !s || (!s.isStreaming && !s.isPromptRunning)) {
          await this.refreshFromDisk();
          this.finishRun();
          return;
        }
      } catch {
        // SSE remains the primary completion path
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }
}

export { PiApiError };
