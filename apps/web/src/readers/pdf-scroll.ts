import { reducedMotion } from "../motion";
// Scroll the real PDF viewport so PDF.js rendering, selection and anchors stay aligned.
export function animatePDFScroll(
  host: HTMLElement,
  left: number,
  top: number,
  cancelled: () => boolean,
  moved: () => void,
): Promise<void> {
  const fromLeft = host.scrollLeft;
  let fromTop = host.scrollTop;
  left = Math.max(0, left);
  top = Math.max(0, top);
  if (host.scrollWidth)
    left = Math.min(left, Math.max(0, host.scrollWidth - host.clientWidth));
  if (host.scrollHeight)
    top = Math.min(top, Math.max(0, host.scrollHeight - host.clientHeight));
  const apply = (progress: number) => {
    host.scrollLeft = fromLeft + (left - fromLeft) * progress;
    host.scrollTop = fromTop + (top - fromTop) * progress;
    moved();
  };
  if (cancelled()) return Promise.resolve();
  if (reducedMotion() || Math.hypot(left - fromLeft, top - fromTop) < 1) {
    apply(1);
    return Promise.resolve();
  }
  // Gliding across many pages makes PDF.js render each page it passes. Jump
  // to one viewport short of the destination and animate only that stretch.
  const span = host.clientHeight;
  if (span > 0 && Math.abs(top - fromTop) > span * 2) {
    fromTop = top - Math.sign(top - fromTop) * span;
    host.scrollTop = fromTop;
    moved();
  }
  let started: number | undefined;
  return new Promise((resolve) => {
    const frame = (now: number) => {
      if (cancelled()) {
        resolve();
        return;
      }
      started ??= now;
      const progress = Math.min(1, (now - started) / 240);
      apply(1 - (1 - progress) ** 3);
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}
