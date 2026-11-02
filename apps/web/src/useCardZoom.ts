import { useEffect, useRef } from "react";
import { zoomCommand } from "@neoread/core";

/** Card sizes a library grid steps through, relative to its default. */
export const cardScales = [0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

/** Wheel distance that counts as one zoom step, so trackpads are not jumpy. */
const wheelStep = 40;

export function nextCardScale(scale: number, direction: 1 | -1) {
  const index = cardScales.findIndex((s) => s >= scale - 0.001);
  const at = index < 0 ? cardScales.length - 1 : index;
  // A saved value between steps moves to the nearest step in that direction.
  const exact = Math.abs(cardScales[at] - scale) < 0.001;
  const next = direction > 0 ? (exact ? at + 1 : at) : at - 1;
  return cardScales[Math.max(0, Math.min(cardScales.length - 1, next))];
}

/**
 * Resizes library cards with Cmd/Ctrl + wheel over `target` and Cmd/Ctrl +/-/0
 * anywhere outside dialogs and text fields.
 */
export function useCardZoom(
  target: HTMLElement | null,
  enabled: boolean,
  scale: number,
  onChange: (scale: number) => void,
) {
  const latest = useRef({ scale, onChange });
  latest.current = { scale, onChange };
  useEffect(() => {
    if (!enabled) return;
    const set = (next: number) => {
      if (next === latest.current.scale) return;
      latest.current.scale = next;
      latest.current.onChange(next);
    };
    const key = (e: KeyboardEvent) => {
      const command = zoomCommand(e);
      if (!command || e.defaultPrevented) return;
      if (
        (e.target as Element | null)?.closest?.(
          'input, textarea, [contenteditable="true"], [role="dialog"], [role="alertdialog"]',
        )
      )
        return;
      e.preventDefault();
      set(
        command === "width"
          ? 1
          : nextCardScale(latest.current.scale, command === "in" ? 1 : -1),
      );
    };
    let distance = 0;
    const wheel = (e: WheelEvent) => {
      // Ctrl also arrives with trackpad pinches.
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      distance += e.deltaY;
      if (Math.abs(distance) < wheelStep) return;
      set(nextCardScale(latest.current.scale, distance < 0 ? 1 : -1));
      distance = 0;
    };
    window.addEventListener("keydown", key);
    target?.addEventListener("wheel", wheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", key);
      target?.removeEventListener("wheel", wheel);
    };
  }, [enabled, target]);
}
