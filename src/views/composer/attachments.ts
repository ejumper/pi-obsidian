// Attachment staging for the prompt composer (T25, ported from pi-web's flow —
// doc 1_38-pi-web-file-attachments.md).
//
// Two paths, decided per file at stage time:
//   - images      → read to base64 here and sent as inline image content blocks
//                   (AttachedImageInput) inside the prompt body;
//   - everything else → NOT uploaded on stage: the File is held in memory and
//                   uploaded by prepareSend() at send time, one `@<serverPath>`
//                   line per file prepended to the message text (pi's pipeline
//                   has no file content block — to the model an attachment is
//                   a pointer the agent reads with its own tools).
//
// iOS Files/iCloud frequently hands us files with an EMPTY `type`; those are
// sniffed by extension so images route inline with a real mime instead of
// falling through to the upload path (where the model would get a pointer
// instead of a picture).
//
// Pure DOM + browser File APIs — no Obsidian imports. All styling lives in
// styles.css under `.pi-attach-*`; this file only sets class names.

import type { AttachedImageInput } from "../../api/types";

export interface StagedAttachment {
  id: string;
  name: string;
  kind: "image" | "file";
  /** image only: data URL for the chip preview (revoked on remove). */
  previewUrl: string;
  /** image only: base64 payload (no data: prefix). */
  base64?: string;
  mimeType: string;
  /** non-image: the File, uploaded only at send time. */
  file?: File;
}

export interface AttachmentStageOptions {
  /** POST /api/attachments wrapper (multipart); resolves the server path
   *  (`/tmp/pi-clipboard-<uuid>.<ext>` — filename is server-generated). */
  upload: (file: File) => Promise<string>;
  /** Fires on every staging change (add/remove/clear/send-consumed) with a
   *  snapshot of the staged list — use it to refresh buttons, etc. The chip
   *  strip re-renders itself; renderChips() only picks the container. */
  onChange: (staged: StagedAttachment[]) => void;
}

/** Client-side cap; the server 413s anything larger anyway (doc 1_38). */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Picker filter — image-first: besides narrowing the dialog, an image-oriented
 *  accept is what makes iOS transcode HEIC→JPEG before we ever see the file.
 *  Drag-drop and paste bypass this and may carry any file. */
const PICKER_ACCEPT = "image/*,text/*,.pdf,.zip";

/** Extension → mime used ONLY for empty-`type` files (iOS Files/iCloud).
 *  Exactly the image extensions allowed to route inline — anything not in
 *  here and typed "" falls through to the upload path. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
};

/** Stage-local unique id (only needs to be unique within one stage). */
let lastAttachmentId = 0;

/** Lowercased extension without the dot; "" when there is none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** FileList has no Symbol.iterator in every lib.dom version — index-walk it;
 *  File[] just gets copied so callers can't mutate our working set. */
function toFileArray(files: FileList | File[]): File[] {
  if (Array.isArray(files)) return files.slice();
  const out: File[] = [];
  for (let i = 0; i < files.length; i++) out.push(files[i]);
  return out;
}

/** Free a preview reference when its chip leaves the stage. Previews are data
 *  URLs (inert — revokeObjectURL is a no-op on them); the call still runs so a
 *  future switch to blob: object URLs stays correct without touching callers. */
function releasePreview(item: StagedAttachment): void {
  if (item.previewUrl !== "") URL.revokeObjectURL(item.previewUrl);
  item.previewUrl = "";
  item.base64 = undefined;
}

export class AttachmentStage {
  private readonly upload: (file: File) => Promise<string>;
  private readonly onChange: (staged: StagedAttachment[]) => void;
  private readonly input: HTMLInputElement;
  private readonly items: StagedAttachment[] = [];
  /** In-flight image reads — prepareSend() awaits these so no staged image is
   *  ever sent half-read. The promises never reject (failed reads drop the
   *  chip instead), so awaiting them cannot fail a send. */
  private readonly pendingReads = new Map<string, Promise<void>>();
  private chipContainer: HTMLElement | null = null;

