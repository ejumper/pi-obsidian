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

/** Extensible union — more members land in Phase 1 (model/thinking/fork/...). */
export type AgentCommand =
  | { type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "abort" }
  | { type: "get_state" };

// ---------- SSE frames (GET /api/agent/:id/events) ----------

export type AgentEvent =
  | { type: "connected"; sessionId: string }
  | { type: "prompt_done" }
  | { type: "prompt_error"; errorMessage: string }
  | { type: "extension_error"; extensionPath?: string; event?: string; error?: string }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "message_start" }
  | { type: "message_update"; message: AgentMessage; usage?: unknown }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_update"; toolCallId?: string; [key: string]: unknown }
  | { type: "tool_execution_end"; toolCallId?: string; result?: unknown; isError?: boolean }
  | { type: "turn_end" }
  | { type: "queue_update"; steering?: unknown[]; followUp?: unknown[] }
  | { type: "compaction_start" }
  | { type: "compaction_end"; result?: unknown; aborted?: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt?: number; maxAttempts?: number }
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
