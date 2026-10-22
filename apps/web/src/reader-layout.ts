import type { ReaderLayout, ReaderTheme } from "@reader/core";
import { useReaderStore } from "./store";

const defaults: ReaderLayout = {
  navigationWidth: 15,
  assistantWidth: 25,
  navigationOpen: true,
  assistantOpen: true,
  sourceWidth: 50,
  swapped: false,
};

/** Old libraries and invalid saved values keep the existing reader defaults. */
export function readerLayout(value: ReaderTheme["readerLayout"]): ReaderLayout {
  const width = (
    key: "navigationWidth" | "assistantWidth" | "sourceWidth",
    max: number,
    min = 1,
  ) => {
    const n = value?.[key];
    return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max
      ? n
      : defaults[key];
  };
  const flag = (key: "navigationOpen" | "assistantOpen" | "swapped") =>
    typeof value?.[key] === "boolean" ? value[key] : defaults[key];
  return {
    navigationWidth: width("navigationWidth", 30),
    assistantWidth: width("assistantWidth", 45),
    navigationOpen: flag("navigationOpen"),
    assistantOpen: flag("assistantOpen"),
    sourceWidth: width("sourceWidth", 80, 20),
    swapped: flag("swapped"),
  };
}

/** Read the latest store snapshot so adjacent controls cannot overwrite each other. */
export function updateReaderLayout(patch: Partial<ReaderLayout>) {
  const { theme, setTheme } = useReaderStore.getState();
  setTheme({ readerLayout: { ...readerLayout(theme.readerLayout), ...patch } });
}

export function sidebarLayout(layout: ReaderLayout) {
  const navigation = layout.navigationOpen ? layout.navigationWidth : 0;
  const assistant = layout.assistantOpen ? layout.assistantWidth : 0;
  return { navigation, reading: 100 - navigation - assistant, assistant };
}
