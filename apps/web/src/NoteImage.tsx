import { useEffect, useState, useSyncExternalStore } from "react";
import { isNoteImagePath } from "@neoread/api";
import { ImagePreview } from "./ImagePreview";
import { acquireNoteImage, type NoteImageRequest } from "./note-images";

type Loaded = { path: string; url?: string; failed?: boolean };
function useNoteImageURL(path: string | undefined) {
  const managed = !!path && isNoteImagePath(path);
  const [loaded, setLoaded] = useState<Loaded>();
  useEffect(() => {
    if (!path || !managed) return;
    const image = acquireNoteImage(path);
    let active = true;
    image.url.then(
      (url) => active && setLoaded({ path, url }),
      () => active && setLoaded({ path, failed: true }),
    );
    return () => {
      active = false;
      image.release();
    };
  }, [managed, path]);
  return { managed, ...(loaded?.path === path ? loaded : undefined) };
}

// One app-level preview outlives the hover card or editor that opened it, so
// opening (or pinning) a full-size image never depends on its thumbnail.
let preview: (NoteImageRequest & { id: number }) | null = null;
let previews = 0;
const listeners = new Set<() => void>();
const setPreview = (next: typeof preview) => {
  preview = next;
  for (const listener of listeners) listener();
};
export function openNoteImagePreview(request: NoteImageRequest) {
  setPreview({ ...request, id: ++previews });
}

function NoteImagePreview({ path, alt }: NoteImageRequest) {
  const { url, failed } = useNoteImageURL(path);
  if (!url && !failed) return null;
  return (
    <ImagePreview
      title={alt || "笔记图片"}
      alt={alt}
      src={url ?? ""}
      onClose={() => setPreview(null)}
    />
  );
}

export function NoteImagePreviewHost() {
  const request = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => preview,
  );
  return request && <NoteImagePreview key={request.id} {...request} />;
}

/** Shows library-managed images only; other sources stay inert placeholders. */
export function NoteImage({
  src,
  alt = "",
  title,
}: {
  src?: string;
  alt?: string;
  title?: string;
}) {
  const { managed, url, failed } = useNoteImageURL(src);
  if (!managed || !url)
    return (
      <span className="markdown-image">
        [{failed ? "图片加载失败" : "图片"}：{alt || "未加载"}]
      </span>
    );
  return (
    <button
      type="button"
      className="note-image"
      title={title || "查看大图"}
      aria-label={alt ? `查看大图：${alt}` : "查看大图"}
      onClick={() => openNoteImagePreview({ path: src!, alt })}
    >
      <img src={url} alt={alt} draggable={false} />
    </button>
  );
}
