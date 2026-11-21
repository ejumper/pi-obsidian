// Transcript grouping — a port of pi-web's lib/message-display.ts plus the
// segment algorithm from components/ChatWindow.tsx (the "Process details"
// condense semantics). Pure logic, no DOM.
//
// Semantics (pi-web, do not simplify):
//  - The message list splits at user messages into segments
//    [user, ...non-user messages].
//  - A completed segment renders as: user message, a collapsed "process group"
//    holding everything between the user message and the final answer (plus
//    the final assistant message's leading thinking/toolCall blocks), then the
//    final answer (trailing text/image blocks of that assistant message).
//  - The LIVE tail (running + last segment) renders raw — tool calls print out
//    during the run and only condense once the turn completes.
//  - toolResult messages are not standalone in grouped form: they render
//    inside their tool-call cards via the toolResults map (pi-web parity).

import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
} from "../api/types";

// ---------- block helpers (ported from lib/message-display.ts) ----------

interface DisplayOptions {
  isStreaming?: boolean;
}

export function isEmptyThinkingBlock(
  block: AssistantContentBlock,
  options: DisplayOptions = {}
): boolean {
  return (
    block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === ""
  );
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {}
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {}
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block) => block.type === "toolCall").length;
}

// ---------- segment helpers (ported from ChatWindow.tsx) ----------

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message).answerBlocks.some(
    (block) => block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  );
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let i = endIdx - 1; i > userIdx; i--) {
    if (hasFinalAssistantAnswer(messages[i])) return i;
  }
  for (let i = endIdx - 1; i > userIdx; i--) {
    if (messages[i]?.role === "assistant") return i;
  }
  return -1;
}

/** pi-obsidian divergence (0.5.5): compaction messages are segment
 *  BOUNDARIES — they render as their own caret block (user spec) and must
 *  never fold into a process group. Semantically sound: everything before a
 *  compaction was summarized away anyway. */
function isCompactionMessage(message: AgentMessage): boolean {
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

function hasDisplayableProcessMessage(message: AgentMessage): boolean {
  if (message.role === "assistant") {
    return getDisplayableAssistantBlocks(message as AssistantMessage).length > 0;
  }
  return message.role === "custom";
}

function countToolCalls(messages: AgentMessage[], indices: number[]): number {
  let count = 0;
  for (const i of indices) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    count += countToolCallBlocks(getDisplayableAssistantBlocks(msg as AssistantMessage));
  }
  return count;
}

// ---------- transcript units ----------

export interface MessageUnit {
  kind: "message";
  /** "plain" renders the message as-is; "answer" renders the synthetic
   *  answer-blocks-only split of the keyed assistant message. */
  tag: "plain" | "answer";
  /** Cache identity: the ORIGINAL message object this unit derives from. */
  key: AgentMessage;
  message: AgentMessage;
  entryId?: string;
  toolResults?: Map<string, ToolResultMessage>;
}

export interface GroupUnit {
  kind: "group";
  tag: "group";
  /** Cache identity: the segment's user message object. */
  key: AgentMessage;
  /** Process messages, including the synthetic final-process split, in order. */
  members: Array<{ message: AgentMessage; entryId?: string }>;
  messageCount: number;
  toolCallCount: number;
  toolResults: Map<string, ToolResultMessage>;
}

export type TranscriptUnit = MessageUnit | GroupUnit | CaretUnit;

/** 0.5.33: the compaction COMPLETION caret, inline at the seam (the old
 *  bottom-pinned banner chased the viewport — the line belongs where the
 *  compaction finished: kept content above, new messages below). */
export interface CaretUnit {
  kind: "caret";
  tokensBefore: number;
  estimatedTokensAfter: number;
}

/** Where the completion caret goes: BEFORE the message at `afterIdx` (the
 *  message count at compaction completion). */
