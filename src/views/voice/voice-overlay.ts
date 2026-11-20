/**
 * Voice-mode overlay DOM (PHASE-14 §1.2) — the dumb view layer that covers the
 * chat transcript while voice mode is on (the transcript stays mounted
 * underneath). It owns DOM only: pane geometry, the glow state machine (colors ×
 * modes ported from pi-voice-chat's app/chat/chat.css), the activity/hint readout
 * text, the last-message render through the existing React transcript renderer,
 * and the driving-tested pointer gesture set (320 ms double-tap window, 1 000 ms
 * long press, 12 px drift cancel — the /chat timings). Every decision lives in
 * VoiceController: this class reports raw gestures upward and paints what it is
 * told. No Obsidian imports — plain DOM plus the project's own modules.
 *
 * Geometry: the pane is prepended INSIDE the transcript container with
 * `position: absolute; inset: 0` (the container is made `position: relative`),
 * so it covers the container's box exactly. An abspos child of a SCROLL
 * container scrolls with the content though — the transcript is usually pinned
 * to the bottom — so a scroll mirror keeps the pane over the *visible* area via
 * translateY(scrollTop). The glow lives in an oversized box (chat parity: the
 * conic mask must never clip the halo spill) that the pane's own overflow
 * clips — neither may grow the transcript's scrollable area. The pane is
 * pointer-events: none except the gesture surface (with 28px side gutters for
 * panel swipes) and the message column, so edge swipes reach the panels.
 */

import type { VoiceGlowPhase } from "./gesture-state";
import type { AgentMessage } from "../../api/types";
import { stripMessageVoiceBlocks } from "./banner-state";
import { computeTranscriptUnits } from "../message-display";
import { TranscriptRenderer } from "../react/Transcript";
import { getMarkdownContext } from "../react/pi-web/markdown-context";

export interface VoiceOverlayHandlers {
  onTap(): void;
  onDoubleTap(): void;
  onLongPress(): void;
  /** Clean release after a hold (swiped=false) or slide-off cancel (swiped=true). */
  onLongRelease(swiped: boolean): void;
  /** Visible STOP button (the hold gesture records now, so stop-run lives here). */
  onStopRun?: () => void;
}

export interface VoiceOverlayOptions {
  container: HTMLElement;          // the transcript container element to overlay
  handlers: VoiceOverlayHandlers;
  onFirstGesture?: () => void;     // fire once on the first pointer interaction (autoplay unlock)
  /** Title-bar element — kept clear of the gesture layer's tap surface. */
  avoidEl?: HTMLElement;
  /** Grow the pane to the viewport bottom (mobile nav takeover, like the composer). */
  extendBottom?: boolean;
  apiBase: string;                 // passed through to the transcript renderer
  cwd: string;
  sessionId?: string;
}

/** Gesture timings ported from pi-voice-chat's driving UI. */
const DOUBLE_TAP_MS = 320;
const LONG_PRESS_MS = 1000;
/** Drift from the pointerdown origin that cancels the long press AND turns the
 *  gesture into a swipe (scroll / panel gesture — never a tap on release). */
const DRIFT_PX = 12;

const GLOW_PHASES: readonly VoiceGlowPhase[] = [
  "idle",
  "recording",
  "recording_warning",
  "recording_paused",
  "stt_waiting",
  "connecting",
  "working",
  "synthesizing",
  "playing",
  "playing_paused",
];

/** TranscriptRenderer's ctx type without importing obsidian (it travels along
 *  transitively through Transcript.tsx). */
type RendererCtx = ConstructorParameters<typeof TranscriptRenderer>[1];

function plainForVoice(m: AgentMessage): AgentMessage {
  if (m.role !== "assistant") return m;
  // Voice pane shows the reply TEXT only (beta14): thinking/tool blocks are
  // dropped and MessageView's chrome disappears with its data — the model label
  // keys off `provider`, the usage/time footer off `usage` (its JSX
  // conditionals), so emptying them beats CSS whack-a-mole.
  return {
    ...m,
    content: m.content.filter((b) => b.type === "text"),
    provider: "",
    model: "",
    usage: undefined,
    timestamp: undefined,
  };
}

