// Speak-context — pi-obsidian shim (0.5.6): the message Read button's audio
// backend. A module global re-pointed on every render pass (the api-base /
// markdown-context pattern), so two tabs on different machines don't race it.
//
// The implementation lives in the voice-mode TTS pipeline (VoiceController):
// settings.ttsUrl + the same ChunkCursor chunking as voice mode — identical
// rhythm by construction. An explicit Read press interrupts whatever is
// speaking (voice speech included): user action wins.

export type SpeakPhase = "loading" | "playing" | "idle";

export type SpeakListener = (id: string | null, phase: SpeakPhase, error?: string) => void;

export interface SpeakController {
  /** Interrupt anything speaking and read this message's text. */
  speak(id: string, text: string): void;
  /** Stop the current read-aloud. */
  stop(): void;
  /** Pipeline observation: active message id, phase, optional error. */
  subscribe(fn: SpeakListener): () => void;
}

let controller: SpeakController | null = null;

export function setSpeakController(c: SpeakController | null): void {
  controller = c;
}

export function getSpeakController(): SpeakController | null {
  return controller;
}
