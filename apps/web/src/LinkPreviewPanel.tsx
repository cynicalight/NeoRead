import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ArrowUpRight, Grip, Minus, Pin, Plus, X } from "lucide-react";
import type { DocumentLocation, LinkPreview } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Popover, PopoverContent } from "@neoread/ui/components/popover";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@neoread/ui/components/dialog";

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}
const margin = 12;
export function constrainPreviewFrame(
  frame: Frame,
  width: number,
  height: number,
): Frame {
  const w = Math.max(1, Math.min(frame.width, width - margin * 2));
  const h = Math.max(1, Math.min(frame.height, height - margin * 2));
  return {
    width: w,
    height: h,
    x: Math.max(margin, Math.min(frame.x, width - w - margin)),
    y: Math.max(margin, Math.min(frame.y, height - h - margin)),
  };
}
const constrain = (frame: Frame) =>
  constrainPreviewFrame(frame, window.innerWidth, window.innerHeight);

/** Retains the target while the pointer crosses from the citation to its controls. */
export function LinkPreviewPanel({
  preview,
  onDismiss,
  onNavigate,
  renderKey = "",
}: {
  preview: LinkPreview | null;
  onDismiss: () => void;
  onNavigate: (location: DocumentLocation) => void;
  renderKey?: string;
}) {
  const [current, setCurrent] = useState(preview);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const engaged = hovered || focused;
  const [frame, setFrame] = useState<Frame>({
    x: 24,
    y: 80,
    width: 600,
    height: 480,
  });
  const popup = useRef<HTMLDivElement>(null);
  const motion = useRef<{
    pointer: number;
    x: number;
    y: number;
    frame: Frame;
    resize: boolean;
  } | null>(null);
  useEffect(() => {
    if (pinned) return;
    if (preview) {
      setCurrent(preview);
      return;
    }
    if (engaged) return;
    const timer = setTimeout(() => setCurrent(null), 350);
    return () => clearTimeout(timer);
  }, [preview, pinned, engaged]);
  useEffect(() => {
    if (!pinned) return;
    const resize = () => setFrame((old) => constrain(old));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [pinned]);
  const close = () => {
    setPinned(false);
    setHovered(false);
    setFocused(false);
    setCurrent(null);
    onDismiss();
  };
  const pin = () => {
    const rect = popup.current?.getBoundingClientRect();
    setFrame(
      constrain({
        x: rect?.left ?? 24,
        y: rect?.top ?? 80,
        width: rect?.width || 600,
        height: Math.max(280, Math.min(640, (rect?.height || 400) + 50)),
      }),
    );
    setPinned(true);
  };
  const start = (event: ReactPointerEvent<HTMLElement>, resize = false) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    motion.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      frame,
      resize,
    };
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = motion.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    setFrame(
      constrain(
        drag.resize
          ? {
              ...drag.frame,
              width: Math.min(
                window.innerWidth - drag.frame.x - margin,
                Math.max(300, drag.frame.width + dx),
              ),
              height: Math.min(
                window.innerHeight - drag.frame.y - margin,
                Math.max(240, drag.frame.height + dy),
              ),
            }
          : { ...drag.frame, x: drag.frame.x + dx, y: drag.frame.y + dy },
      ),
    );
  };
  const stop = () => {
    motion.current = null;
  };
  const keyboardFrame = (event: React.KeyboardEvent, resize: boolean) => {
    const direction = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 40 : 10;
    setFrame((old) =>
      constrain(
        resize
          ? {
              ...old,
              width: Math.max(300, old.width + direction[0] * step),
              height: Math.max(240, old.height + direction[1] * step),
            }
          : {
              ...old,
              x: old.x + direction[0] * step,
              y: old.y + direction[1] * step,
            },
      ),
    );
  };
  if (!current) return null;
  const navigate = () => {
    onNavigate(current.location ?? { type: "pdf", page: current.page });
    if (!pinned) close();
  };
  const actions = (
    <>
      {!pinned && (
        <Button
          variant="ghost"
          size="icon-sm"
          title="固定预览"
          aria-label="固定预览"
          onClick={pin}
        >
          <Pin />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        title="跳转原文"
        aria-label="跳转原文"
        onClick={navigate}
      >
        <ArrowUpRight />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="关闭预览"
        aria-label="关闭预览"
        onClick={close}
      >
        <X />
      </Button>
    </>
  );
  if (pinned)
    return (
      <Dialog
        open
        modal={false}
        disablePointerDismissal
        onOpenChange={(open, details) => {
          if (!open && details.reason === "escape-key") close();
        }}
      >
        <DialogContent
          data-neoread-floating-preview=""
          showOverlay={false}
          showCloseButton={false}
          initialFocus={true}
          finalFocus={false}
          className="link-preview-window"
          style={{
            left: frame.x,
            top: frame.y,
            width: frame.width,
            height: frame.height,
          }}
        >
          <DialogTitle className="sr-only">
            第 {current.page} 页固定预览
          </DialogTitle>
          <PreviewImage
            preview={current}
            renderKey={renderKey}
            actions={actions}
          >
            <Button
              variant="ghost"
              size="sm"
              className="link-preview-drag"
              aria-label="移动预览窗口"
              title="拖动移动，方向键微调"
              onPointerDown={(e) => start(e)}
              onPointerMove={move}
              onPointerUp={stop}
              onPointerCancel={stop}
              onLostPointerCapture={stop}
              onKeyDown={(e) => keyboardFrame(e, false)}
            >
              <Pin className="size-3.5" />
              <span>第 {current.page} 页</span>
            </Button>
          </PreviewImage>
          <Button
            variant="ghost"
            size="icon-sm"
            className="link-preview-resize"
            aria-label="调整预览窗口大小"
            title="拖动调整大小，方向键微调"
            onPointerDown={(e) => start(e, true)}
            onPointerMove={move}
            onPointerUp={stop}
            onPointerCancel={stop}
            onLostPointerCapture={stop}
            onKeyDown={(e) => keyboardFrame(e, true)}
          >
            <Grip className="size-3" />
          </Button>
        </DialogContent>
      </Dialog>
    );
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <PopoverContent
        ref={popup}
        anchor={{
          getBoundingClientRect: () =>
            DOMRect.fromRect({
              x: current.anchor.left,
              y: current.anchor.top,
              width: current.anchor.width,
              height: current.anchor.height,
            }),
        }}
        side="bottom"
        initialFocus={false}
        finalFocus={false}
        className="link-preview"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
        }}
      >
        <div className="link-preview-header">
          <span className="link-preview-label">第 {current.page} 页</span>
          {actions}
        </div>
        <img
          src={current.image}
          alt={`第 ${current.page} 页链接目标`}
          style={{ aspectRatio: current.ratio }}
        />
      </PopoverContent>
    </Popover>
  );
}

