// ProcessDetailsGroup — verbatim port of the fold from pi-web's
// components/ChatWindow.tsx ("Process details · N messages · M tool calls").

import { useState, type ReactNode } from "react";

export function ProcessDetailsGroup({
  messageCount,
  toolCallCount,
  children,
}: {
  messageCount: number;
  toolCallCount: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const parts = ["Process details", `${messageCount} ${messageCount === 1 ? "message" : "messages"}`];
  if (toolCallCount > 0) parts.push(`${toolCallCount} ${toolCallCount === 1 ? "tool call" : "tool calls"}`);

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
        title={expanded ? "Collapse process details" : "Expand process details"}
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
