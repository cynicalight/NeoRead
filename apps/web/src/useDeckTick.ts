import { useEffect, useRef } from "react";

/** A quiet mechanical detent, synthesized locally with no audio asset download. */
export function useDeckTick() {
  const audio = useRef<AudioContext | null>(null);
  const last = useRef(-Infinity);
  useEffect(
    () => () => {
      const context = audio.current;
      audio.current = null;
      if (context && context.state !== "closed")
        void context.close().catch(() => {});
    },
    [],
  );

  // Call from a click/key gesture so browsers can unlock audio before scrolling.
  const unlock = () => {
    try {
      const context = audio.current ?? (audio.current = new AudioContext());
      if (context.state === "suspended") void context.resume().catch(() => {});
    } catch {
      /* Audio is optional; navigation must still work. */
    }
  };
  const tick = () => {
    const context = audio.current;
    if (!context || context.state !== "running") return;
    const now = context.currentTime;
    if (now - last.current < 0.045) return;
    last.current = now;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(1700, now);
    oscillator.frequency.exponentialRampToValueAtTime(650, now + 0.012);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.045, now + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.018);
    oscillator.connect(gain).connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(now);
    oscillator.stop(now + 0.02);
  };
  const pause = () => {
    const context = audio.current;
    if (context?.state === "running") void context.suspend().catch(() => {});
  };
  return { unlock, tick, pause };
}
