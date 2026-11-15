// CompactionDetails — pi-obsidian addition (NOT a pi-web port): the caret
// header wrapper for compaction messages (0.5.5, user spec). Mirrors the
// ProcessDetailsGroup chrome exactly ("Session Compacted · N tokens compacted ·
// Session size M"); children = the actual compaction message (pi-web's
// CompactionMessageView), shown when expanded — like Process details reveals
// its tool calls.
//
// Numbers: `tokensBefore` is persisted on the message (details.tokensBefore);
// `estimatedTokensAfter` only exists on freshly-compacted messages (ChatView
// enriches from the live compaction result) — older blocks drop that clause
// rather than show a stale number (user call).

import { useState, type ReactNode } from "react";
import type { CustomMessage } from "../../api/types";

export function CompactionDetails({
  message,
  children,
}: {
  message: CustomMessage;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const details = (message.details ?? {}) as {
    tokensBefore?: number;
    estimatedTokensAfter?: number;
  };
  const parts = ["Session Compacted"];
  if (typeof details.tokensBefore === "number") {
    parts.push(`${details.tokensBefore.toLocaleString()} tokens compacted`);
  }
  if (typeof details.estimatedTokensAfter === "number") {
    parts.push(`Session size ${details.estimatedTokensAfter.toLocaleString()}`);
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "auto",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={expanded ? "Collapse compaction" : "Expand compaction"}
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
          style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        >
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {parts.join(" · ")}
        </span>
      </button>
      {expanded && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}
