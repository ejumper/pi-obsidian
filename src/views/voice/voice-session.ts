/**
 * Per-session voice-mode banner glue (PHASE-14 §1.1) — ties the pure banner machine
 * (banner-state.ts) to a session's send path. Every outgoing prompt (voice or typed) passes
 * through `wrapOutgoing`: the `<voice-mode>` block rides in-band at the top of the text and
 * announces state changes exactly once (loud enter / loud exit), mirroring pi's read-mode
 * extension. `reenter` covers compaction/rebind: when the last banner is not verifiably in
 * the model's context any more, the loud enter block is sent again instead of holding a
 * quiet line on every prompt.
 */
import { decideBanner, recoverAnnounced, type VoiceMode } from "./banner-state";
import { wrapVoiceBlock, type VoicePrompts } from "./prompts";

export class VoiceSession {
  /** The UI toggle: which mode THIS send is made from. */
  mode: VoiceMode = "normal";

  /** Mode of the last block in the transcript (self-describing; recovered on bind). */
  private announced: VoiceMode | null = null;

  /** The last banner sent is verifiably still in the model's context. */
  private bannerVerified = false;

  private lastTokens: number | null = null;

  constructor(private readonly prompts: VoicePrompts) {}

  /** (Re)open a session: recover `announced` from its transcript, re-announce later if needed. */
  bind(messageTexts: string[]): void {
    this.announced = recoverAnnounced(messageTexts);
    this.bannerVerified = false;
    this.lastTokens = null;
  }

  /**
   * Compaction heuristic: a large context-usage drop between sends means a compaction
   * summarised the banner away (read-mode's reason for its hold line, which we replaced
   * with re-announcement). Errs toward re-announcing — a false positive costs one
   * invisible block.
   */
  noteContextTokens(tokens: number | null): void {
    if (tokens !== null && this.lastTokens !== null && tokens < this.lastTokens * 0.7) {
      this.bannerVerified = false;
    }
    this.lastTokens = tokens;
  }

  /**
   * Wrap an outgoing prompt with the banner block if the state needs announcing.
   * Call this for BOTH voice prompts and typed prompts (a typed prompt while the session
   * was left in voice mode is exactly the state change that must be announced).
   */
  wrapOutgoing(text: string): string {
    const action = decideBanner(this.mode, this.announced, this.bannerVerified);
    if (action === null) return text;
    const body = action === "exit" ? this.prompts.exit : this.prompts.enter;
    this.announced = this.mode;
    this.bannerVerified = true;
    return wrapVoiceBlock(body, text);
  }
}
