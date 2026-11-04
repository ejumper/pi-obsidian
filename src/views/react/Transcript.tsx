// Transcript glue: renders our grouped transcript units through the verbatim
// pi-web MessageView components via a React root. The grouping engine lives in
// ../message-display.ts (rule-for-rule port of pi-web's ChatWindow algorithm).

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

function TranscriptView({ units, streaming, modelNames, cwd, sessionId }: TranscriptData) {
  const showTs = computeShowTimestamps(units);
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
              {unit.members.map((member, i) => (
                <MessageView
                  key={`gm-${i}`}
                  message={member.message}
                  entryId={member.entryId}
                  toolResults={unit.toolResults}
                  modelNames={modelNames}
                  cwd={cwd}
                  sessionId={sessionId}
                />
              ))}
            </ProcessDetailsGroup>
          );
        }
        return (
          <MessageView
            key={`m-${idx}`}
            message={unit.message}
            entryId={unit.entryId}
            toolResults={unit.toolResults}
            modelNames={modelNames}
            cwd={cwd}
            sessionId={sessionId}
            showTimestamp={showTs.get(unit) ?? false}
          />
        );
      })}
      {streaming && (
        <MessageView
          message={streaming}
          isStreaming
          modelNames={modelNames}
          cwd={cwd}
          sessionId={sessionId}
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
