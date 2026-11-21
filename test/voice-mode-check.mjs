// Voice-mode pure-logic regression check (PHASE-14/17/18/19): banner state machine
// (mode × announced × bannerVerified), transcript recovery/strip, prompt-file parsing,
// the gesture reducer (the glow-family map), the display slot machine, and the
// chunk-cut policy. Loads the REAL built bundle like the other harnesses.
//
// Usage: npm run check        (builds first)
//        node test/voice-mode-check.mjs   (uses existing dist/main.js)

import { createRequire, Module } from "node:module";

const stub = await import("./obsidian-stub.mjs");

const origLoad = Module._load;
Module._load = (id, parent, isMain) =>
  id === "obsidian" ? stub : origLoad(id, parent, isMain);

const require = createRequire(import.meta.url);
const bundle = require("../dist/main.js");

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const eq = (got, want, label) =>
  ok(
    JSON.stringify(got) === JSON.stringify(want),
    `${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  );

const {
  decideBanner,
  recoverAnnounced,
  stripVoiceBlocks,
  parseVoiceBlock,
  parsePromptFile,
  wrapVoiceBlock,
  reduceVoiceUi,
  voicePhase,
  initialVoiceUi,
  reduceSlot,
  slotView,
  initialSlotState,
  chunkCutAction,
  currentActivity,
  toolActivity,
  ChunkCursor,
  chunkTextCuts,
  findChunk0End,
} = bundle;

// ---------------------------------------------------------------- banner decisions

eq(decideBanner("voice", null, false), "enter", "first voice prompt announces");
eq(decideBanner("normal", null, false), null, "default mode says nothing");
eq(decideBanner("voice", "normal", true), "enter", "normal -> voice is a state change");
eq(decideBanner("normal", "voice", true), "exit", "voice -> normal is a state change");
eq(decideBanner("normal", "voice", false), "exit", "state change beats unverified");
eq(decideBanner("voice", "voice", true), null, "already announced and verified stays quiet");
eq(decideBanner("voice", "voice", false), "reenter", "unverified re-announces");
eq(decideBanner("normal", "normal", true), null, "normal stays silent");
eq(decideBanner("normal", "normal", false), null, "normal ignores verification");

// ------------------------------------------------------- recovery / strip / parsing

const ENTER = "<voice-mode>IMPORTANT: THE USER IS INTERACTING IN **VOICE MODE**.</voice-mode>";
const EXIT = "<voice-mode>IMPORTANT: VOICE MODE IS OFF.</voice-mode>";

eq(recoverAnnounced([]), null, "empty transcript announces nothing");
eq(recoverAnnounced(["plain text"]), null, "blockless transcript announces nothing");
eq(recoverAnnounced([`${ENTER}\n\nhello`]), "voice", "enter block recovers voice");
eq(recoverAnnounced([`${ENTER}\n\nhello`, `${EXIT}\n\nback to typing`]), "normal", "exit block recovers normal");
eq(recoverAnnounced([`${ENTER}\n\na`, `${EXIT}\n\nb`, `${ENTER}\n\nc`]), "voice", "last block wins");
eq(recoverAnnounced([`${EXIT}\n\na`, "plain", `${ENTER}\n\nb`, "plain"]), "voice", "interleaved plain text is ignored");

eq(parseVoiceBlock(`${ENTER}\n\nhello`), "IMPORTANT: THE USER IS INTERACTING IN **VOICE MODE**.", "leading block body parsed");
eq(parseVoiceBlock("hello"), null, "no block parses null");

eq(stripVoiceBlocks("plain text"), "plain text", "plain text untouched");
eq(stripVoiceBlocks(`${ENTER}\n\nhello`), "hello", "leading block stripped");
eq(stripVoiceBlocks(EXIT), "", "block-only becomes empty");
eq(stripVoiceBlocks(`intro\n\n${ENTER}\n\nhello`), "intro\n\nhello", "mid-message block stripped");

eq(parsePromptFile("comment\n---\nBODY\n", "FB"), "BODY", "marker splits file");
eq(parsePromptFile("no marker here", "FB"), "no marker here", "markerless file is all body");
eq(parsePromptFile("   ", "FB"), "FB", "empty file falls back");
eq(wrapVoiceBlock("BLOCK", "hello"), "BLOCK\n\nhello", "block stacks above prompt");

// --------------------------------------------------------------- gesture scenarios
// PHASE-17: touch actions apply to THE GLOW — red = recording, green = TTS,
// white = run, none = repeat/record/none. Double-tap finishes without losing
// anything; long-press is the destructive action.

const step = (ui, ev) => reduceVoiceUi(ui, ev);
const rec0 = step(initialVoiceUi, "double_tap").ui; // recording, not yet spoken
const rec = step(rec0, "audio_registered").ui; // speech registered

// idle
let r = step(initialVoiceUi, "tap");
eq(r.action, "replay", "idle tap repeats the response on screen");
r = step(initialVoiceUi, "long_press");
eq(r.action, null, "idle long-press is a no-op (nothing destructive to do)");
r = step(initialVoiceUi, "long_release");
eq(r.action, null, "idle release does nothing");
r = step(initialVoiceUi, "hold_cancel");
eq(r.action, null, "slide-off cancels the hold — destructive needs the full hold");
r = step(initialVoiceUi, "double_tap");
eq(r.action, "start_recording", "idle double-tap starts recording");
eq(r.ui.recording, "on", "recording on");
eq(r.ui.hasAudio, false, "new recording starts with no registered audio");

// recording (tap pauses/resumes; double-tap sends; long-press discards)
r = step(rec, "tap");
eq(r.action, "pause_recording", "recording tap pauses");
r = step(r.ui, "tap");
eq(r.action, "resume_recording", "paused tap resumes");
r = step(rec, "long_press");
eq(r.action, "discard_recording", "recording long-press discards");
eq(r.ui.recording, "off", "discard clears recording");
r = step(rec, "double_tap");
eq(r.action, "stop_send", "recording double-tap sends");
eq(r.ui.recording, "off", "send clears recording");
eq(r.ui.sttWait, true, "send arms the red STT chaser");

// double-tap with NO registered audio = nothing (nothing to send)
r = step(rec0, "double_tap");
eq(r.action, null, "double-tap with no audio does nothing");
eq(r.ui.recording, "on", "still recording");
r = step(rec0, "long_press");
eq(r.action, "discard_recording", "long-press discards even an empty recording");

// the red chaser: all gestures inert while STT works
let wait = step(rec, "double_tap").ui;
r = step(wait, "tap");
eq(r.action, null, "stt-wait tap does nothing");
r = step(wait, "double_tap");
eq(r.action, null, "stt-wait double-tap does nothing");
r = step(wait, "long_press");
eq(r.action, null, "stt-wait long-press does nothing");
r = step(wait, "stt_ended");
eq(r.ui.sttWait, false, "stt_ended clears the chaser");
r = step({ ...wait, runActive: true }, "run_started");
eq(r.ui.sttWait, false, "run_started clears a leftover chaser");

// run (white): destructive long-press only — NO follow-up recordings (Gap D #1)
let run = step(initialVoiceUi, "run_started").ui;
r = step(run, "tap");
eq(r.action, null, "working tap does nothing");
r = step(run, "double_tap");
eq(r.action, null, "working double-tap does nothing — no follow-up recordings");
r = step(run, "long_press");
eq(r.action, "stop_run", "working long-press stops the run (immediate — no countdown)");
eq(r.ui.runActive, true, "run still active until run_ended");
r = step(r.ui, "run_ended");
eq(voicePhase(r.ui), "idle", "run_ended returns to idle");

// playback (green): tap pauses, double-tap skips (cache-only), long-press = run rules
let play = step(initialVoiceUi, "playback_started").ui;
r = step(play, "tap");
eq(r.action, "pause_playback", "playback tap pauses");
r = step(r.ui, "tap");
eq(r.action, "resume_playback", "paused playback tap resumes");
r = step(play, "double_tap");
eq(r.action, "skip_playback", "playback double-tap skips (finishes to cache, never plays)");
eq(r.ui.playback, "off", "skip clears the playback flag");
r = step(play, "long_press");
eq(r.action, null, "green long-press with no run does nothing");
const greenRun = step(
  step(initialVoiceUi, "run_started").ui,
  "playback_started",
).ui;
r = step(greenRun, "long_press");
eq(r.action, "stop_run", "green long-press with a run stops the run");
r = step(greenRun, "tap");
eq(r.action, "pause_playback", "tap still pauses the playback over a run");

// overlap priorities: recording wins long-press over run
const recOverRun = step(
  step(initialVoiceUi, "run_started").ui,
  "double_tap",
).ui;
eq(recOverRun.recording, "off", "double-tap never starts recording over a run");

// recorder policy events (PHASE-18)
r = step(rec0, "audio_registered");
eq(r.ui.hasAudio, true, "audio_registered sets the send guard");
r = step(rec, "silence_pause");
eq(r.action, "pause_recording", "30 s silence with audio pauses (preserve the work)");
eq(r.ui.recording, "paused", "silence-paused");
r = step(rec, "silence_discard");
eq(r.action, "discard_recording", "30 s silence with no audio discards");
r = step(rec0, "silence_discard");
eq(r.action, "discard_recording", "accidental start (never spoke) discards");
r = step({ ...rec, capWarning: true }, "cap_reached");
eq(r.action, "pause_recording", "the cap auto-pauses");
eq(r.ui.capReached, true, "cap is reached");
eq(r.ui.capWarning, false, "the blink gives way to red static at the cap");
r = step(r.ui, "tap");
eq(r.action, null, "cap-paused tap does nothing — the cap is absolute");
r = step(r.ui, "double_tap");
eq(r.action, "stop_send", "cap-paused double-tap sends");
r = step(initialVoiceUi, "cap_reached");
eq(r.ui.capReached, false, "cap_reached with no recording is inert");

// glow phases (precedence: red > green > white > off)
eq(voicePhase(initialVoiceUi), "idle", "phase: idle");
eq(voicePhase({ ...initialVoiceUi, recording: "on" }), "recording", "phase: recording");
eq(
  voicePhase({ ...initialVoiceUi, recording: "on", capWarning: true }),
  "recording_warning",
  "phase: cap warning blink",
);
eq(
  voicePhase({ ...initialVoiceUi, recording: "paused" }),
  "recording_paused",
  "phase: paused recording",
);
eq(voicePhase({ ...initialVoiceUi, sttWait: true }), "stt_waiting", "phase: red STT chaser");
eq(voicePhase({ ...initialVoiceUi, runActive: true }), "working", "phase: working");
eq(voicePhase({ ...initialVoiceUi, playback: "on" }), "playing", "phase: playing");
eq(
  voicePhase({ ...initialVoiceUi, playback: "paused" }),
  "playing_paused",
  "phase: paused playback",
);
eq(
  voicePhase({ ...initialVoiceUi, recording: "on", runActive: true }),
  "recording",
  "phase: recording beats run",
);
eq(
  voicePhase({ ...initialVoiceUi, sttWait: true, runActive: true }),
  "stt_waiting",
  "phase: red chaser beats white",
);
eq(
  voicePhase({ ...initialVoiceUi, playback: "on", runActive: true }),
  "playing",
  "phase: green beats white",
);

// activity readout (0.5.1): thinking / live tool phrases / nothing in between
const user = (t) => ({ role: "user", content: t });
const asst = (blocks) => ({ role: "assistant", content: blocks, model: "m", provider: "p" });
const think = () => ({ type: "thinking", thinking: "hmm" });
const call = (id, name) => ({ type: "toolCall", toolCallId: id, toolName: name, input: {} });
const result = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }] });
const text = (t) => ({ type: "text", text: t });

eq(toolActivity("bash"), "bashing", "tool phrase: bash");
eq(toolActivity("web_search"), "searching the web", "tool phrase: web_search");
eq(toolActivity("grep"), "grepping", "tool phrase: grep");
eq(toolActivity("Bash"), "bashing", "tool phrase: case-insensitive");
eq(toolActivity("multi_search"), "multi searching", "tool phrase: gerund fallback");

eq(currentActivity([]), null, "activity: empty transcript");
eq(currentActivity([user("hi"), asst([text("yo")]), user("more")]), null,
  "activity: user tail (fresh prompt) is null even after old thinking");
eq(currentActivity([user("hi"), asst([think()])]), "thinking",
  "activity: thinking tail");
eq(currentActivity([user("hi"), asst([think(), call("a", "bash")])]), "bashing",
  "activity: live tool call wins over earlier thinking");
eq(currentActivity([user("hi"), asst([think(), call("a", "bash")]), result("a")]), null,
  "activity: resolved tool + non-thinking tail = nothing (no 'working')");
eq(currentActivity([user("hi"), asst([think(), call("a", "bash")]), result("a"),
  asst([think()])]), "thinking",
  "activity: new thinking after tool round");
eq(currentActivity([user("hi"), asst([call("a", "bash"), call("b", "web_search")]),
  result("a")]), "searching the web",
  "activity: parallel calls — newest unresulted wins");
eq(currentActivity([user("hi"), asst([text("reply")])]), null,
  "activity: streaming reply = nothing");
eq(currentActivity([user("hi"), asst([])]), null,
  "activity: empty assistant message = nothing");

// streaming chunking (0.5.2): chunk 0 + the server chunk_text port
eq(chunkTextCuts("short text, under the chunk max"), [], "cuts: short text has none");
eq(chunkTextCuts("a".repeat(380) + ". " + "b".repeat(30)), [],
  "cuts: sub-40 tail scrap merges away its cut (server tail_merge)");
eq(chunkTextCuts("a".repeat(380) + ". " + "b".repeat(60)), [382],
  "cuts: sentence cut at 382, kept when the tail is big enough");
eq(chunkTextCuts("x".repeat(150) + "\n\n" + "y".repeat(150) + ". " + "z".repeat(300)),
  [152, 304],
  "cuts: paragraph past the min beats the sentence end, then the next cut");

eq(findChunk0End("Hello there. More"), 13, "chunk0: first sentence break");
eq(findChunk0End("Hi\nMore text."), 3, "chunk0: line break beats the later sentence");
eq(findChunk0End("Done."), 5, "chunk0: sentence ending at the text end fires");
eq(findChunk0End("hello"), -1, "chunk0: nothing broken yet");
eq(findChunk0End(Array(100).fill("word").join(" ")), 400,
  "chunk0: word-gap fallback past the max");

const cur = new ChunkCursor();
eq(cur.feed("The capital of Fran"), [], "cursor: mid-sentence stays put");
eq(cur.feed("The capital of France is Paris. And more co"),
  [{ kind: "opener", text: "The capital of France is Paris." }],
  "cursor: opener fires at the first break");
eq(cur.feed("The capital of France is Paris. And more co"), [],
  "cursor: feeding the same text twice is a no-op");
eq(cur.flush("The capital of France is Paris. And more co"),
  [{ kind: "tail", text: "And more co" }],
  "cursor: flush speaks the open tail");

// exactly-once: chunks reassemble the message, words in order
const longMsg = Array(12).fill("Sentence one is here. Sentence two follows nicely.").join("\n\n");
const cur2 = new ChunkCursor();
const spoken = [];
for (const n of [250, 450, longMsg.length]) {
  for (const c of cur2.feed(longMsg.slice(0, n))) spoken.push(c.text);
}
for (const c of cur2.flush(longMsg)) spoken.push(c.text);
eq(spoken.join(" ").replace(/\s+/g, " ").trim(),
  longMsg.replace(/\s+/g, " ").trim(),
  "cursor: every word spoken exactly once, in order");

// glow precedence (0.5.2): green breath > green chase > white breath
eq(voicePhase({ ...initialVoiceUi, runActive: true }, "playing"), "playing",
  "phase: green breath beats white breath mid-run");
eq(voicePhase({ ...initialVoiceUi, runActive: true }, "synthesizing"), "synthesizing",
  "phase: green chase beats white breath mid-run");
eq(voicePhase({ ...initialVoiceUi, runActive: true }, "off", true), "connecting",
  "phase: white chase before the run starts");
eq(voicePhase({ ...initialVoiceUi, runActive: true }, "off"), "working",
  "phase: white breath when no TTS is happening");
eq(voicePhase({ ...initialVoiceUi, recording: "on", runActive: true }, "playing"),
  "recording", "phase: recording still beats everything");

// ---------------------------------------------- display slot (0.5.31 model)
// Replace-on-arrival: read head > streaming reply > sticky activity > last
// reply > nothing. Tail entries carry idx -1 until they LAND (index drift on
// the old messages.length sentinel split replies mid-message).

const sev = (state, ev) => reduceSlot(state, ev);
const ctx = (over = {}) => ({
  tailStreaming: false,
  running: false,
  activity: null,
  lastAssistantIdx: -1,
  ...over,
});
let sl = initialSlotState;

// priority 5/4 — nothing vs the last reply (the final-reply rule)
eq(slotView(sl, ctx()), { kind: "activity" }, "fresh session: nothing to show");
eq(
  slotView(sl, ctx({ lastAssistantIdx: 7 })),
  { kind: "message", idx: 7, streaming: false },
  "final reply on screen",
);

// priority 2 — a streaming reply takes over immediately
eq(
  slotView(sl, ctx({ tailStreaming: true, lastAssistantIdx: 7 })),
  { kind: "message", idx: -1, streaming: true },
  "stream-in replaces the final",
);

// priority 3 — activity shows while running (and the gap is never blank)
eq(
  slotView(sl, ctx({ running: true, activity: "thinking", lastAssistantIdx: 7 })),
  { kind: "activity" },
  "activity shows over the final mid-run",
);
eq(
  slotView(sl, ctx({ running: false, activity: "thinking", lastAssistantIdx: 7 })),
  { kind: "message", idx: 7, streaming: false },
  "a stale phrase never out-ranks the last reply after the run",
);
eq(
  slotView(sl, ctx({ running: true, activity: null, lastAssistantIdx: 7 })),
  { kind: "message", idx: 7, streaming: false },
  "gap before the first phrase: the final fills it (never blank)",
);

// priority 1 — the read head wins; idx -1 = the streaming tail, live
sl = sev(sl, { type: "utterance_begun", uttId: 1, idx: -1 });
eq(
  slotView(sl, ctx({ tailStreaming: true, running: true, activity: "thinking", lastAssistantIdx: 2 })),
  { kind: "message", idx: -1, streaming: true },
  "being read wins over everything; the tail displays live",
);

// the tail landing repairs the entry's index (the drift fix)
sl = sev(sl, { type: "utterance_landed", uttId: 1, idx: 4 });
eq(
  slotView(sl, ctx({ lastAssistantIdx: 4 })),
  { kind: "message", idx: 4, streaming: false },
  "utterance_landed repairs the display to the landed reply",
);
sl = sev(sl, { type: "utterance_landed", uttId: 999, idx: 8 });
eq(
  slotView(sl, ctx({ lastAssistantIdx: 4 })),
  { kind: "message", idx: 4, streaming: false },
  "unknown utterance_landed is inert",
);

// queued replies wait their turn
sl = sev(sl, { type: "utterance_begun", uttId: 2, idx: -1 });
eq(
  slotView(sl, ctx({ tailStreaming: true })),
  { kind: "message", idx: 4, streaming: false },
  "a new tail queues behind the reply being read",
);
sl = sev(sl, { type: "utterance_complete", uttId: 1 });
eq(
  slotView(sl, ctx({ tailStreaming: true })),
  { kind: "message", idx: -1, streaming: true },
  "queue top mid-generation displays streaming in",
);

// read completion falls back in order — never blank
sl = sev(sl, { type: "utterance_complete", uttId: 2 });
eq(
  slotView(sl, ctx({ running: true, activity: "bashing" })),
  { kind: "activity" },
  "intermediate read done: the current action shows",
);
eq(
  slotView(sl, ctx({ lastAssistantIdx: 5 })),
  { kind: "message", idx: 5, streaming: false },
  "nothing else around: the reply stays on screen",
);

// a stopped final (skip counts as read) stays for tap-to-repeat
sl = sev(sl, { type: "utterance_begun", uttId: 3, idx: 7 });
sl = sev(sl, { type: "utterance_complete", uttId: 3 });
eq(
  slotView(sl, ctx({ lastAssistantIdx: 7 })),
  { kind: "message", idx: 7, streaming: false },
  "stopped final stays on screen",
);

// flush (stop run / voice off): the queue drops, the last reply remains
sl = sev(sl, { type: "utterance_begun", uttId: 4, idx: -1 });
sl = sev(sl, { type: "flush" });
eq(
  slotView(sl, ctx({ lastAssistantIdx: 7 })),
  { kind: "message", idx: 7, streaming: false },
  "flush drops the queue but keeps the last reply",
);

// unknown utterance completions are inert
sl = sev(sl, { type: "utterance_complete", uttId: 999 });
eq(
  slotView(sl, ctx({ lastAssistantIdx: 7 })),
  { kind: "message", idx: 7, streaming: false },
  "unknown completion is inert",
);

// ------------------------- activity phrases from the streaming tail (0.5.31)
// The store keeps the in-flight message out of messages[] — phrases whose
// blocks live in the tail were structurally invisible before this.
{
  const thinkTail = { role: "assistant", content: [think()], model: "m", provider: "p" };
  eq(currentActivity([], thinkTail), "thinking", "thinking shows from the streaming tail");
  const callTail = { role: "assistant", content: [call("t9", "web_search")], model: "m", provider: "p" };
  eq(currentActivity([], callTail), "searching the web", "live tool call shows from the streaming tail");
  eq(currentActivity([], null), null, "no tail, no messages: nothing");
  const landed = [user("go"), asst([call("t9", "bash")]), result("t9")];
  eq(currentActivity(landed, null), null, "a resolved tool call is not current");
  eq(currentActivity(landed, thinkTail), "thinking", "the tail outranks landed history");
}

// ------------------------------------------- chunk-cut policy (PHASE-18B)

eq(chunkCutAction(10_000, 3_000, true), "none", "under the min chunk size: no cut");
eq(chunkCutAction(21_000, 2_400, true), "none", "silence under 2.5s: no cut");
eq(chunkCutAction(21_000, 2_600, true), "cut_silence", "min size + long silence: cut at the silence onset");
eq(chunkCutAction(21_000, 0, true), "none", "mid-speech under the ceiling: no cut");
eq(chunkCutAction(21_000, 2_600, false), "none", "no speech yet: never cut");
eq(chunkCutAction(61_000, 0, true), "cut_now", "ceiling mid-speech: hard cut at the live edge");
eq(chunkCutAction(61_000, 1_500, true), "cut_silence", "ceiling in silence: cut at the onset instead");
eq(chunkCutAction(61_000, 0, false), "cut_now", "ceiling without speech (defensive): cut");

console.log(failures === 0 ? "\nvoice-mode-check: all green" : `\nvoice-mode-check: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