function PreviewImage({
  preview,
  renderKey,
  children,
  actions,
}: {
  preview: LinkPreview;
  renderKey: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 560, height: 340 });
  const [zoom, setZoom] = useState(1);
  const [image, setImage] = useState(preview.image);
  const [status, setStatus] = useState("");
  const [density, setDensity] = useState(window.devicePixelRatio || 1);
  const pan = useRef<{
    pointer: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const fit = Math.min(size.width, size.height * preview.ratio);
  const width = Math.max(1, fit * zoom),
    height = width / preview.ratio;
  const stageWidth = Math.max(size.width, width),
    stageHeight = Math.max(size.height, height);
  const previousSize = useRef({ width: stageWidth, height: stageHeight });
  useLayoutEffect(() => {
    const node = viewport.current!;
    const measure = () => {
      if (node.clientWidth && node.clientHeight)
        setSize({ width: node.clientWidth, height: node.clientHeight });
      setDensity(window.devicePixelRatio || 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  useLayoutEffect(() => {
    const node = viewport.current!;
    const old = previousSize.current;
    node.scrollLeft = Math.max(
      0,
      ((node.scrollLeft + size.width / 2) * stageWidth) / old.width -
        size.width / 2,
    );
    node.scrollTop = Math.max(
      0,
      ((node.scrollTop + size.height / 2) * stageHeight) / old.height -
        size.height / 2,
    );
    previousSize.current = { width: stageWidth, height: stageHeight };
  }, [stageWidth, stageHeight, size]);
  useEffect(() => {
    if (!preview.renderImage) return;
    const controller = new AbortController();
    setStatus("正在加载高清预览…");
    const timer = setTimeout(() => {
      void preview.renderImage!(Math.ceil(width * density), controller.signal)
        .then((source) => {
          if (controller.signal.aborted) return;
          setImage(source);
          setStatus("");
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setStatus("高清预览暂时不可用，保留当前图片");
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [preview, width, density, renderKey]);
  const changeZoom = (next: number) =>
    setZoom(Math.min(4, Math.max(0.5, next)));
  useEffect(() => {
    const node = viewport.current!;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      setZoom((old) =>
        Math.min(4, Math.max(0.5, old * Math.exp(-event.deltaY * 0.01))),
      );
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);
  return (
    <>
      <div className="link-preview-header flex-wrap">
        {children}
        <div className="link-preview-zoom">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="缩小预览内容"
            disabled={zoom <= 0.5}
            onClick={() => changeZoom(zoom - 0.25)}
          >
            <Minus />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => changeZoom(1)}
            title="适应窗口"
          >
            适应窗口
          </Button>
          <span className="link-preview-scale">{Math.round(zoom * 100)}%</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="放大预览内容"
            disabled={zoom >= 4}
            onClick={() => changeZoom(zoom + 0.25)}
          >
            <Plus />
          </Button>
        </div>
        {actions}
      </div>
      <div
        ref={viewport}
        className="link-preview-viewport"
        tabIndex={0}
        aria-label="预览内容，可拖拽平移，按加减号缩放"
        onKeyDown={(e) => {
          if (e.key === "+" || e.key === "=") {
            e.preventDefault();
            e.stopPropagation();
            changeZoom(zoom + 0.25);
          }
          if (e.key === "-") {
            e.preventDefault();
            e.stopPropagation();
            changeZoom(zoom - 0.25);
          }
          if (e.key === "0") {
            e.preventDefault();
            e.stopPropagation();
            changeZoom(1);
          }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          pan.current = {
            pointer: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            left: e.currentTarget.scrollLeft,
            top: e.currentTarget.scrollTop,
          };
        }}
        onPointerMove={(e) => {
          const drag = pan.current;
          if (!drag || drag.pointer !== e.pointerId) return;
          e.currentTarget.scrollLeft = drag.left - (e.clientX - drag.x);
          e.currentTarget.scrollTop = drag.top - (e.clientY - drag.y);
        }}
        onPointerUp={() => {
          pan.current = null;
        }}
        onPointerCancel={() => {
          pan.current = null;
        }}
        onLostPointerCapture={() => {
          pan.current = null;
        }}
      >
        <div
          className="link-preview-stage"
          style={{ width: stageWidth, height: stageHeight }}
        >
          <img
            src={image}
            alt={`第 ${preview.page} 页链接目标`}
            draggable={false}
            style={{ width, height }}
          />
        </div>
      </div>
      {status && (
        <span className="link-preview-status" role="status">
          {status}
        </span>
      )}
    </>
  );
}
