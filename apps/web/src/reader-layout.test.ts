import { afterEach, expect, it } from "vitest";
import { defaultTheme } from "@reader/core";
import {
  readerLayout,
  sidebarLayout,
  updateReaderLayout,
} from "./reader-layout";
import { useReaderStore } from "./store";

afterEach(() => useReaderStore.setState({ theme: defaultTheme }));

it("uses defaults for old libraries and invalid stored widths", () => {
  expect(sidebarLayout(readerLayout(undefined))).toEqual({
    navigation: 15,
    reading: 60,
    assistant: 25,
  });
  expect(
    readerLayout({
      navigationWidth: NaN,
      assistantWidth: 90,
      sourceWidth: 100,
    }),
  ).toMatchObject({ navigationWidth: 15, assistantWidth: 25, sourceWidth: 50 });
});

it("merges adjacent operations and keeps expanded widths through collapse, reload and reopen", () => {
  useReaderStore.setState({ theme: { ...defaultTheme, zoom: 1.4 } });
  updateReaderLayout({ navigationWidth: 22, assistantWidth: 31 });
  updateReaderLayout({ navigationOpen: false, assistantOpen: false });
  updateReaderLayout({ sourceWidth: 63, swapped: true });
  const saved = JSON.parse(JSON.stringify(useReaderStore.getState().theme));
  useReaderStore.setState({ theme: saved });
  expect(sidebarLayout(readerLayout(saved.readerLayout))).toEqual({
    navigation: 0,
    reading: 100,
    assistant: 0,
  });
  updateReaderLayout({ navigationOpen: true, assistantOpen: true });
  const theme = useReaderStore.getState().theme;
  expect(theme.zoom).toBe(1.4);
  expect(sidebarLayout(readerLayout(theme.readerLayout))).toEqual({
    navigation: 22,
    reading: 47,
    assistant: 31,
  });
  expect(theme.readerLayout).toMatchObject({ sourceWidth: 63, swapped: true });
});
