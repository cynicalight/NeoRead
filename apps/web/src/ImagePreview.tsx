import { useEffect, useState } from "react";
import { Minus, Pin, Plus } from "lucide-react";
import type { ImageAttachment } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@neoread/ui/components/dialog";
import { FloatingImage } from "./FloatingImage";

export function imageLabel(image: ImageAttachment) {
  // EPUB illustrations have no page.
  if (!image.page) return "书中插图";
  const kind = /formula|equation/.test(image.label)
    ? "公式"
    : /table/.test(image.label)
      ? "表格"
      : "图表";
  return `第 ${image.page} 页 · ${kind}`;
}
export function ImagePreview({
  title,
  alt,
  src,
  render,
  onClose,
}: {
  title: string;
  alt: string;
  src: string;
  /** Replaces `src` with a sharper rendering when it resolves. */
  render?: (signal: AbortSignal) => Promise<Blob>;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pinned, setPinned] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<number>();
  const [error, setError] = useState(false);
  const [highResolution, setHighResolution] = useState<string>();
  const [rendering, setRendering] = useState(!!render);
  useEffect(() => {
    if (!render) return;
    const controller = new AbortController();
    let url: string | undefined;
    void render(controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setHighResolution(url);
        setError(false);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setRendering(false);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [render]);
  const shown = highResolution || src;
  if (pinned && aspectRatio) {
    return (
      <FloatingImage
        src={shown}
        alt={alt}
        aspectRatio={aspectRatio}
        onClose={onClose}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="image-preview-dialog">
        <DialogHeader className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center">
          <DialogTitle className="min-w-0 truncate" title={title}>
            {title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            附件原图，可放大查看细节
          </DialogDescription>
          <div className="flex items-center justify-self-center gap-1 max-[400px]:col-span-3 max-[400px]:row-start-2">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="缩小图片"
              disabled={zoom <= 0.5}
              onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
            >
              <Minus />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setZoom(1)}>
              适应窗口
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="放大图片"
              disabled={zoom >= 4}
              onClick={() => setZoom(Math.min(4, zoom + 0.25))}
            >
              <Plus />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="col-start-3 row-start-1 me-8 justify-self-end"
            aria-label="固定为浮动图片"
            title="固定为浮动图片"
            disabled={!aspectRatio || error}
            onClick={() => setPinned(true)}
          >
            <Pin />
          </Button>
        </DialogHeader>
        {rendering && (
          <span className="image-preview-loading" role="status">
            正在加载高清预览…
          </span>
        )}
        <div className="image-preview-scroll">
          {error ? (
            <p role="alert">图片暂时无法加载，请稍后重试。</p>
          ) : (
            <img
              style={{ width: `${zoom * 100}%`, maxWidth: "none" }}
              src={shown}
              alt={alt}
              onLoad={(event) => {
                const img = event.currentTarget;
                setAspectRatio(img.naturalWidth / img.naturalHeight);
              }}
              onError={() => setError(true)}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
