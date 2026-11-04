// MarkdownBody — the ONE intentional divergence from pi-web's component tree:
// identical props, but prose renders through Obsidian's MarkdownRenderer so it
// follows the user's theme, typography, and wiki-links natively (user decision
// 2026-11-04). Everything else in the pi-web subtree is verbatim.

import { useEffect, useRef } from "react";
import { MarkdownRenderer } from "obsidian";
import { getMarkdownContext } from "./markdown-context";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

export function MarkdownBody({ children, className }: MarkdownBodyProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const ctx = getMarkdownContext();
    if (!el || !ctx) return;
    el.replaceChildren();
    const holder = document.createElement("div");
    el.appendChild(holder);
    let cancelled = false;
    void MarkdownRenderer.render(ctx.app, children, holder, ctx.sourcePath, ctx.component).then(
      () => {
        if (cancelled) holder.remove();
      },
      () => {
        if (!cancelled) holder.setText(children);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [children]);

  // markdown-rendered + markdown-preview-view make Obsidian's prose stylesheet
  // apply outside a native reading view.
  const classes = ["markdown-body", "markdown-rendered", "markdown-preview-view", className]
    .filter(Boolean)
    .join(" ");
  return <div ref={ref} className={classes} />;
}
