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
eq(r.action, "replay", "idle tap replays the message");
r = step(initialVoiceUi, "long_press");
eq(r.action, "start_recording", "idle hold starts recording (walkie-talkie)");
eq(r.ui.recording, "on", "hold arms recording");

// hold cycle: clean release sends, slide-off cancels
let held = r.ui;
r = step(held, "long_release");
eq(r.action, "stop_send", "clean release sends the recording");
eq(r.ui.recording, "off", "release clears recording");
r = step(held, "hold_cancel");
eq(r.action, "discard_recording", "slide-off discards the recording");
eq(r.ui.recording, "off", "slide-off clears recording");

// recording (double-tap path)
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

// run: hold records a follow-up (queued next turn), tap does nothing
let run = step(initialVoiceUi, "run_started").ui;
r = step(run, "tap");
eq(r.action, null, "working tap does nothing");
r = step(run, "long_press");
eq(r.action, "start_recording", "working hold records a follow-up");
r = step(r.ui, "long_release");
eq(r.action, "stop_send", "follow-up release sends");
eq(r.ui.runActive, true, "send does not touch the run");
r = step(r.ui, "run_ended");
eq(voicePhase(r.ui), "idle", "run_ended returns to idle");

// countdown machinery is still total (armed directly; the STOP button aborts)
const armed = { ...initialVoiceUi, countdown: true };
r = step(armed, "long_release");
eq(r.action, "cancel_stop_countdown", "release cancels a countdown");
r = step(armed, "hold_cancel");
eq(r.action, "cancel_stop_countdown", "slide-off cancels a countdown");
r = step(armed, "countdown_done");
eq(r.action, "stop_run", "completed countdown stops the run");
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
eq(r.action, "stop_playback_start_recording", "hold during playback records over it");
eq(r.ui.playback, "off", "hold stops playback");

// overlap priorities: recording wins hold over run; playback supplies the tap
const both = step(
  step(initialVoiceUi, "run_started").ui,
  "playback_started",
).ui;
r = step(both, "long_press");
eq(r.action, "stop_playback_start_recording", "hold records even mid-run playback");
r = step(both, "tap");
eq(r.action, "pause_playback", "tap still pauses the playback");
const recOverRun = step(run, "double_tap").ui;
r = step(recOverRun, "long_press");
eq(r.action, "discard_recording", "recording wins hold over run");

// glow phases
eq(voicePhase(initialVoiceUi), "idle", "phase: idle");
eq(voicePhase({ ...initialVoiceUi, recording: "on" }), "recording", "phase: recording");
eq(voicePhase({ ...initialVoiceUi, recording: "paused" }), "recording_paused", "phase: paused recording");
eq(voicePhase({ ...initialVoiceUi, runActive: true }), "working", "phase: working");
eq(voicePhase({ ...initialVoiceUi, playback: "on" }), "playing", "phase: playing");
eq(voicePhase({ ...initialVoiceUi, playback: "paused" }), "playing_paused", "phase: paused playback");
eq(voicePhase({ ...initialVoiceUi, recording: "on", runActive: true }), "recording", "phase: recording beats run");

console.log(failures === 0 ? "\nvoice-mode-check: all green" : `\nvoice-mode-check: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
