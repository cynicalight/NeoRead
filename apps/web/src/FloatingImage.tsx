import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowDownRight, X } from "lucide-react";
import { Button } from "@neoread/ui/components/button";

export function FloatingImage({
  src,
  alt,
  aspectRatio,
  onClose,
}: {
  src: string;
  alt: string;
  aspectRatio: number;
  onClose: () => void;
}) {
  const [frame, setFrame] = useState({ x: 48, y: 72, width: 560 });
  const gesture = useRef<{
    x: number;
    y: number;
    frame: typeof frame;
  } | null>(null);

  function fit(next: typeof frame) {
    const maxWidth = Math.min(
      window.innerWidth - 16,
      (window.innerHeight - 16) * aspectRatio,
    );
    const width = Math.max(
      Math.min(128, maxWidth),
      Math.min(next.width, maxWidth),
    );
    return {
      width,
      x: Math.max(8, Math.min(next.x, window.innerWidth - width - 8)),
      y: Math.max(
        8,
        Math.min(next.y, window.innerHeight - width / aspectRatio - 8),
      ),
    };
  }

  useEffect(() => {
    const resize = () => setFrame((current) => fit(current));
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [aspectRatio]);

  function start(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    gesture.current = { x: event.clientX, y: event.clientY, frame };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLButtonElement>, resizing = false) {
    if (
      !gesture.current ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    )
      return;
    const origin = gesture.current;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (resizing) {
      const delta = (dx + dy / aspectRatio) / (1 + 1 / aspectRatio ** 2);
      const width = Math.min(
        origin.frame.width + delta,
        window.innerWidth - origin.frame.x - 8,
        (window.innerHeight - origin.frame.y - 8) * aspectRatio,
      );
      setFrame(fit({ ...origin.frame, width }));
    } else {
      setFrame(
        fit({
          ...origin.frame,
          x: origin.frame.x + dx,
          y: origin.frame.y + dy,
        }),
      );
    }
  }

  return createPortal(
    <section
      className="floating-image"
      aria-label={alt}
      style={{ left: frame.x, top: frame.y, width: frame.width, aspectRatio }}
    >
      <Button
        autoFocus
        variant="ghost"
        className="floating-image-drag"
        aria-label="移动图片，可使用方向键"
        title="拖动图片移动位置，方向键微调"
        onPointerDown={start}
        onPointerMove={(event) => move(event)}
        onLostPointerCapture={() => {
          gesture.current = null;
        }}
        onKeyDown={(event) => {
          const directions: Record<string, [number, number]> = {
            ArrowLeft: [-15, 0],
            ArrowRight: [15, 0],
            ArrowUp: [0, -15],
            ArrowDown: [0, 15],
          };
          const direction = directions[event.key];
          if (!direction) return;
          event.preventDefault();
          setFrame(
            fit({
              ...frame,
              x: frame.x + direction[0],
              y: frame.y + direction[1],
            }),
          );
        }}
      >
        <img src={src} alt={alt} draggable={false} />
      </Button>
      <Button
        variant="secondary"
        size="icon-sm"
        className="floating-image-close"
        aria-label="关闭浮动图片"
        onClick={onClose}
      >
        <X />
      </Button>
      <Button
        variant="secondary"
        size="icon-sm"
        className="floating-image-resize"
        aria-label="按比例缩放图片，可使用方向键"
        title="拖动缩放，方向键调整大小"
        onPointerDown={start}
        onPointerMove={(event) => move(event, true)}
        onLostPointerCapture={() => {
          gesture.current = null;
        }}
        onKeyDown={(event) => {
          if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          )
            return;
          event.preventDefault();
          const delta =
            event.key === "ArrowRight" || event.key === "ArrowDown" ? 24 : -24;
          setFrame(fit({ ...frame, width: frame.width + delta }));
        }}
      >
        <ArrowDownRight />
      </Button>
    </section>,
    document.body,
  );
}
