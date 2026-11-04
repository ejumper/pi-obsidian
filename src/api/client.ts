// REST client for the pi-web site API. Plain fetch, JSON envelope handling.
// Envelope: success is `{success: true, ...}` / bare JSON; failure is `{error}`
// with a non-2xx status (or occasionally 200 — both are treated as errors).

import type {
  AgentCommand,
  AgentMessage,
  AgentRuntimeState,
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
  state?: AgentRuntimeState;
}

export interface ModelsResponse {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: { provider: string; modelId: string } | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
}

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
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
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}?deferThinking=1&deferMedia=1`
    );
  }

  /** GET /api/sessions/:id/context?leafId= — messages for one tree leaf. */
  getSessionContext(
    id: string,
    leafId?: string
  ): Promise<{ context: { messages: AgentMessage[]; entryIds: string[] } }> {
    const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
    if (leafId) params.set("leafId", leafId);
    return this.request(`/api/sessions/${encodeURIComponent(id)}/context?${params}`);
  }

  /** GET /api/models?cwd= */
  getModels(cwd?: string): Promise<ModelsResponse> {
    const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return this.request(`/api/models${qs}`);
  }

  /** POST /api/attachments (multipart) → server-side /tmp path for a file. */
  async uploadAttachment(file: File): Promise<string> {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch(`${this.baseUrl}/api/attachments`, { method: "POST", body: form });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body
    }
    const obj = body as { path?: string; error?: string } | null;
    if (!res.ok || !obj?.path) {
      throw new PiApiError(res.status, obj?.error ?? `HTTP ${res.status}`);
    }
    return obj.path;
  }

  /** GET /api/home — server-side home dir (for `~` expansion) + defaults. */
  getHome(): Promise<{ home: string; jumperpediaHome: string; defaultWorkspace?: string }> {
    return this.request("/api/home");
  }

  /** GET /api/files/<path>?type=list — directory listing of the server FS. */
  listDir(path: string): Promise<{ entries: { name: string; isDir: boolean }[]; path: string }> {
    return this.request(
      `/api/files/${encodeURIComponent(path)}?type=list`
    );
  }

  /** POST /api/agent/new — creates a session runtime; body carries the first
   *  command ({type:"prompt", ...}) or {type:"ensure_session"} to create only. */
  async createSession(
    cwd: string,
    body: { type: string } & Record<string, unknown>
  ): Promise<NewSessionResponse> {
    const res = await this.post<NewSessionResponse>("/api/agent/new", { cwd, ...body });
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
