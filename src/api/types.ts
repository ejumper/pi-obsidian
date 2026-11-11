// Protocol types for the pi-web site API.
// Shapes are ported from the pi-web codebase's lib/types.ts (authoritative source)
// plus the SSE frame union observed on GET /api/agent/:id/events.

// ---------- message content blocks ----------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** Historical content omitted from the initial response and loaded on demand. */
  deferred?: boolean;
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

// ---------- messages ----------

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  usage?: MessageUsage;
}

export interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/** pi 1.3 section-delta system message — not chat content; do not render. */
export interface SystemMessage {
  role: "system";
  content: string;
  sections?: Record<string, string>;
  timestamp?: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp?: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CustomMessage
  | SystemMessage;

// ---------- session file entries ----------

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  fromHook?: boolean;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

// ---------- session metadata / context ----------

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string;
  projectRoot?: string;
  worktreeBranch?: string;
}

export interface SessionContext {
  messages: AgentMessage[];
  /** Parallel to messages — the session entry id for each message. */
  entryIds: string[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  compressedEntryIds?: string[];
}

// ---------- agent commands (POST /api/agent/:id) ----------

/** Inline image payload accepted on prompt/steer/follow_up commands. */
export interface AttachedImageInput {
  type: "image";
  data: string;
  mimeType: string;
}

/** Extensible union — mirrors the `send()` switch in pi-web's rpc-manager. */
export type AgentCommand =
  | { type: "prompt"; message: string; images?: AttachedImageInput[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string; images?: AttachedImageInput[] }
  | { type: "follow_up"; message: string; images?: AttachedImageInput[] }
  | { type: "abort" }
  | { type: "get_state" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: string }
  | { type: "set_tools"; toolNames: string[] }
  | { type: "set_auto_compaction"; enabled: boolean }
  | { type: "set_auto_retry"; enabled: boolean }
  | { type: "compact"; customInstructions?: string }
  | { type: "abort_compaction" }
  | { type: "clear_queue" }
  | { type: "fork"; entryId: string }
  | { type: "navigate_tree"; targetId: string }
  | { type: "set_session_name"; name: string }
  | { type: "get_session_stats" }
  | { type: "get_last_assistant_text" }
  | { type: "get_tools" }
  | { type: "get_commands" }
  | { type: "clear_queue" }
  | { type: "reload" }
  | { type: "extension_ui_response"; id: string; value?: string; confirmed?: boolean; cancelled?: boolean }
  | { type: "extension_ui_input"; id: string; data: string }
  | { type: "extension_ui_focus"; id: string; focused?: boolean; hidden?: boolean }
  | { type: "extension_ui_resize"; id: string; cols: number };

// ---------- extension UI requests ----------

export type ExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "custom";
      lines: string[];
      closed?: boolean;
      nonCapturing?: boolean;
      hidden?: boolean;
      focused?: boolean;
    };

export type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
export type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

export interface ExtensionStatusItem {
  key: string;
  text: string;
}

export interface ExtensionWidgetItem {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

// ---------- agent runtime state (GET /api/agent/:id → state) ----------

export interface AgentRuntimeState {
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isCompacting?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
}

// ---------- SSE frames (GET /api/agent/:id/events) ----------

export type AgentEvent =
  | { type: "connected"; sessionId: string }
  | { type: "prompt_done" }
  | { type: "prompt_error"; errorMessage: string }
  | { type: "extension_error"; extensionPath?: string; event?: string; error?: string }
  | ExtensionUiRequest
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "message_start"; message?: AgentMessage }
  | { type: "message_update"; message: AgentMessage; usage?: unknown }
  | { type: "message_end"; message: AgentMessage; entryId?: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_update"; toolCallId?: string; [key: string]: unknown }
  | { type: "tool_execution_end"; toolCallId?: string; result?: unknown; isError?: boolean }
  | { type: "turn_end" }
  | { type: "queue_update"; steering?: string[]; followUp?: string[] }
  | { type: "queue_pending"; pending?: boolean }
  | { type: "external_state"; name?: string; guardEnabled?: boolean; readMode?: "read" | "work"; thinkingLevel?: string; live?: boolean; bridgeLost?: boolean }
  | { type: "compaction_start" }
  | { type: "compaction_end"; result?: unknown; aborted?: boolean; errorMessage?: string; reason?: string }
  | { type: "auto_compaction_start" }
  | { type: "auto_compaction_end"; result?: unknown; aborted?: boolean; errorMessage?: string; reason?: string }
  | { type: "auto_retry_start"; attempt?: number; maxAttempts?: number; errorMessage?: string }
  | { type: "auto_retry_end" }
  | { type: "session_info_changed"; name?: string };

/** Frame type as it arrives off the wire: known events plus anything unrecognized.
 *  Consumers switch on known `type` values and ignore the rest. */
export type AnyAgentFrame = AgentEvent | ({ type: string } & Record<string, unknown>);

// ---------- SSE frames for the running-sessions feed ----------

export interface RunningSessionsFrame {
  type: "running";
  runningSessionIds: string[];
  liveSessionIds: string[];
}
