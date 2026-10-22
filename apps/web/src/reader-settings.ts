import type { ReaderTheme } from "@reader/core";
import { api } from "@reader/api";
import { useEffect } from "react";
import { toast } from "sonner";

let pending = Promise.resolve();
/** Keep the last settings change last on disk, including the desktop close flush. */
export function saveReaderSettings(theme: ReaderTheme) {
  pending = pending
    .catch(() => {})
    .then(async () => {
      await api.saveSettings(theme);
    });
  return pending;
}

export function useSaveReaderSettings(theme: ReaderTheme, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      void saveReaderSettings(theme).catch((e) => toast.error(e.message));
    }, 350);
    return () => clearTimeout(timer);
  }, [theme, ready]);
}
