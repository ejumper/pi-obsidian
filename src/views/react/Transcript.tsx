// Transcript glue: renders our grouped transcript units through the verbatim
// pi-web MessageView components via a React root. The grouping engine lives in
// ../message-display.ts (rule-for-rule port of pi-web's ChatWindow algorithm).

import { useCallback, useState, type MouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { App, Component } from "obsidian";
import type { AgentMessage } from "../../api/types";
import type { TranscriptUnit } from "../message-display";
import { MessageView } from "./pi-web/MessageView";
import { ProcessDetailsGroup } from "./pi-web/ProcessDetailsGroup";
import { setMarkdownContext } from "./pi-web/markdown-context";

export interface TranscriptData {
  units: TranscriptUnit[];
  streaming: AgentMessage | null;
  modelNames: Record<string, string>;
  cwd: string;
  sessionId: string | undefined;
  onFork?: (entryId: string) => Promise<string | null>;
  onNavigate?: (entryId: string) => void;
  onEditContent?: (content: string) => void;
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
      if (next.kind === "group") break; // a new turn's process group
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
    } else {
      visit(unit, unit.message, unit.entryId);
    }
  }
  return prev;
}

function TranscriptView({ units, streaming, modelNames, cwd, sessionId, onFork, onNavigate, onEditContent }: TranscriptData) {
  const showTs = computeShowTimestamps(units);
  const prevAssistant = computePrevAssistantEntryIds(units);
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
    this.root?.render(<TranscriptView {...data} />);
  }

  unmount(): void {
    this.root?.unmount();
    this.root = null;
  }
}
