import { reducedMotion } from "../motion";
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Readium hides the old chapter frame before the new one fades in, which shows
 * as a blank flash. Page and chapter changes run while the reading surface is
 * faded out, then the new content fades in from the direction of travel.
 */
export class EPUBTransition {
  private hidden = false;
  constructor(private surface: HTMLElement) {}
  get running() {
    return this.hidden;
  }
  async run<T>(
    direction: number,
    axis: "x" | "y",
    change: () => Promise<T>,
  ): Promise<T> {
    // Nested changes (a page turn that crosses a chapter) reuse the outer fade.
    if (this.hidden || typeof this.surface.animate !== "function")
      return change();
    const reduced = reducedMotion();
    const distance = reduced ? 0 : 16 * Math.sign(direction);
    const shift = (d: number) =>
      axis === "x" ? `translate3d(${d}px, 0, 0)` : `translate3d(0, ${d}px, 0)`;
    this.hidden = true;
    const exit = this.surface.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: shift(-distance) },
      ],
      {
        duration: reduced ? 80 : 140,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        fill: "forwards",
      },
    );
    try {
      await exit.finished.catch(() => {});
      return await change();
    } finally {
      // Let the new frame paint while the surface is still transparent.
      await nextFrame();
      this.hidden = false;
      const enter = this.surface.animate(
        [
          { opacity: 0, transform: shift(distance) },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: reduced ? 120 : 220,
          easing: "cubic-bezier(0, 0, 0.2, 1)",
        },
      );
      exit.cancel();
      void enter.finished.catch(() => {});
    }
  }
}
