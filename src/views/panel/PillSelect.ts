// PillSelect — a custom selector that clones Obsidian mobile's tab-selector
// pill (visual target: NOTES/IMG_6276.jpg closed, NOTES/IMG_6277.jpg open):
// a wide rounded pill — icon + bold label left-aligned, stacked double-chevron
// on the right — that opens a fixed-position overlay panel of option rows.
// Deliberately a custom button + custom overlay rather than a native <select>:
// iOS styles native selects badly and they cannot carry icons.
//
// Pure DOM (Obsidian's createEl/createDiv/createSpan helpers + setIcon).
// All theming lives in styles.css under `.pi-pill*`, Obsidian CSS variables
// only — this file never touches colors.

import { setIcon } from "obsidian";

export interface PillOption<T> {
  value: T;
  label: string;
  /** obsidian setIcon id for the row; omit for a text-only row. */
  icon?: string;
}

export interface PillSelectOptions<T> {
  /** obsidian setIcon id shown inside the pill. */
  icon: string;
  /** initial pill label (the current option). */
  label: string;
  options: PillOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

interface PillRow<T> {
  option: PillOption<T>;
  el: HTMLElement;
}

/** px kept between the overlay and the viewport edges (horizontal clamp). */
const EDGE_MARGIN = 8;
/** px gap between the pill and the overlay. */
const PILL_GAP = 6;

// env(safe-area-inset-bottom) is not readable from JS; resolve it through a
// hidden probe element's padding-bottom instead (one probe, page lifetime).
let safeBottomProbe: HTMLElement | null = null;

function safeAreaInsetBottomPx(): number {
  if (!safeBottomProbe) {
    const probe = document.createElement("div");
    probe.style.position = "fixed";
    probe.style.left = "0";
    probe.style.bottom = "0";
    probe.style.width = "0";
    probe.style.height = "0";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    probe.style.paddingBottom = "env(safe-area-inset-bottom, 0px)";
    document.body.appendChild(probe);
    safeBottomProbe = probe;
  }
  const value = parseFloat(getComputedStyle(safeBottomProbe).paddingBottom);
  return Number.isFinite(value) ? value : 0;
}

// Height of the region covered by the Obsidian soft keyboard (0 on desktop).
// Same signal as src/views/keyboard.ts: Obsidian publishes --keyboard-height
// on :root. If the visual viewport already excludes that much (it shrinks on
// some WebViews), don't subtract it a second time.
function keyboardOcclusionPx(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--keyboard-height")
    .trim();
  const keyboard = parseFloat(raw);
  if (!Number.isFinite(keyboard) || keyboard <= 0) return 0;
  const vv = window.visualViewport;
  const visibleBottom = (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight);
  const alreadyHidden = Math.max(0, window.innerHeight - visibleBottom);
  return Math.max(0, keyboard - alreadyHidden);
}

export class PillSelect<T> {
  /** The pill itself — the caller places this in its layout. */
  readonly el: HTMLElement;

  private readonly options: PillOption<T>[];
  private readonly onChange: (value: T) => void;
  private value: T;

  private readonly labelEl: HTMLElement;
  private readonly rows: PillRow<T>[] = [];
  private overlayEl: HTMLElement | null = null;
  private open = false;

  constructor(opts: PillSelectOptions<T>) {
    this.options = opts.options;
    this.onChange = opts.onChange;
    this.value = opts.value;

    const pill = document.createElement("button");
    pill.type = "button";
    pill.addClass("pi-pill");
    pill.setAttribute("aria-haspopup", "listbox");
    pill.setAttribute("aria-expanded", "false");

    const left = pill.createSpan({ cls: "pi-pill-left" });
    setIcon(left.createSpan({ cls: "pi-pill-icon" }), opts.icon);
    this.labelEl = left.createSpan({ cls: "pi-pill-label", text: opts.label });
    setIcon(pill.createSpan({ cls: "pi-pill-chevron" }), "chevrons-up-down");

    this.el = pill;
    pill.addEventListener("click", () => this.toggle());
  }

  /** Update the pill label and the overlay highlight. With no explicit label,
   *  the matching option's label is used; unknown values keep the old label. */
  setValue(value: T, label?: string): void {
    this.value = value;
    const text =
      label ?? this.options.find((o) => Object.is(o.value, value))?.label;
    if (text !== undefined) this.labelEl.setText(text);

    for (const row of this.rows) {
      const selected = Object.is(row.option.value, value);
      row.el.classList.toggle("is-selected", selected);
      row.el.setAttribute("aria-selected", String(selected));
    }
  }

  /** Close the overlay if it is open (idempotent). */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.setAttribute("aria-expanded", "false");

    document.removeEventListener("pointerdown", this.onDocPointerDown, true);
    document.removeEventListener("keydown", this.onDocKeyDown, true);
    document.removeEventListener("scroll", this.onViewportChange, true);
    window.removeEventListener("resize", this.onViewportChange);
    window.visualViewport?.removeEventListener("resize", this.onViewportChange);
    window.visualViewport?.removeEventListener("scroll", this.onViewportChange);

