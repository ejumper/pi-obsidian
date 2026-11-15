// Voice-mode pure-logic regression check (PHASE-14): banner state machine
// (mode × announced × bannerVerified), transcript recovery/strip, prompt-file parsing,
// and the gesture reducer (every path of the state × event table incl. the stop-run
// countdown). Loads the REAL built bundle like the other harnesses.
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

const step = (ui, ev) => reduceVoiceUi(ui, ev);

// idle
let r = step(initialVoiceUi, "tap");
eq(r.action, "replay", "idle tap replays (universal pause/play)");
r = step(initialVoiceUi, "long_press");
eq(r.action, "replay", "idle long-press replays");
r = step(initialVoiceUi, "long_release");
eq(r.action, null, "idle release does nothing");

// recording (double-tap records; tap pauses; long-press discards)
let rec = step(initialVoiceUi, "double_tap").ui;
r = step(rec, "tap");
eq(r.action, "pause_recording", "recording tap pauses");
r = step(r.ui, "tap");
eq(r.action, "resume_recording", "paused tap resumes");
r = step(rec, "long_press");
eq(r.action, "discard_recording", "recording long-press discards");
r = step(rec, "double_tap");
eq(r.action, "stop_send", "recording double-tap sends");
eq(r.ui.recording, "off", "send clears recording");

// run: long-press arms the stop-run countdown (held through 3…2…1)
let run = step(initialVoiceUi, "run_started").ui;
r = step(run, "tap");
eq(r.action, null, "working tap does nothing");
r = step(run, "long_press");
eq(r.action, "show_stop_countdown", "working long-press arms the countdown");
eq(r.ui.countdown, true, "countdown armed");
r = step(r.ui, "long_release");
eq(r.action, "cancel_stop_countdown", "release cancels the countdown");
r = step(run, "long_press");
r = step(r.ui, "countdown_done");
eq(r.action, "stop_run", "held countdown stops the run");
eq(r.ui.runActive, true, "run still active until run_ended");
r = step(r.ui, "run_ended");
eq(voicePhase(r.ui), "idle", "run_ended returns to idle");
r = step(initialVoiceUi, "countdown_done");
eq(r.action, null, "stray countdown_done is a no-op");

// queued follow-up while running (typing parity: send queues, run continues)
let q = step(run, "double_tap");
eq(q.action, "start_recording", "working double-tap records a follow-up");
q = step(q.ui, "double_tap");
eq(q.action, "stop_send", "follow-up sends");
eq(q.ui.runActive, true, "send does not touch the run");

// playback
let play = step(initialVoiceUi, "playback_started").ui;
r = step(play, "tap");
eq(r.action, "pause_playback", "playback tap pauses");
r = step(r.ui, "tap");
eq(r.action, "resume_playback", "paused tap resumes");
r = step(play, "double_tap");
eq(r.action, "stop_playback_start_recording", "playback double-tap records over it");
eq(r.ui.playback, "off", "recording stops playback");
r = step(play, "long_press");
eq(r.action, "replay", "playback long-press replays");

// overlap priorities: recording wins long-press over run; run wins over playback
const both = step(
  step(initialVoiceUi, "run_started").ui,
  "playback_started",
).ui;
r = step(both, "long_press");
eq(r.action, "show_stop_countdown", "run wins long-press over playback");
r = step(both, "tap");
eq(r.action, "pause_playback", "tap still pauses the playback");
const recOverRun = step(run, "double_tap").ui;
r = step(recOverRun, "long_press");
eq(r.action, "discard_recording", "recording wins long-press over run");

// glow phases
eq(voicePhase(initialVoiceUi), "idle", "phase: idle");
eq(voicePhase({ ...initialVoiceUi, recording: "on" }), "recording", "phase: recording");
eq(voicePhase({ ...initialVoiceUi, recording: "paused" }), "recording_paused", "phase: paused recording");
eq(voicePhase({ ...initialVoiceUi, runActive: true }), "working", "phase: working");
eq(voicePhase({ ...initialVoiceUi, playback: "on" }), "playing", "phase: playing");
eq(voicePhase({ ...initialVoiceUi, playback: "paused" }), "playing_paused", "phase: paused playback");
eq(voicePhase({ ...initialVoiceUi, recording: "on", runActive: true }), "recording", "phase: recording beats run");

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

console.log(failures === 0 ? "\nvoice-mode-check: all green" : `\nvoice-mode-check: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