  constructor(opts: AttachmentStageOptions) {
    this.upload = opts.upload;
    this.onChange = opts.onChange;

    // Hidden picker — lives for the plugin's lifetime (the API has no
    // dispose; one detached input costs nothing).
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = PICKER_ACCEPT;
    input.style.display = "none";
    input.addEventListener("change", () => {
      // Copy the selection BEFORE resetting: input.files is cleared by value = "".
      const picked = toFileArray(input.files ?? []);
      input.value = ""; // let the same file be picked again next time
      if (picked.length > 0) this.addFiles(picked);
    });
    document.body.appendChild(input);
    this.input = input;
  }

  /** Open the OS file dialog. */
  pick(): void {
    this.input.click();
  }

  /** Stage files (picker, paste, or drop — same routing either way).
   *  Files over the 50MB cap are rejected early with a console warning and
   *  never reach upload; empty-`type` images are sniffed by extension. */
  addFiles(files: FileList | File[]): void {
    let added = false;
    for (const file of toFileArray(files)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        const mb = (file.size / (1024 * 1024)).toFixed(1);
        console.warn(
          `pi-obsidian: rejected "${file.name}" — ${mb}MB exceeds the 50MB attachment cap`
        );
        continue;
      }

      // Empty `type` = iOS Files/iCloud: sniff by extension so images are
      // routed inline (with the mime filled in) instead of to the upload path.
      const ext = extensionOf(file.name);
      const sniffedImageMime = file.type === "" ? IMAGE_EXTENSIONS[ext] : undefined;
      const isImage = file.type.startsWith("image/") || sniffedImageMime !== undefined;
      const mimeType = isImage
        ? file.type || sniffedImageMime || "application/octet-stream"
        : file.type || "application/octet-stream";

      const item: StagedAttachment = {
        id: `att-${++lastAttachmentId}`,
        name: file.name !== "" ? file.name : "untitled",
        kind: isImage ? "image" : "file",
        previewUrl: "",
        mimeType,
      };
      if (!isImage) item.file = file;

      this.items.push(item);
      if (isImage) {
        const read = this.readImage(item, file);
        this.pendingReads.set(item.id, read);
        void read.finally(() => this.pendingReads.delete(item.id));
      }
      added = true;
    }
    if (added) this.notify();
  }

  /** Drop one staged attachment (releases its preview). */
  remove(id: string): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = this.items.splice(index, 1);
    releasePreview(item);
    this.notify();
  }

  /** Drop everything staged (releases previews). */
  clear(): void {
    if (this.items.length === 0) return;
    for (const item of this.items) releasePreview(item);
    this.items.length = 0;
    this.notify();
  }

  get staged(): readonly StagedAttachment[] {
    return this.items.slice();
  }

  /**
   * Build the send payload. Images become inline base64 blocks; non-images
   * upload here — one request per file, sequential, in stage order — and each
   * contributes an `@<serverPath>` line for the caller to prepend to the
   * message text (joined with "\n").
   *
   * On ANY failure this throws (upload errors are rethrown with the file name
   * attached) and everything stays staged for retry — uploads are only
   * consumed after all of them succeed, at which point the stage is cleared.
   */
  async prepareSend(): Promise<{ images: AttachedImageInput[]; prefixLines: string[] }> {
    // Let in-flight image reads finish first (they never reject).
    await Promise.all([...this.pendingReads.values()]);

    // Snapshot: files staged while an upload runs are NOT part of this send.
    const processed = this.items.slice();
    const images: AttachedImageInput[] = [];
    const prefixLines: string[] = [];

    for (const item of processed) {
      if (!this.items.includes(item)) continue; // removed while an earlier upload ran
      if (item.kind === "image") {
        const data = item.base64;
        if (!data) throw new Error(`Image attachment "${item.name}" could not be read`);
        images.push({ type: "image", data, mimeType: item.mimeType });
      } else {
        const file = item.file;
        if (!file) throw new Error(`Attachment "${item.name}" has no file staged`);
        let serverPath: string;
        try {
          serverPath = await this.upload(file);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          throw new Error(`Upload failed for "${item.name}": ${reason}`, { cause: e });
        }
        prefixLines.push(`@${serverPath}`);
      }
    }

    // Consume exactly what this send used — anything staged mid-upload survives.
    const sentIds = new Set(processed.map((item) => item.id));
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (!sentIds.has(item.id)) continue;
      releasePreview(item);
      this.items.splice(i, 1);
    }
    this.notify();

    return { images, prefixLines };
  }

  /** Render the chip strip into `container`; the strip re-renders itself on
   *  every staging change afterwards (calling this again just moves it). */
  renderChips(container: HTMLElement): void {
    if (this.chipContainer && this.chipContainer !== container) {
      this.chipContainer.replaceChildren(); // don't leave a stale strip behind
    }
    this.chipContainer = container;
    container.classList.add("pi-attach-strip");
    this.paintChips();
  }

  // ---------- internals ----------

  private notify(): void {
    this.paintChips();
    this.onChange(this.items.slice());
  }

  private paintChips(): void {
    const container = this.chipContainer;
    if (!container) return;
    container.replaceChildren();
    for (const item of this.items) container.appendChild(this.buildChip(item));
  }

  /** One chip: icon (image thumbnail / placeholder box) + name + X button.
   *  Plain and unstyled — the caller's CSS owns everything under .pi-attach-*. */
  private buildChip(item: StagedAttachment): HTMLElement {
    const chip = document.createElement("div");
    chip.className = "pi-attach-chip";

    if (item.kind === "image" && item.previewUrl !== "") {
      const thumb = document.createElement("img");
      thumb.className = "pi-attach-chip-thumb";
      thumb.src = item.previewUrl;
      thumb.alt = "";
      chip.appendChild(thumb);
    } else {
      // Emoji-free placeholder — an empty box the caller styles (covers files
      // and images whose read hasn't landed yet).
      const icon = document.createElement("span");
      icon.className = "pi-attach-chip-icon";
      icon.setAttribute("aria-hidden", "true");
      chip.appendChild(icon);
    }

    const name = document.createElement("span");
    name.className = "pi-attach-chip-name";
    name.textContent = item.name;
    name.title = item.name; // full name on hover once CSS ellipsizes it
    chip.appendChild(name);

    const x = document.createElement("button");
    x.type = "button";
    x.className = "pi-attach-chip-x";
    x.textContent = "×";
    x.setAttribute("aria-label", `Remove ${item.name}`);
    x.addEventListener("click", () => this.remove(item.id));
    chip.appendChild(x);

    return chip;
  }

  /** Read an image once → base64 payload + data-URL preview. The data URL is
   *  rebuilt from the mime we expose: FileReader echoes the File's own type,
   *  which iOS leaves empty (we sniffed it from the extension). Never rejects;
   *  a failed read drops the chip with a warning. */
  private readImage(item: StagedAttachment, file: File): Promise<void> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        const comma = dataUrl.indexOf(",");
        const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
        // Skip the update if the chip was removed while reading (or nothing
        // came back) — no notify for an item nobody can see anymore.
        if (base64 !== "" && this.items.includes(item)) {
          item.base64 = base64;
          item.previewUrl = `data:${item.mimeType};base64,${base64}`;
          this.notify();
        }
        resolve();
      });
      reader.addEventListener("error", () => {
        console.warn(`pi-obsidian: could not read image "${item.name}" — dropped`);
        const index = this.items.indexOf(item);
        if (index >= 0) {
          this.items.splice(index, 1);
          this.notify();
        }
        resolve();
      });
      reader.readAsDataURL(file);
    });
  }
}
