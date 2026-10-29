import { saveReaderSettings } from "./neoread-settings";
import { flushProgress } from "./progress";
import { flushPaperNotes, hasPendingPaperNotes } from "./paper-note-state";
import { useReaderStore } from "./store";

/** Save reading state when the window closes. Installed outside React so a crashed UI still answers the desktop close request. */
export function installCloseFlush() {
  const flush = () => {
    void flushProgress().catch(() => {});
    void flushPaperNotes().catch(() => {});
  };
  const visibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasPendingPaperNotes()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  // Electron already offers Return / Exit when its awaited flush fails.
  const browser = !window.neoreadDesktop;
  if (browser) window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", visibility);
  const removeClose = window.neoreadDesktop?.onBeforeClose(async () => {
    const results = await Promise.allSettled([
      flushProgress(),
      flushPaperNotes(),
      saveReaderSettings(useReaderStore.getState().theme),
    ]);
    // Wait for every independent save, but never acknowledge a failed close.
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    // Editing can continue while progress/settings requests are in flight.
    await flushPaperNotes();
  });
  return () => {
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", visibility);
    if (browser) window.removeEventListener("beforeunload", beforeUnload);
    removeClose?.();
  };
}