function div(cls: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  return el;
}

export class VoiceOverlay {
  readonly el: HTMLElement;

  private readonly opts: VoiceOverlayOptions;
  private readonly handlers: VoiceOverlayHandlers;
  private readonly gesturesEl: HTMLElement;
  private readonly msgEl: HTMLElement;
  private readonly activityEl: HTMLElement;
  private readonly stopEl: HTMLElement;
  private readonly glowEl: HTMLElement;
  private readonly edgeEl: HTMLElement;
  private readonly renderer: TranscriptRenderer;
  /** Container's viewport rect is re-read by syncPosition() — the pane is a
   *  body-attached fixed layer (the composer's pattern), not a child of the
   *  scroll container. */

  // ---- gesture tracking (one active pointer) ----
  private pointerId: number | null = null;
  private downX = 0;
  private downY = 0;
  private swiped = false;
  private longFired = false;
  private longTimer: number | null = null;
  private tapTimer: number | null = null;
  private firstGestureFired = false;
  private destroyed = false;

  constructor(opts: VoiceOverlayOptions) {
    this.opts = opts;
    this.handlers = opts.handlers;

    // ---- DOM: pane > gestures(> msg) / activity / stop; glow is a SEPARATE
    // body-level layer (beta18) so it can sit above the app header — inside the
    // pane's stacking context the header painted over the frame's top edge ----
    const pane = div("pi-voice-pane");

    const glow = div("pi-voice-glow pi-voice-phase-idle");
    const edge = div("pi-voice-glow-edge");
    // LED-anatomy layers (port of glow-effect/*.html, 0.5.0): wash (far faint
    // falloff), spill (short bright falloff), strip (the bulbs at the edge —
    // the chase recipe's comet IS the strip's gradient, as in the final
    // loading.html). Recipes and colors live in styles.css.
    const washL = div("pi-voice-glow-layer pi-voice-glow-layer--wash");
    washL.append(div("pi-voice-glow-ring"));
    const spillL = div("pi-voice-glow-layer pi-voice-glow-layer--spill");
    spillL.append(div("pi-voice-glow-ring"));
    const stripL = div("pi-voice-glow-layer pi-voice-glow-layer--strip");
    stripL.append(div("pi-voice-glow-ring"));
    edge.append(washL, spillL, stripL);
    glow.append(edge);

    const gestures = div("pi-voice-gestures");
    const msg = div("pi-voice-msg");
    gestures.append(msg);

    const activity = div("pi-voice-activity");

    const stop = document.createElement("button");
    stop.className = "pi-voice-stop";
    stop.textContent = "Stop";
    stop.setAttribute("aria-label", "Stop the running agent");
    stop.addEventListener("click", (e) => {
      e.stopPropagation();
      this.handlers.onStopRun?.();
    });
    pane.append(gestures, activity, stop);
    document.body.appendChild(glow);
    this.el = pane;
    this.glowEl = glow;
    this.edgeEl = edge;
    this.gesturesEl = gestures;
    this.msgEl = msg;
    this.activityEl = activity;
    this.stopEl = stop;

    // ---- containment: body-attached fixed layer pinned to the container's
    // viewport rect (the composer's pattern — see syncPosition()). ----
    document.body.appendChild(pane);
    this.syncPosition();

    // ---- gestures: pointerdown on the surface, move/up/cancel on WINDOW.
    // No setPointerCapture: WebKit/iOS loses pointerup under capture on touch
    // pointers, which wedges the tracker (pointerId never resets → every later
    // tap is ignored). Window-level listeners keep drags leaving the surface
    // resolving correctly without capture.
    gestures.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);

