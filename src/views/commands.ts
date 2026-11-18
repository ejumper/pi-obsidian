// Command-registry access (0.5.19) — the tab button's press/long-press
// actions can bind any command. Obsidian exposes the registry only through
// (app as any).commands — listCommands()/executeCommandById() at runtime — so
// this module owns the `any` and the built-in default rankings (the tab
// overview command is provided by whatever plugin owns the tab UI, unknown at
// build time; ids vary across devices).

export interface CommandInfo {
  id: string;
  name: string;
}

function registry(app: unknown): { listCommands?: () => CommandInfo[]; executeCommandById?: (id: string) => unknown } | null {
  return (app as { commands?: { listCommands?: () => CommandInfo[]; executeCommandById?: (id: string) => unknown } })
    ?.commands ?? null;
}

export function listCommands(app: unknown): CommandInfo[] {
  try {
    return (registry(app)?.listCommands?.() ?? [])
      .slice()
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: "base" }));
  } catch {
    return [];
  }
}

/** false when the registry is missing or the id is unknown. */
export function executeCommand(app: unknown, id: string): boolean {
  try {
    registry(app)?.executeCommandById?.(id);
    return true;
  } catch {
    return false;
  }
}

function findCommand(app: unknown, rank: (c: CommandInfo) => boolean): string | null {
  return listCommands(app).find(rank)?.id ?? null;
}

/** Built-in default PRESS target: the tab-overview command. Ranked because the
 *  id depends on which plugin provides the tab UI ("tab overview" /
 *  "show-tab-overview" in id or name, then id-"tab" + name-"overview", then
 *  any id containing "tab-overview"). */
export function findTabOverviewCommand(app: unknown): string | null {
  const has = (s: string, needle: string): boolean => s.toLowerCase().includes(needle);
  return (
    findCommand(app, (c) => has(c.id, "tab overview") || has(c.name, "tab overview")) ??
    findCommand(app, (c) => has(c.id, "show-tab-overview") || has(c.name, "show-tab-overview")) ??
    findCommand(app, (c) => has(c.id, "tab") && has(c.name, "overview")) ??
    findCommand(app, (c) => has(c.id, "tab-overview"))
  );
}

/** Built-in default LONG-PRESS target: the new-tab command. */
export function findNewTabCommand(app: unknown): string | null {
  const has = (s: string, needle: string): boolean => s.toLowerCase().includes(needle);
  return (
    findCommand(app, (c) => has(c.id, "new tab") || has(c.name, "new tab")) ??
    findCommand(app, (c) => has(c.id, "new-tab"))
  );
}
