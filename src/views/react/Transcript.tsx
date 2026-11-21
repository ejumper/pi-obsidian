// Transcript glue: renders our grouped transcript units through the verbatim
// pi-web MessageView components via a React root. The grouping engine lives in
// ../message-display.ts (rule-for-rule port of pi-web's ChatWindow algorithm).

import { useCallback, useState, type MouseEvent } from "react";
import { useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { App, Component } from "obsidian";
import type { AgentMessage } from "../../api/types";
import type { TranscriptUnit } from "../message-display";
import type { CompactResultInfo } from "../../state/agent-store";
import { compactionCaretParts } from "./CompactionDetails";
import { MessageView } from "./pi-web/MessageView";
import { ProcessDetailsGroup } from "./pi-web/ProcessDetailsGroup";
import { setMarkdownContext } from "./pi-web/markdown-context";
import { setApiBase } from "./pi-web/api-base";
import { setSpeakController, type SpeakController } from "../speak-context";

export interface TranscriptData {
  units: TranscriptUnit[];
  streaming: AgentMessage | null;
  modelNames: Record<string, string>;
  cwd: string;
  sessionId: string | undefined;
  onFork?: (entryId: string) => Promise<string | null>;
  onNavigate?: (entryId: string) => void;
  onEditContent?: (content: string) => void;
  /** Called after every committed render — ChatView scrolls on session swaps
   *  only once the DOM actually carries the new content. */
  onRendered?: () => void;
  /** This tab's machine base URL — the React subtree's api shim is a module
   *  global, so it is re-pointed on every render pass (Phase 13). */
  apiBase?: string;
  /** Read-aloud backend — same module-global re-pointing as apiBase (0.5.6). */
  speak?: SpeakController;
  /** Run-ending error shown as red session output (0.4.12) */
  runError?: string | null;
  /** Live compaction: plain "Compacting..." line at the session tail (0.5.5). */
  compacting?: boolean;
}

/** pi-web's rule: only the LAST assistant message of a turn shows the
 *  timestamp/usage line; hidden on the currently-streaming tail. */
function computeShowTimestamps(units: TranscriptUnit[]): Map<TranscriptUnit, boolean> {
  const show = new Map<TranscriptUnit, boolean>();
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.kind !== "message" || unit.message.role !== "assistant") continue;
    let visible = true;
    for (let j = i + 1; j < units.length; j++) {
      const next = units[j];
      if (next.kind !== "message") break; // a group = a new turn; a caret = a seam
      const role = next.message.role;
      if (role === "user") break;
      if (role === "assistant") {
        visible = false;
        break;
      }
    }
    show.set(unit, visible);
  }
  return show;
}

/** pi-web's "edit from here" rewinds to the previous assistant entry: walk the
 *  units (and group members) in display order, remembering the entryId of the
 *  most recent ASSISTANT message; each USER message receives that value. */
function computePrevAssistantEntryIds(units: TranscriptUnit[]): Map<TranscriptUnit, string | undefined> {
  const prev = new Map<TranscriptUnit, string | undefined>();
  let last: string | undefined;
  const visit = (unit: TranscriptUnit, message: AgentMessage, entryId?: string) => {
    if (message.role === "assistant") {
      if (entryId) last = entryId; // only a keyed assistant entry can be rewound to
    } else if (message.role === "user") {
      prev.set(unit, last);
    }
  };
  for (const unit of units) {
    if (unit.kind === "group") {
      for (const member of unit.members) visit(unit, member.message, member.entryId);
    } else if (unit.kind === "message") {
      visit(unit, unit.message, unit.entryId);
    }
  }
  return prev;
}

/** PHASE-20 (heat): the per-render Maps are derived purely from the units
 *  array — cache them per identity so a streaming tick's re-render of the
 *  root does no O(session) work. */
const showTsCache = new WeakMap<TranscriptUnit[], Map<TranscriptUnit, boolean>>();
const prevCache = new WeakMap<TranscriptUnit[], Map<TranscriptUnit, string | undefined>>();

function showTimestampsFor(units: TranscriptUnit[]): Map<TranscriptUnit, boolean> {
  let cached = showTsCache.get(units);
  if (!cached) {
    cached = computeShowTimestamps(units);
    showTsCache.set(units, cached);
  }
  return cached;
}

function prevAssistantFor(units: TranscriptUnit[]): Map<TranscriptUnit, string | undefined> {
  let cached = prevCache.get(units);
  if (!cached) {
    cached = computePrevAssistantEntryIds(units);
    prevCache.set(units, cached);
  }
  return cached;
}

