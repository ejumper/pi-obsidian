// T28 probe: record the exact SSE event sequence for first + follow-up prompts,
// mimicking the plugin store's flow (subscribe → send command → observe).
// Usage: node t28-probe.mjs <baseUrl>
const base = process.argv[2] ?? "http://127.0.0.1:3737";
const t0 = Date.now();
const ts = () => `${String(Date.now() - t0).padStart(6)}ms`;

async function api(path, opts) {
  const res = await fetch(base + path, opts);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

// 1. create a scratch session (startNewSession flow: /api/agent/new)
const created = await api("/api/agent/new", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "ensure_session", cwd: "/tmp" }),
});
const sid = created.id ?? created.sessionId;
console.log(ts(), "session:", sid);

// 2. subscribe like the store does (/api/agent/{id}/events)
const frames = [];
const ac = new AbortController();
setTimeout(() => ac.abort(), 90_000);
void (async () => {
  const res = await fetch(`${base}/api/agent/${sid}/events`, {
    headers: { Accept: "text/event-stream" },
    signal: ac.signal,
  });
  console.log(ts(), "SSE HTTP", res.status, res.headers.get("content-type"));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      let raw = line.slice(5).trim();
      let ev;
      try { ev = JSON.parse(raw); } catch { ev = { raw }; }
      const kind = ev.type ?? "(unnamed)";
      frames.push(kind);
      console.log(ts(), "FRAME", kind, ev.entryId ? `entry=${String(ev.entryId).slice(0, 8)}` : "", ev.message?.role ?? "");
    }
  }
  console.log(ts(), "SSE EOF after", frames.length, "frames");
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function send(label, message) {
  console.log(ts(), `>>> SEND ${label}: ${message}`);
  await api(`/api/agent/${sid}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "prompt", message }),
  });
}

async function watch(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // poll state every 5s like the store's reconcile, and check the session file truth
    await sleep(5_000);
    try {
      const st = await api(`/api/agent/${sid}`);
      const sess = await api(`/api/sessions/${sid}`);
      const msgs = sess.context?.messages ?? [];
      console.log(ts(), `state running=${st.running} stream=${st.state?.isStreaming ?? "?"} prompt=${st.state?.isPromptRunning ?? "?"} ctx=${JSON.stringify(st.state?.contextUsage ?? null)} | disk msgs=${msgs.length} last=${msgs[msgs.length - 1]?.role ?? "-"}`);
    } catch (e) { console.log(ts(), "poll err", e.message); }
  }
}

await sleep(2000);
await send("first", "Reply with exactly: ALPHA");
await watch(30000);
await send("follow-up", "Reply with exactly: BETA");
await watch(45000);
console.log(ts(), "DONE. frame sequence:", frames.join(" -> "));
ac.abort();
process.exit(0);
