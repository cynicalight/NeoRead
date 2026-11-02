import { reducedMotion, subscribeMotion } from "../motion";
import { useEffect, useRef } from "react";
import { Painter, paint, readPalette, stillTime, type Scene } from "./canvas";

/** Plays a guide scene in a loop, or shows one still frame when motion is reduced. */
export function SceneCanvas({ scene, label }: { scene: Scene; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let palette = readPalette();
    let frame = 0;
    let start = performance.now();
    const family =
      getComputedStyle(canvas).fontFamily || "system-ui, sans-serif";
    const draw = (now: number) => {
      frame = 0;
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || scene.width;
      const pixels = Math.round(width * ratio);
      if (canvas.width !== pixels) {
        canvas.width = pixels;
        canvas.height = Math.round((pixels * scene.height) / scene.width);
      }
      const scale = canvas.width / scene.width;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      const motion = !reducedMotion();
      const t = motion
        ? (now - start) % scene.script.duration
        : stillTime(scene);
      paint(scene, new Painter(ctx, palette, family), t, motion);
      if (motion) frame = requestAnimationFrame(draw);
    };
    const redraw = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const themes = new MutationObserver(() => {
      palette = readPalette();
      redraw();
    });
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });
    const size = new ResizeObserver(redraw);
    size.observe(canvas);
    const motionChange = () => {
      start = performance.now();
      redraw();
    };
    const unsubscribe = subscribeMotion(motionChange);
    redraw();
    return () => {
      cancelAnimationFrame(frame);
      themes.disconnect();
      size.disconnect();
      unsubscribe();
    };
  }, [scene]);
  return (
    <canvas
      ref={ref}
      className="guide-canvas"
      role="img"
      aria-label={label}
      style={{ aspectRatio: `${scene.width} / ${scene.height}` }}
    />
  );
}
