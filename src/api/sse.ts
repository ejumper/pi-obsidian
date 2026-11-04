// Streaming SSE reader over fetch() — works in the Obsidian webview on desktop
// and iOS (requestUrl() cannot stream; EventSource cannot send headers).
//
// Framing rules implemented (per pi-web's two framing styles + the SSE spec):
//   - frames separated by blank lines; line endings LF, CRLF, or lone CR
//   - `data: <payload>` with no `event:` line → onFrame(null, payload)
//   - `event: <name>` + one-or-more `data:` lines → onFrame(name, joined)
//   - multi-line data joined with "\n"; one leading space after ":" stripped
//   - lines starting with ":" are comments/heartbeats — ignored
//   - chunks may split lines AND frames at any byte; buffered across reads
//   - an incomplete frame at end of stream is discarded (SSE spec)
//   - payload is JSON.parse'd when possible, else passed as the raw string

export interface SseHandlers {
  onFrame: (name: string | null, data: unknown) => void;
  onError: (err: Error) => void;
  onClose: () => void;
}

export interface SseHandle {
  close(): void;
}

export function openSse(
  url: string,
  handlers: SseHandlers,
  signal?: AbortSignal
): SseHandle {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller);

  let finished = false;
  const finish = (err?: Error) => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", abortFromCaller);
    if (err) handlers.onError(err);
    else handlers.onClose();
  };

  void (async () => {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) throw new Error(`SSE request failed: HTTP ${res.status}`);
    if (!contentType.includes("text/event-stream")) {
      throw new Error(`SSE unexpected content-type: ${contentType || "(none)"}`);
    }
    if (!res.body) throw new Error("SSE response has no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let buf = "";
    let eventName: string | null = null;
    let dataLines: string[] = [];

    const dispatch = () => {
      if (dataLines.length === 0) {
        eventName = null;
        return;
      }
      const raw = dataLines.join("\n");
      dataLines = [];
      const name = eventName;
      eventName = null;
      let data: unknown = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        // raw string stays raw
      }
      handlers.onFrame(name, data);
    };

    const processLine = (line: string) => {
      if (line === "") {
        dispatch();
        return;
      }
      if (line.startsWith(":")) return; // comment / heartbeat
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") dataLines.push(value);
      else if (field === "event") eventName = value;
      // "id" and "retry" fields are ignored
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Process complete lines. A trailing "\r" is held back: it may be the
      // first half of a "\r\n" split across chunks.
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i];
        if (ch === "\n") {
          processLine(buf.slice(start, i));
          start = i + 1;
        } else if (ch === "\r") {
          if (i + 1 >= buf.length) break;
          processLine(buf.slice(start, i));
          if (buf[i + 1] === "\n") i++;
          start = i + 1;
        }
      }
      buf = buf.slice(start);
    }

    // End of stream: pending incomplete frame is discarded per the SSE spec.
    finish();
  })().catch((err: unknown) => {
    if (
      controller.signal.aborted ||
      (err instanceof DOMException && err.name === "AbortError")
    ) {
      finish(); // deliberate close — not an error
    } else {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return { close: () => controller.abort() };
}
