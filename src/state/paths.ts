// Server-side path resolution for session cwd decisions (PLAN/PHASES/PHASE-4.md).
//
// The `~` in settings values is display-form; the pi-web API validates cwds
// with existsSync server-side and never expands tildes — so leading `~` is
// resolved through GET /api/home before anything hits the wire.

import type { PiClient } from "../api/client";

let homeCache: { home: string; jumperpediaHome: string } | null = null;

/** Resolve a settings-form path (may start with `~`) to an absolute server path. */
export async function resolveServerPath(client: PiClient, value: string): Promise<string> {
  const trimmed = value.trim();
  if (!trimmed.startsWith("~")) return trimmed;
  if (homeCache === null) {
    const { home, jumperpediaHome } = await client.getHome();
    homeCache = {
      home: home.replace(/\/+$/, ""),
      jumperpediaHome: jumperpediaHome.replace(/\/+$/, ""),
    };
  }
  const rest = trimmed.slice(1); // e.g. "/HalfaCloud/Jumperpedia/..."
  // The server computes the real Jumperpedia location (env-aware — a container's
  // homedir is NOT the host's, e.g. /home/node). `~/HalfaCloud/Jumperpedia…`
  // paths are the pinned convention and map there; anything else uses home.
  const pinned = "/HalfaCloud/Jumperpedia";
  if (rest === pinned || rest.startsWith(`${pinned}/`)) {
    return homeCache.jumperpediaHome + rest.slice(pinned.length);
  }
  return homeCache.home + rest;
}

export interface CwdChainInput {
  /** "Default Session Path" setting (empty = unset). */
  defaultPath: string;
  /** cwd of the currently open session, if any. */
  currentCwd: string | null;
  /** cwd of the last created session (persisted). */
  lastCwd: string;
  /** Configured root fallback (the vault-mapping prefix setting). */
  fallbackRoot: string;
}

/**
 * The new-session cwd chain: default path → current session's cwd →
 * last created session's cwd → configured root.
 */
export async function resolveNewSessionCwd(
  client: PiClient,
  input: CwdChainInput
): Promise<string> {
  const chosen =
    input.defaultPath.trim() ||
    input.currentCwd ||
    input.lastCwd.trim() ||
    input.fallbackRoot.trim();
  return resolveServerPath(client, chosen);
}

/** Parent directory of a server path ("/" is the floor). */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}
