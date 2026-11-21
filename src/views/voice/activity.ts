/**
 * Centered activity readout (0.5.1) — WHAT the agent is doing right now:
 * "thinking" while a thinking block is the stream tail, a human phrase while a
 * tool call is live ("searching the web", "bashing", "grepping"…). The user
 * spec deliberately excludes pi-voice-chat's "Working" fallback: the
 * in-between run state (no thinking, no live tool) shows NOTHING — the glow
 * already carries it. Pure logic, no DOM — exercised by test/voice-mode-check.mjs.
 */
import type { AgentMessage, AssistantMessage } from "../../api/types";

/** Tool phrase table — the user's literal strings; gerund fallback below. */
const TOOL_ACTIVITY: Record<string, string> = {
  web_search: "searching the web",
  web_fetch: "fetching the web",
  bash: "bashing",
  grep: "grepping",
  glob: "globbing",
  read: "reading",
  write: "writing",
  edit: "editing",
  execute: "executing",
  explore: "exploring",
  session_move: "moving session",
};

/** Human phrase for a running tool call ("bashing", "searching the web"…). */
export function toolActivity(toolName: string): string {
  return (
    TOOL_ACTIVITY[toolName.toLowerCase()] ??
    `${toolName.toLowerCase().replace(/_/g, " ")}ing`
  );
}

/**
 * Current activity from the transcript tail, or null when nothing specific is
 * active. Rules (newest first):
 *  • the STREAMING tail is the live turn while it grows — its thinking/toolCall
 *    blocks live there until message_end (the store keeps the in-flight
 *    message out of messages[]), so the tail is scanned first (0.5.31: the
 *    phrases were structurally invisible while streaming);
 *  • a tail `user` message = a prompt with no stream yet → null;
 *  • a live toolCall (no toolResult anywhere) in the turn → that tool's
 *    phrase (parallel calls: the newest unresulted one wins);
 *  • else the turn's tail block is a thinking block → "thinking";
 *  • else null (reply streaming / between actions — the glow's job).
 * Callers gate on `agentRunning`: a completed run always reads null here.
 */
export function currentActivity(
  messages: AgentMessage[],
  streaming?: AgentMessage | null,
): string | null {
  // Find the live turn: the streaming tail first, else the last assistant
  // message, never crossing a user message (a fresh prompt means nothing
  // from earlier turns is active).
  let turn: AssistantMessage | null = null;
  if (
    streaming &&
    streaming.role === "assistant" &&
    Array.isArray(streaming.content)
  ) {
    turn = streaming as AssistantMessage;
  }
  if (!turn) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant") {
        turn = m;
        break;
      }
      if (m.role === "user") return null;
    }
  }
  if (!turn || !Array.isArray(turn.content)) return null;

  // Resolved tool call ids (any round) — a call without one is still running.
  const resolved = new Set<string>();
  for (const m of messages) {
    if (m.role === "toolResult") resolved.add(m.toolCallId);
  }

  const blocks = turn.content;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === "toolCall" && !resolved.has(b.toolCallId)) {
      return toolActivity(b.toolName);
    }
  }

  const tail = blocks[blocks.length - 1];
  return tail && tail.type === "thinking" ? "thinking" : null;
}