function TranscriptView({ units, streaming, modelNames, cwd, sessionId, onFork, onNavigate, onEditContent, onRendered, runError, compacting }: TranscriptData) {
  const showTs = showTimestampsFor(units);
  // No dep array: fires after every commit. A plain rAF scroll races React's
  // async commit on big session swaps (the transcript still held the old DOM
  // when the frame ran — sessions opened at the top).
  useLayoutEffect(() => { onRendered?.(); });
  const prevAssistant = prevAssistantFor(units);
  const [forkingKey, setForkingKey] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);

  // "New session" feedback: mark this entryId as forking for the duration of
  // the store call, then clear it (MessageView shows "Creating…" meanwhile).
  const handleFork = useCallback(async (entryId: string): Promise<string | null> => {
    setForkingKey(entryId);
    try {
      return (await onFork?.(entryId)) ?? null;
    } finally {
      setForkingKey(null);
    }
  }, [onFork]);

  // Tap-to-reveal (mobile): taps on interactive elements (links, buttons,
  // code…) are left alone; any other tap toggles this message's action row.
  const handleTap = (key: string) => (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("a, button, summary, code, pre")) return;
    setRevealed((prev) => (prev === key ? null : key));
  };
  return (
    <div className="pi-transcript-react">
      {units.map((unit, idx) => {
        if (unit.kind === "caret") {
          // 0.5.33: the compaction completion caret — inline at the seam
          // (kept content above, new messages below). Was a bottom-pinned
          // banner that stayed below every new message (device report).
          return (
            <div
              key={`c-${idx}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minHeight: 24,
                marginBottom: 14,
                color: "var(--text-muted)",
                fontSize: 12,
              }}
              title="Session compacted"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
              >
                <polyline points="4 2.5 7.5 6 4 9.5" />
              </svg>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {compactionCaretParts(unit.tokensBefore, unit.estimatedTokensAfter).join(" · ")}
              </span>
            </div>
          );
        }
        if (unit.kind === "group") {
          return (
            <ProcessDetailsGroup
              key={`g-${idx}`}
              messageCount={unit.messageCount}
              toolCallCount={unit.toolCallCount}
            >
              {unit.members.map((member, i) => {
                const view = (
                  <MessageView
                    key={`gm-${i}`}
                    message={member.message}
                    entryId={member.entryId}
                    toolResults={unit.toolResults}
                    modelNames={modelNames}
                    cwd={cwd}
                    sessionId={sessionId}
                    onFork={handleFork}
                    onNavigate={onNavigate}
                    onEditContent={onEditContent}
                    prevAssistantEntryId={prevAssistant.get(unit)}
                    forking={forkingKey === member.entryId}
                  />
                );
                if (member.message.role !== "user") return view;
                const key = `gm-${idx}-${i}`;
                return (
                  <div key={key} className="pi-msg-tap" onClick={handleTap(key)}>
                    {view}
                  </div>
                );
              })}
            </ProcessDetailsGroup>
          );
        }
        const view = (
          <MessageView
            key={`m-${idx}`}
            message={unit.message}
            entryId={unit.entryId}
            toolResults={unit.toolResults}
            modelNames={modelNames}
            cwd={cwd}
            sessionId={sessionId}
            showTimestamp={showTs.get(unit) ?? false}
            onFork={handleFork}
            onNavigate={onNavigate}
            onEditContent={onEditContent}
            prevAssistantEntryId={prevAssistant.get(unit)}
            forking={forkingKey === unit.entryId}
          />
        );
        if (unit.message.role !== "user") return view;
        const key = `u-${idx}`;
        return (
          <div key={key} className="pi-msg-tap" onClick={handleTap(key)}>
            {view}
          </div>
        );
      })}
      {streaming && (
        <MessageView
          message={streaming}
          isStreaming
          modelNames={modelNames}
          cwd={cwd}
          sessionId={sessionId}
          onFork={handleFork}
          onNavigate={onNavigate}
          onEditContent={onEditContent}
          forking={false}
        />
      )}
      {runError && (
        /* pi-obsidian divergence (0.4.12): run-ending errors render as session
           output — like a model reply but in red text (pi TUI parity) */
        <div style={{ color: "var(--text-error)", fontSize: 13, lineHeight: 1.65, marginBottom: 16, whiteSpace: "pre-wrap" }}>
          Error: {runError}
        </div>
      )}
      {compacting ? (
        /* pi-obsidian divergence (0.5.5, user spec): a live compaction shows a
           plain-text "Compacting..." line at the session tail — model-reply
           styling, no bubble. On completion it vanishes: the caret unit now
           renders inline at the seam (0.5.33) where it replaces this line. */
        <div style={{ color: "var(--text-normal)", fontSize: 15, lineHeight: 1.65, marginBottom: 16 }}>
          Compacting...
        </div>
      ) : null}
    </div>
  );
}

export class TranscriptRenderer {
  private root: Root | null = null;

  constructor(
    container: HTMLElement,
    ctx: { app: App; sourcePath: string; component: Component }
  ) {
    setMarkdownContext(ctx.app, ctx.sourcePath, ctx.component);
    try {
      this.root = createRoot(container);
    } catch {
      // headless/no-DOM environments — render calls become no-ops
      this.root = null;
    }
  }

  update(data: TranscriptData): void {
    // The api shim is a module global — re-point it every pass so two tabs on
    // different machines don't race it (Phase 13).
    if (data.apiBase) setApiBase(data.apiBase);
    if (data.speak) setSpeakController(data.speak);
    this.root?.render(<TranscriptView {...data} />);
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
  }
}
