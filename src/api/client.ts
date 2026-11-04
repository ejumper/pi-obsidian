// REST client for the pi-web site API. Plain fetch, JSON envelope handling.
// Envelope: success is `{success: true, ...}` / bare JSON; failure is `{error}`
// with a non-2xx status (or occasionally 200 — both are treated as errors).

import type {
  AgentCommand,
  SessionContext,
  SessionInfo,
  SessionTreeNode,
} from "./types";

export class PiApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "PiApiError";
  }
}

export interface SessionsListResponse {
  sessions: SessionInfo[];
  runningSessionIds: string[];
  liveSessionIds: string[];
}

export interface SessionDetailResponse {
  sessionId: string;
  filePath: string;
  info: SessionInfo | null;
  leafId: string;
  tree: SessionTreeNode[];
  context: SessionContext;
  live: boolean;
}

export interface AgentStateResponse {
  running: boolean;
  state?: unknown;
}

export interface NewSessionResponse {
  sessionId: string;
  data: unknown;
}

export class PiClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, init);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body — fall through, handled below
    }
    const obj = body as Record<string, unknown> | null;
    if (!res.ok) {
      throw new PiApiError(
        res.status,
        typeof obj?.error === "string" && obj.error ? obj.error : `HTTP ${res.status}`
      );
    }
    if (obj && typeof obj.error === "string" && obj.error) {
      throw new PiApiError(res.status, obj.error);
    }
    return body as T;
  }

  private post<T>(path: string, payload: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /** GET /api/sessions */
  listSessions(): Promise<SessionsListResponse> {
    return this.request("/api/sessions");
  }

  /** GET /api/sessions/:id */
  getSession(id: string): Promise<SessionDetailResponse> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}`);
  }

  /** POST /api/agent/new — creates a session and sends the first prompt. */
  async createSession(cwd: string, message: string): Promise<NewSessionResponse> {
    const res = await this.post<NewSessionResponse>("/api/agent/new", {
      cwd,
      type: "prompt",
      message,
    });
    return { sessionId: res.sessionId, data: res.data };
  }

  /** POST /api/agent/:id — command envelope. */
  sendCommand(sessionId: string, cmd: AgentCommand): Promise<{ data: unknown }> {
    return this.post(`/api/agent/${encodeURIComponent(sessionId)}`, cmd);
  }

  /** GET /api/agent/:id — {running, state} snapshot for reconciliation. */
  getState(sessionId: string): Promise<AgentStateResponse> {
    return this.request(`/api/agent/${encodeURIComponent(sessionId)}`);
  }
}
