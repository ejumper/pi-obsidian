// Mobile soft-keyboard inset tracking.
//
// Obsidian mobile does not resize the webview for the keyboard (at least on
// iOS); it flips a `--keyboard-height` custom property on :root instead. This
// module watches for that signal and republishes it as plugin-scoped custom
// properties on the view root, where CSS can consume them without hardcoding.

import { Platform } from "obsidian";

const KEYBOARD_HEIGHT_VAR = "--keyboard-height";
const INSET_VAR = "--pi-keyboard-inset";
const NAVBAR_VAR = "--pi-navbar-clearance";
const SAFE_BOTTOM_VAR = "--pi-safe-bottom";

/** Numeric px value of the root `--keyboard-height`; 0 when empty/unparseable. */
function readKeyboardHeightPx(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(KEYBOARD_HEIGHT_VAR)
    .trim();
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** How much of the keyboard actually occludes the viewport. Some WebViews
 *  shrink the visual viewport when the keyboard opens — if so, the plain
 *  keyboard-height value would be applied twice (double-count gap). */
function keyboardOcclusionPx(): number {
  const keyboard = readKeyboardHeightPx();
  if (keyboard <= 0) return 0;
  const vv = window.visualViewport;
  const visibleBottom = (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight);
  const alreadyHidden = Math.max(0, window.innerHeight - visibleBottom);
  return Math.max(0, keyboard - alreadyHidden);
}

/** Height of Obsidian mobile's floating bottom navbar (0 on desktop). */
function navbarClearancePx(): number {
  if (!Platform.isMobile) return 0;
  const raw = getComputedStyle(document.body).getPropertyValue("--navbar-height").trim();
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Tracks the mobile soft-keyboard inset and publishes it as CSS custom
 *  properties on `root`. Returns a cleanup function. */
export function attachKeyboardInset(root: HTMLElement): () => void {
  const apply = (): void => {
    root.style.setProperty(INSET_VAR, `${keyboardOcclusionPx()}px`);
    root.style.setProperty(NAVBAR_VAR, `${navbarClearancePx()}px`);
    root.style.setProperty(
      SAFE_BOTTOM_VAR,
      Platform.isMobile ? "max(env(safe-area-inset-bottom), 20px)" : "0px"
    );
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
  const onViewportChange = (): void => apply();
  viewport?.addEventListener("resize", onViewportChange);
  viewport?.addEventListener("scroll", onViewportChange);

  apply(); // baseline so the properties exist before the first signal

  return () => {
    observer.disconnect();
    viewport?.removeEventListener("resize", onViewportChange);
    viewport?.removeEventListener("scroll", onViewportChange);
    root.style.removeProperty(INSET_VAR);
    root.style.removeProperty(NAVBAR_VAR);
    root.style.removeProperty(SAFE_BOTTOM_VAR);
  };
}
