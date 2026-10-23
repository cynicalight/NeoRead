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
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasPendingPaperNotes()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  // Electron already offers Return / Exit when its awaited flush fails.
  const browser = !window.neoreadDesktop;
  if (browser) window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("pagehide", flush);
  const removeClose = window.neoreadDesktop?.onBeforeClose(async () => {
    await Promise.all([flushProgress(), flushPaperNotes()]);
    await saveReaderSettings(useReaderStore.getState().theme);
    // Editing can continue while progress/settings requests are in flight.
    await flushPaperNotes();
  });
  return () => {
    window.removeEventListener("pagehide", flush);
    if (browser) window.removeEventListener("beforeunload", beforeUnload);
    removeClose?.();
  };
}
