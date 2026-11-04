// Context for the MarkdownBody swap: the Obsidian app + a lifecycle Component
// + source path, set once when the transcript mounts. (The copied pi-web
// components render markdown through MarkdownBody; ours goes through
// Obsidian's MarkdownRenderer and needs these.)

import type { App, Component } from "obsidian";

let currentApp: App | null = null;
let currentSourcePath = "";
let currentComponent: Component | null = null;

export function setMarkdownContext(app: App, sourcePath: string, component: Component): void {
  currentApp = app;
  currentSourcePath = sourcePath;
  currentComponent = component;
}

export function getMarkdownContext(): { app: App; sourcePath: string; component: Component } | null {
  if (!currentApp || !currentComponent) return null;
  return { app: currentApp, sourcePath: currentSourcePath, component: currentComponent };
}
