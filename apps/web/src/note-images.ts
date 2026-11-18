import { api, isNoteImagePath } from "@neoread/api";

/** A place in a note that still accepts content after an async upload. */
export interface NoteInsertionPoint {
  /** Returns false once the editor that owns the point is gone. */
  insert(markdown: string): boolean;
  release(): void;
}

export interface NoteImageRequest {
  path: string;
  alt: string;
}

export const appendNoteMarkdown = (body: string, markdown: string) =>
  body.trim() ? `${body.trimEnd()}\n\n${markdown}` : markdown;

const pad = (value: number) => String(value).padStart(2, "0");
/** Local time, `YYYY-MM-DD_HH-mm-ss`. */
export function noteImageTimestamp(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

const uploadable = /^image\/(png|jpeg|webp|gif)$/;
/**
 * Image files to upload for a paste, or none when the clipboard carries text.
 * Text wins so Word/web copies keep their Markdown; a file manager copy whose
 * only text is the file names still counts as an image paste.
 */
export function pastedNoteImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files).filter((file) =>
    uploadable.test(file.type),
  );
  if (!files.length) return [];
  const names = new Set(files.map((file) => file.name));
  const text = data.getData("text/plain").trim();
  if (text && !text.split(/\r\n?|\n/).every((line) => names.has(line.trim())))
    return [];
  return files;
}

/** Uploads in parallel and returns Markdown in clipboard order. */
export async function uploadNoteImages(
  documentId: string,
  files: File[],
  pastedAt: Date,
) {
  const stamp = noteImageTimestamp(pastedAt);
  const paths = await Promise.all(
    files.map(async (file) => {
      const { path } = await api.uploadNoteImage(documentId, file);
      if (!isNoteImagePath(path)) throw new Error("服务返回了无效的图片路径");
      return path;
    }),
  );
  return paths
    .map(
      (path, index) => `![${index ? `${stamp}_${index + 1}` : stamp}](${path})`,
    )
    .join("\n");
}

/** Maps an offset through a whole-text replacement, ProseMirror style. */
export function mapTextOffset(
  previous: string,
  next: string,
  offset: number,
  assoc: -1 | 1 = -1,
) {
  const limit = Math.min(previous.length, next.length);
  let start = 0;
  while (start < limit && previous[start] === next[start]) start++;
  let suffix = 0;
  while (
    suffix < limit - start &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const end = previous.length - suffix;
  if (offset < start || (offset === start && assoc < 0)) return offset;
  if (offset > end || (offset === end && assoc > 0))
    return offset + next.length - previous.length;
  return assoc < 0 ? start : next.length - suffix;
}

type CachedImage = {
  count: number;
  url: Promise<string>;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
};
const images = new Map<string, CachedImage>();
// Hovering, editing and previewing the same note remount images in quick
// succession; keep a released object URL briefly instead of refetching.
const RELEASE_DELAY = 10_000;

/** Authenticated object URL for a managed `assets/…` image, shared by refcount. */
export function acquireNoteImage(path: string) {
  if (!isNoteImagePath(path)) throw new Error("不是书库图片");
  let entry = images.get(path);
  if (!entry) {
    const controller = new AbortController();
    const created: CachedImage = {
      count: 0,
      controller,
      url: api
        .noteImage(path, controller.signal)
        .then((blob) => URL.createObjectURL(blob)),
    };
    created.url.catch(() => {
      if (images.get(path) === created) images.delete(path);
    });
    images.set(path, created);
    entry = created;
  }
  const held = entry;
  clearTimeout(held.timer);
  held.count++;
  let released = false;
  return {
    url: held.url,
    release() {
      if (released) return;
      released = true;
      if (--held.count) return;
      held.timer = setTimeout(() => {
        if (held.count) return;
        if (images.get(path) === held) images.delete(path);
        held.controller.abort();
        held.url.then(URL.revokeObjectURL, () => {});
      }, RELEASE_DELAY);
    },
  };
}
