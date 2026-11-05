// Mobile soft-keyboard handling.
//
// Two distinct problems, both from real-world reports:
// 1. iOS scrolls the page and clipped ancestors to reveal a focused input
//    when the keyboard opens (claude-obsidian PR #319) — that scroll shows up
//    as a giant phantom gap ABOVE the keyboard and is NOT our margin. It must
//    be undone, repeatedly (the scroll lands asynchronously).
// 2. The composer needs real clearance = the keyboard overlay. Obsidian
//    publishes --keyboard-height on :root and the keyboard draws OVER the page
//    (notetweet_obsidian PR #85) — the raw variable is the right reserve.

import { Platform } from "obsidian";

const KEYBOARD_HEIGHT_VAR = "--keyboard-height";
const INSET_VAR = "--pi-keyboard-inset";
const NAVBAR_VAR = "--pi-navbar-clearance";
const SAFE_BOTTOM_VAR = "--pi-safe-bottom";
const RESERVE_VAR = "--pi-content-reserve";

/** Numeric px value of the root `--keyboard-height`; 0 when empty/unparseable. */
function readKeyboardHeightPx(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(KEYBOARD_HEIGHT_VAR)
    .trim();
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Height of Obsidian mobile's floating bottom navbar (0 on desktop). */
function navbarClearancePx(): number {
  if (!Platform.isMobile) return 0;
  const raw = getComputedStyle(document.body).getPropertyValue("--navbar-height").trim();
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Undo the scroll the keyboard reveal adds to the page and any scrolled
 *  ancestor of `root` (see header). Without this, everything shifts up by the
 *  scroll amount and reads as a phantom gap above the keyboard. */
function undoKeyboardScroll(root: HTMLElement): void {
  const se = document.scrollingElement;
  if (se && (se.scrollTop !== 0 || se.scrollLeft !== 0)) {
    se.scrollTop = 0;
    se.scrollLeft = 0;
  }
  let el: HTMLElement | null = root;
  while (el) {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
    el = el.parentElement;
  }
}

/** Tracks the mobile soft-keyboard inset and publishes it as CSS custom
 *  properties on `root`. Returns a cleanup function. */
export function attachKeyboardInset(root: HTMLElement): () => void {
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const apply = (): void => {
    // The app sizes the view to end at the keyboard AND may pad its content
    // bottom further (the residual gap). Measure that inside reserve so CSS
    // can cancel it exactly — self-correcting whatever the source.
    const reserve = parseFloat(getComputedStyle(root).paddingBottom) || 0;
    root.style.setProperty(RESERVE_VAR, `${reserve}px`);
    root.style.setProperty(INSET_VAR, `${readKeyboardHeightPx()}px`);
    root.style.setProperty(NAVBAR_VAR, `${navbarClearancePx()}px`);
    root.style.setProperty(
      SAFE_BOTTOM_VAR,
      Platform.isMobile ? "max(env(safe-area-inset-bottom), 20px)" : "0px"
    );
    if (readKeyboardHeightPx() > 0) undoKeyboardScroll(root);
  };

  // The reveal scroll can land after the keyboard signal — chase it a few times.
  const chaseScroll = (): void => {
    undoKeyboardScroll(root);
    const delays = [0, 50, 150, 300, 600];
    for (const ms of delays) {
      setTimeout(() => {
        if (readKeyboardHeightPx() > 0) undoKeyboardScroll(root);
      }, ms);
    }
  };

  // Primary signal: Obsidian setting --keyboard-height on the document root.
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
    characterData: true,
  });

  // Fallback signal: the visual viewport changes when the keyboard opens even
  // if the --keyboard-height variable is not (re)written.
  const viewport = window.visualViewport;
  const onViewportChange = (): void => {
    apply();
    chaseScroll();
  };
  viewport?.addEventListener("resize", onViewportChange);
  viewport?.addEventListener("scroll", onViewportChange);

  // Focusing anything inside the view triggers the reveal scroll — chase it.
  const onFocusIn = (): void => chaseScroll();
  root.addEventListener("focusin", onFocusIn);

  apply(); // baseline so the properties exist before the first signal

  return () => {
    observer.disconnect();
    viewport?.removeEventListener("resize", onViewportChange);
    viewport?.removeEventListener("scroll", onViewportChange);
    root.removeEventListener("focusin", onFocusIn);
    if (retryTimer) clearTimeout(retryTimer);
    root.style.removeProperty(INSET_VAR);
    root.style.removeProperty(NAVBAR_VAR);
    root.style.removeProperty(SAFE_BOTTOM_VAR);
    root.style.removeProperty(RESERVE_VAR);
  };
}
