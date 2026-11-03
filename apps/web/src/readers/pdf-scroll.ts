import { reducedMotion } from "../motion";
export const pdfFocusMotion = {
  duration: 480,
  easing: "cubic-bezier(0.333333, 0, 0.666667, 1)",
};
export const pdfFocusProgress = (progress: number) =>
  progress * progress * (3 - 2 * progress);
// Scroll the real PDF viewport so PDF.js rendering, selection and anchors stay aligned.
export function animatePDFScroll(
  host: HTMLElement,
  left: number,
  top: number,
  cancelled: () => boolean,
  moved: () => void,
  smooth: boolean | "focus" = true,
): Promise<void> {
  const fromLeft = host.scrollLeft,
    fromTop = host.scrollTop;
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
  if (
    !smooth ||
    reducedMotion() ||
    Math.hypot(left - fromLeft, top - fromTop) < 1
  ) {
    apply(1);
    return Promise.resolve();
  }
  let started: number | undefined;
  return new Promise((resolve) => {
    const frame = (now: number) => {
      if (cancelled()) {
        resolve();
        return;
      }
      started ??= now;
      const progress = Math.min(
        1,
        (now - started) / (smooth === "focus" ? pdfFocusMotion.duration : 240),
      );
      apply(
        smooth === "focus"
          ? pdfFocusProgress(progress)
          : 1 - (1 - progress) ** 3,
      );
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}