    // Detach as well: the API has no destroy(), so a discarded pill must not
    // leave an orphan overlay (and its listeners) behind in the body.
    this.overlayEl?.remove();
  }

  // ---------- overlay ----------

  private toggle(): void {
    if (this.open) this.close();
    else this.openOverlay();
  }

  private openOverlay(): void {
    if (this.open) return;
    const overlay = this.overlayEl ?? this.buildOverlay();

    // Re-append every open so the overlay sits on top of the body stack.
    document.body.appendChild(overlay);
    overlay.classList.add("is-open");
    overlay.scrollTop = 0;
    overlay.style.visibility = "hidden"; // measure without a paint flash
    this.position();
    overlay.style.visibility = "";

    this.open = true;
    this.el.setAttribute("aria-expanded", "true");

    document.addEventListener("pointerdown", this.onDocPointerDown, true);
    document.addEventListener("keydown", this.onDocKeyDown, true);
    document.addEventListener("scroll", this.onViewportChange, true);
    window.addEventListener("resize", this.onViewportChange);
    window.visualViewport?.addEventListener("resize", this.onViewportChange);
    window.visualViewport?.addEventListener("scroll", this.onViewportChange);
  }

  private buildOverlay(): HTMLElement {
    const overlay = document.body.createDiv({ cls: "pi-pill-overlay" });
    overlay.setAttribute("role", "listbox");

    // Tapping the panel background (including the pill it covers) dismisses.
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) this.close();
    });

    for (const option of this.options) {
      const row = overlay.createDiv({
        cls: "pi-pill-option",
        attr: { role: "option" },
      });
      if (option.icon) {
        setIcon(row.createSpan({ cls: "pi-pill-option-icon" }), option.icon);
      }
      row.createSpan({ cls: "pi-pill-option-label", text: option.label });

      const selected = Object.is(option.value, this.value);
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-selected", String(selected));
      row.addEventListener("click", () => {
        this.setValue(option.value);
        this.close();
        this.onChange(option.value);
      });
      this.rows.push({ option, el: row });
    }

    this.overlayEl = overlay;
    return overlay;
  }

  /** Position the overlay near the pill (fixed to document.body, clamped to
   *  the viewport horizontally and above the safe-area bottom / keyboard).
   *  Preferred anchor covers the pill and grows upward — the open pill reads
   *  through the translucent panel's bottom edge, as in IMG_6277. Fallbacks:
   *  below the pill, then pinned above the safe bottom. */
  private position(): void {
    const overlay = this.overlayEl;
    if (!overlay) return;

    const rect = this.el.getBoundingClientRect();
    const vv = window.visualViewport;
    const vpLeft = vv?.offsetLeft ?? 0;
    const vpTop = vv?.offsetTop ?? 0;
    const vpWidth = vv?.width ?? window.innerWidth;
    const vpHeight = vv?.height ?? window.innerHeight;

    // Width follows the pill, capped to the visible viewport.
    const width = Math.max(0, Math.min(rect.width, vpWidth - 2 * EDGE_MARGIN));
    overlay.style.width = `${Math.round(width)}px`;

    const left = Math.min(
      Math.max(rect.left, vpLeft + EDGE_MARGIN),
      vpLeft + vpWidth - EDGE_MARGIN - width
    );

    const height = overlay.offsetHeight;
    const topLimit = vpTop + EDGE_MARGIN;
    const bottomLimit =
      vpTop + vpHeight - safeAreaInsetBottomPx() - keyboardOcclusionPx();
    const topMax = Math.max(topLimit, bottomLimit - height);

    let top: number;
    if (
      rect.bottom + PILL_GAP - height >= topLimit &&
      rect.bottom + PILL_GAP <= bottomLimit
    ) {
      top = rect.bottom + PILL_GAP - height; // preferred: cover the pill, grow up
    } else if (rect.bottom + PILL_GAP + height <= bottomLimit) {
      top = rect.bottom + PILL_GAP; // no room above: open below instead
    } else {
      top = bottomLimit - height; // neither fits: pin above the safe bottom
    }
    top = Math.min(Math.max(top, topLimit), topMax);

    overlay.style.left = `${Math.round(left)}px`;
    overlay.style.top = `${Math.round(top)}px`;
  }

  // ---------- document-level listeners (attached while open) ----------

  private readonly onDocPointerDown = (ev: PointerEvent): void => {
    const target = ev.target;
    if (!(target instanceof Node)) return;
    // The pill toggles itself; the overlay's rows/background own their clicks.
    if (this.el.contains(target)) return;
    if (this.overlayEl?.contains(target)) return;
    this.close();
  };

  private readonly onDocKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") this.close();
  };

  private readonly onViewportChange = (): void => {
    if (this.open) this.position();
  };
}
