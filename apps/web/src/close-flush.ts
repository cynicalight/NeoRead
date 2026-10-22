import { saveReaderSettings } from "./reader-settings";
import { flushProgress } from "./progress";
import { useReaderStore } from "./store";

/** Save reading state when the window closes. Installed outside React so a crashed UI still answers the desktop close request. */
export function installCloseFlush() {
  const flush = () => {
    void flushProgress().catch(() => {});
  };
  window.addEventListener("pagehide", flush);
  const removeClose = window.readerDesktop?.onBeforeClose(async () => {
    await flushProgress();
    await saveReaderSettings(useReaderStore.getState().theme);
  });
  return () => {
    window.removeEventListener("pagehide", flush);
    removeClose?.();
  };
}