export interface CompactionCaret {
  afterIdx: number;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

function plain(message: AgentMessage, entryId?: string): MessageUnit {
  return { kind: "message", tag: "plain", key: message, message, entryId };
}

function withBlocks(message: AssistantMessage, content: AssistantContentBlock[]): AssistantMessage {
  return { ...message, content, usage: undefined };
}

/** Split the message list into render units (see semantics at the top). */
export function computeTranscriptUnits(
  messages: AgentMessage[],
  running: boolean,
  entryIds?: string[],
  caret?: CompactionCaret | null,
): TranscriptUnit[] {
  const units: TranscriptUnit[] = [];
  let idx = 0;
  let caretDone = false;
  const dropCaret = (): void => {
    // The seam is always a segment boundary (compaction completes between
    // turns) — a mid-segment seam would render before that segment instead.
    if (caret && !caretDone && idx >= caret.afterIdx) {
      caretDone = true;
      units.push({
        kind: "caret",
        tokensBefore: caret.tokensBefore,
        estimatedTokensAfter: caret.estimatedTokensAfter,
      });
    }
  };
  while (idx < messages.length) {
    dropCaret();
    const msg = messages[idx];
    if (msg.role !== "user") {
      units.push(plain(msg, entryIds?.[idx]));
      idx += 1;
      continue;
    }

    const userIdx = idx;
    let endIdx = userIdx + 1;
    while (endIdx < messages.length && messages[endIdx].role !== "user" && !isCompactionMessage(messages[endIdx])) {
      endIdx += 1;
    }

    const finalIdx = findFinalAssistantIndex(messages, userIdx, endIdx);
    const isLiveTail = running && endIdx === messages.length;

    if (finalIdx === -1 || isLiveTail) {
      // No answer yet, or the run is still on this segment: render raw.
      for (let i = userIdx; i < endIdx; i++) units.push(plain(messages[i], entryIds?.[i]));
      idx = endIdx;
      continue;
    }

    // Completed segment: user → process group → final answer → trailing.
    units.push(plain(messages[userIdx], entryIds?.[userIdx]));

    const toolResults = new Map<string, ToolResultMessage>();
    for (let i = userIdx + 1; i < endIdx; i++) {
      const m = messages[i];
      if (m.role === "toolResult") toolResults.set(m.toolCallId, m);
    }

    const processIndices: number[] = [];
    for (let i = userIdx + 1; i < finalIdx; i++) processIndices.push(i);
    const visible = processIndices.filter((i) => hasDisplayableProcessMessage(messages[i]));

    const members: Array<{ message: AgentMessage; entryId?: string }> = visible.map((i) => ({
      message: messages[i],
      entryId: entryIds?.[i],
    }));
    let toolCallCount = countToolCalls(messages, visible);

    const finalMsg = messages[finalIdx] as AssistantMessage;
    const { answerBlocks, processBlocks } = splitFinalAssistantBlocks(finalMsg);
    if (processBlocks.length > 0) {
      members.push({ message: withBlocks(finalMsg, processBlocks), entryId: entryIds?.[finalIdx] });
      toolCallCount += countToolCallBlocks(processBlocks);
    }
    if (members.length > 0) {
      units.push({
        kind: "group",
        tag: "group",
        key: messages[userIdx],
        members,
        messageCount: members.length,
        toolCallCount,
        toolResults,
      });
    }
    if (answerBlocks.length > 0) {
      units.push({
        kind: "message",
        tag: "answer",
        key: finalMsg,
        message: withBlocks(finalMsg, answerBlocks),
        entryId: entryIds?.[finalIdx],
        toolResults,
      });
    }
    for (let i = finalIdx + 1; i < endIdx; i++) units.push(plain(messages[i], entryIds?.[i]));

    idx = endIdx;
  }
  dropCaret(); // the seam at (or past) the end — no new messages yet
  return units;
}

// ---------- PHASE-20: render identity cache (heat pass) ----------
//
// MessageView is React.memo'd, but the memo is only as good as its props'
// identities: a streaming tick changes ONLY streamingMessage, yet rebuilding
// the units array every pass minted fresh wrappers (plain()/withBlocks()) and
// fresh toolResults maps — so every message re-rendered on every delta and
// per-delta work scaled with session length (the phone-heat report).
// `createUnitsCache` reuses the SAME units while its inputs are unchanged —
// then a delta re-renders one message: the streaming tail.

import { stripMessageVoiceBlocks } from "./voice/banner-state";
import type { CompactResultInfo } from "../state/agent-store";

interface UnitsCacheEntry {
  messages: AgentMessage[];
  running: boolean;
  entryIds: string[] | undefined;
  compactResult: CompactResultInfo | null | undefined;
  caretAt: number | null;
  units: TranscriptUnit[];
}

/**
 * Identity-stable transcript units: strip voice banners, apply the live
 * compaction estimate to a tail compaction message (0.5.5 caret header),
 * group — and REUSE the previous result while the inputs are reference-equal.
 * One cache per ChatView instance (multi-tab safe); the returned function is
 * pure from the caller's view.
 */
export function createUnitsCache(): (
  messages: AgentMessage[],
  running: boolean,
  entryIds: string[] | undefined,
  compactResult: CompactResultInfo | null | undefined,
  caretAt: number | null,
) => TranscriptUnit[] {
  let entry: UnitsCacheEntry | null = null;
  return (messages, running, entryIds, compactResult, caretAt) => {
    if (
      entry !== null &&
      entry.messages === messages &&
      entry.running === running &&
      entry.entryIds === entryIds &&
      entry.compactResult === compactResult &&
      entry.caretAt === caretAt
    ) {
      return entry.units;
    }
    const stripped = messages.map((m, i) => {
      const clean = stripMessageVoiceBlocks(m);
      // Fresh compaction estimate rides on its message for the caret header
      // (0.5.5): historical blocks fall back to tokensBefore only.
      if (
        i === messages.length - 1 &&
        compactResult &&
        clean.role === "custom" &&
        (clean as CustomMessage).customType === "compaction"
      ) {
        return {
          ...clean,
          details: {
            ...((clean as CustomMessage).details as Record<string, unknown> | undefined),
            estimatedTokensAfter: compactResult.estimatedTokensAfter,
          },
        } as AgentMessage;
      }
      return clean;
    });
    entry = {
      messages,
      running,
      entryIds,
      compactResult,
      caretAt,
      units: computeTranscriptUnits(
        stripped,
        running,
        entryIds,
        compactResult && typeof caretAt === "number"
          ? {
              afterIdx: caretAt,
              tokensBefore: compactResult.tokensBefore,
              estimatedTokensAfter: compactResult.estimatedTokensAfter,
            }
          : null,
      ),
    };
    return entry.units;
  };
}