    // ---- last-message render (ONE React root; the banner stays stripped) ----
    // The markdown context is a module global the view's own TranscriptRenderer
    // set at build time — pass it through rather than clobber it (a null stub
    // would blank markdown everywhere, both here and in the transcript).
    this.renderer = new TranscriptRenderer(
      this.msgEl,
      getMarkdownContext() ?? ({ sourcePath: "" } as unknown as RendererCtx),
    );
  }

  setVisible(on: boolean): void {
    if (this.destroyed) return;
    this.el.classList.toggle("pi-voice-visible", on);
    // The glow is a body-level layer (beta18) — CSS-gated to voice mode (beta20).
    this.glowEl.classList.toggle("pi-voice-visible", on);
    // Re-anchor on show: the transcript may have scrolled while hidden.
    if (on) this.syncPosition();
  }

  /** Glow state machine: one `pi-voice-phase-<phase>` class on the glow layer
   *  (color) plus a recipe class — breath (whole string) or chase (comet). */
  /** Centered activity readout ("thinking", "searching the web"…); null hides. */
  setActivity(text: string | null): void {
    if (this.destroyed) return;
    this.activityEl.textContent = text;
    this.activityEl.classList.toggle("pi-voice-activity-on", text !== null);
  }

  /**
   * Audio-reactive glow (0.5.2): while amplitude flows (TTS audible or the mic
   * hot) pin `--breath` to it — the border breathes WITH the audio. null hands
   * control back to the CSS breath (the inline value must go with it or it
   * would out-rank the paused-steady rules).
   */
  setAmp(amp: number | null): void {
    if (this.destroyed) return;
    if (amp === null) {
      this.glowEl.classList.remove("pi-voice-glow-live");
      this.edgeEl.style.removeProperty("--breath");
    } else {
      this.glowEl.classList.add("pi-voice-glow-live");
      this.edgeEl.style.setProperty("--breath", amp.toFixed(3));
    }
  }

  setPhase(phase: VoiceGlowPhase): void {
    for (const p of GLOW_PHASES) this.glowEl.classList.remove(`pi-voice-phase-${p}`);
    this.glowEl.classList.add(`pi-voice-phase-${phase}`);
    // Recipe select (PHASE-17): chase = traveling comet (connecting /
    // synthesizing / stt_waiting); blink = the 1s-on/1s-off cap warning;
    // static = paused (red or green); breath = everything else.
    const chase =
      phase === "connecting" || phase === "synthesizing" || phase === "stt_waiting";
    const blink = phase === "recording_warning";
    const still = phase === "recording_paused" || phase === "playing_paused";
    this.glowEl.classList.toggle("pi-voice-glow-chase", chase);
    this.glowEl.classList.toggle("pi-voice-glow-blink", blink);
    this.glowEl.classList.toggle("pi-voice-glow-static", still);
    this.glowEl.classList.toggle("pi-voice-glow-breath", !chase && !blink && !still);
    // The STOP button exists once a run is in flight (connecting included).
    this.stopEl.style.display =
      phase === "working" || phase === "connecting" ? "" : "none";
  }

  /** Last completed message + the streaming tail — the ONLY things in the units
   *  array; both pass through stripMessageVoiceBlocks so the in-band
   *  `<voice-mode>` banner is invisible here (the whole point of the strip). */
  setLastMessage(msg: AgentMessage | null, streaming: AgentMessage | null): void {
    if (this.destroyed) return;
    this.renderer.update({
      units: computeTranscriptUnits(
        msg ? [stripMessageVoiceBlocks(plainForVoice(msg))] : [],
        streaming !== null,
      ),
      streaming: streaming ? stripMessageVoiceBlocks(plainForVoice(streaming)) : null,
      modelNames: {},
      cwd: this.opts.cwd,
      sessionId: this.opts.sessionId,
      apiBase: this.opts.apiBase,
      onFork: async () => null,
      onNavigate: () => {},
      onEditContent: () => {},
      onRendered: () => {},
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.gesturesEl.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    if (this.longTimer !== null) window.clearTimeout(this.longTimer);
    if (this.tapTimer !== null) window.clearTimeout(this.tapTimer);
    this.longTimer = null;
    this.tapTimer = null;
    this.renderer.unmount();
    this.el.remove();
    this.glowEl.remove();
  }

  // ------------------------------------------------------------------ geometry

  /** The abspos pane sits at the content origin of the scroll container —
   *  mirror the scroll so it keeps covering the visible area. */

  /** Body-attached + fixed, geometry driven from the transcript's viewport rect
   *  — the composer's proven pattern (ChatView's geometry timer calls this).
   *  beta6: abspos inside the scroll container kept inheriting ancestor
   *  scroll/offset weirdness (pane@-133 on iOS, twice) — this sidesteps the
   *  entire class of problem. */
  syncPosition(): void {
    const r = this.opts.container.getBoundingClientRect();
    this.el.style.left = `${Math.round(r.left)}px`;
    this.el.style.top = `${Math.round(r.top)}px`;
    this.el.style.width = `${Math.round(r.width)}px`;
    this.el.style.height = `${Math.round(
      this.opts.extendBottom ? Math.max(r.height, window.innerHeight - r.top) : r.height,
    )}px`;
    // Keep the gesture surface clear of the title bar (back button, rename).
    const avoid = this.opts.avoidEl;
    if (avoid) {
      const clearance = Math.max(0, Math.round(avoid.getBoundingClientRect().bottom - r.top));
      this.gesturesEl.style.top = `${clearance}px`;
    }
  }

  // ------------------------------------------------------------------ gestures

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.destroyed) return;
    if (e.button !== 0) return;
    if (this.pointerId !== null) return;
    // Autoplay unlock hook: exactly once, on the first pointer interaction.
    if (!this.firstGestureFired) {
      this.firstGestureFired = true;
      try {
        this.opts.onFirstGesture?.();
      } catch {
        // autoplay unlock must never take the gesture path down
      }
    }
    // Interactive message content (links, buttons, fields) keeps its own clicks —
    // a tap there must not also be a voice gesture (chat's [data-ui] exclusion).
    const target = e.target;
    if (target instanceof Element && target.closest("a, button, input, textarea, select")) return;
    this.pointerId = e.pointerId;
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.swiped = false;
    this.longFired = false;
    if (this.longTimer !== null) window.clearTimeout(this.longTimer);
    this.longTimer = window.setTimeout(() => {
      this.longTimer = null;
      if (this.pointerId === null || this.swiped) return;
      this.longFired = true;
      this.handlers.onLongPress();
    }, LONG_PRESS_MS);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId || this.longFired) return;
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > DRIFT_PX) {
      this.swiped = true;
      if (this.longTimer !== null) {
        window.clearTimeout(this.longTimer);
        this.longTimer = null;
      }
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.longTimer !== null) {
      window.clearTimeout(this.longTimer);
      this.longTimer = null;
    }
    if (this.longFired) {
      // Held past the threshold: the destructive action already fired there —
      // the release is pure bookkeeping (no tap logic runs).
      this.longFired = false;
      this.handlers.onLongRelease(this.swiped);
      return;
    }
    if (this.swiped) return; // scroll / panel gesture, never a tap
    if (this.tapTimer !== null) {
      // Second pointerup inside the 320 ms window: cancel the pending single
      // tap and fire the double tap.
      window.clearTimeout(this.tapTimer);
      this.tapTimer = null;
      this.handlers.onDoubleTap();
      return;
    }
    // First clean tap: the SINGLE tap is scheduled at the window's end — a
    // second pointerup before then turns it into a double tap instead.
    this.tapTimer = window.setTimeout(() => {
      this.tapTimer = null;
      this.handlers.onTap();
    }, DOUBLE_TAP_MS);
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.longTimer !== null) {
      window.clearTimeout(this.longTimer);
      this.longTimer = null;
    }
    // A cancelled gesture reports nothing; a tap already scheduled by an
    // earlier completed pointerup keeps its own window.
  };

}
