import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Minus, Plus, X } from "lucide-react";
import { blockImageURL } from "@neoread/api";
import type { ImageAttachment } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@neoread/ui/components/dialog";
const controlsHeight = 48;
// Install this rule only while a preview exists. A body :has() selector makes
// unrelated PDF text-layer changes invalidate styles across the entire reader.
const nativeDragGuard = `:root body :is(.window-top-drag, .window-drag-handle, .document-tabbar, .document-tabs-scroll, .library-topbar, .neoread-toolbar) {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}`;

export function imageLabel(image: ImageAttachment) {
  if (!image.page) return "书中插图";
  const kind = /formula|equation/.test(image.label)
    ? "公式"
    : /table/.test(image.label)
      ? "表格"
      : "图表";
  return `第 ${image.page} 页 · ${kind}`;
}

export function ImagePreview({
  documentId,
  image,
  onClose,
  renderImage,
}: {
  documentId: string;
  image: ImageAttachment;
  onClose: () => void;
  renderImage?: (
    id: string,
    signal: AbortSignal,
    width?: number,
  ) => Promise<Blob>;
}) {
  const [zoom, setZoom] = useState(1);
  const [aspect, setAspect] = useState<number>();
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const [error, setError] = useState(false);
  const [highResolution, setHighResolution] = useState<string>();
  const [rendering, setRendering] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const ratio = useRef<number>(undefined);
  const scale = useRef(1);
  const renderedScale = useRef(1);
  const pointer = useRef<{ x: number; y: number }>(undefined);
  const anchor = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    ratio: number;
  }>(undefined);
  const urls = useRef(new Set<string>());
  const maxWidth = Math.max(1, Math.min(1440, viewport.width - 64)),
    maxHeight = Math.max(1, viewport.height - 96 - controlsHeight);
  const width = aspect ? Math.min(maxWidth, maxHeight * aspect) : undefined;
  const height = aspect && width ? width / aspect : undefined;
  const changeZoom = (next: number, point = pointer.current) => {
    next = Math.max(1, Math.min(8, next));
    const host = scroll.current;
    if (!host || next === scale.current) return;
    const x = Math.max(
      0,
      Math.min(host.clientWidth, point?.x ?? host.clientWidth / 2),
    );
    const y = Math.max(
      0,
      Math.min(host.clientHeight, point?.y ?? host.clientHeight / 2),
    );
    anchor.current = {
      x,
      y,
      left: host.scrollLeft,
      top: host.scrollTop,
      ratio: next / renderedScale.current,
    };
    scale.current = next;
    setZoom(next);
  };
  useLayoutEffect(() => {
    const host = scroll.current,
      point = anchor.current;
    if (host && point) {
      host.scrollLeft =
        zoom === 1 ? 0 : (point.left + point.x) * point.ratio - point.x;
      host.scrollTop =
        zoom === 1 ? 0 : (point.top + point.y) * point.ratio - point.y;
      anchor.current = undefined;
    }
    renderedScale.current = zoom;
  }, [zoom]);
  useEffect(() => {
    const resize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    const host = scroll.current;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = host!.getBoundingClientRect();
      changeZoom(scale.current * Math.exp(-event.deltaY / 300), {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    };
    host?.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("resize", resize);
      host?.removeEventListener("wheel", wheel);
    };
  }, [aspect]);
  const pixels = width
    ? Math.ceil((width * zoom * (window.devicePixelRatio || 1)) / 512) * 512
    : 0;
  useEffect(() => {
    if (!renderImage || !pixels) return;
    const controller = new AbortController();
    setRendering(true);
    void renderImage(image.id, controller.signal, pixels)
      .then(async (blob) => {
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        const bitmap = new Image();
        bitmap.src = url;
        try {
          await bitmap.decode?.();
        } catch {
          URL.revokeObjectURL(url);
          return;
        }
        if (controller.signal.aborted) {
          URL.revokeObjectURL(url);
          return;
        }
        urls.current.add(url);
        setHighResolution(url);
        setError(false);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setRendering(false);
      });
    return () => controller.abort();
  }, [image.id, renderImage, pixels]);
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="image-preview-dialog"
        showCloseButton={false}
        style={{
          width,
          height: height ? height + controlsHeight : undefined,
          gridTemplateRows: `minmax(0, 1fr) ${controlsHeight}px`,
          visibility: aspect || error ? "visible" : "hidden",
        }}
      >
        <style data-neoread-image-preview-drag>{nativeDragGuard}</style>
        <DialogTitle className="sr-only">{imageLabel(image)}</DialogTitle>
        <DialogDescription className="sr-only">
          完整显示原图，可围绕鼠标位置放大查看细节
        </DialogDescription>
        <DialogClose
          render={
            <Button
              variant="secondary"
              size="icon"
              className="image-preview-close"
            />
          }
          aria-label="关闭图片预览"
          title="关闭图片预览（Esc）"
        >
          <X aria-hidden="true" />
        </DialogClose>
        {rendering && (
          <span className="image-preview-loading" role="status">
            正在加载高清预览…
          </span>
        )}
        <div
          ref={scroll}
          className="image-preview-scroll"
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            pointer.current = {
              x: event.clientX - bounds.left,
              y: event.clientY - bounds.top,
            };
          }}
        >
          {error ? (
            <p role="alert">图片暂时无法加载，请稍后重试。</p>
          ) : (
            <img
              style={{
                width: width ? width * zoom : "100%",
                height: height ? height * zoom : undefined,
                maxWidth: "none",
              }}
              src={highResolution || blockImageURL(documentId, image.id)}
              alt={image.caption || imageLabel(image)}
              onLoad={(event) => {
                const loaded = event.currentTarget;
                if (
                  !ratio.current &&
                  loaded.naturalWidth &&
                  loaded.naturalHeight
                ) {
                  ratio.current = loaded.naturalWidth / loaded.naturalHeight;
                  setAspect(ratio.current);
                }
                for (const url of urls.current) {
                  if (url !== loaded.getAttribute("src")) {
                    URL.revokeObjectURL(url);
                    urls.current.delete(url);
                  }
                }
              }}
              onError={() => setError(true)}
            />
          )}
        </div>
        <div className="image-preview-controls">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="缩小图片"
            disabled={zoom <= 1}
            onClick={() => changeZoom(scale.current - 0.25)}
          >
            <Minus />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => changeZoom(1)}>
            完整图片
          </Button>
          <span className="text-xs tabular-nums" aria-label="图片缩放比例">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="放大图片"
            disabled={zoom >= 8}
            onClick={() => changeZoom(scale.current + 0.25)}
          >
            <Plus />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
