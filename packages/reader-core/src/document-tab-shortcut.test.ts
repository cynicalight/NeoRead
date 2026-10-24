import { expect, it } from "vitest";
import { documentTabCommand } from "./document-tab-shortcut";
it("supports native close, tab cycling and numbered selection without consuming ordinary editing", () => {
  expect(
    documentTabCommand({ key: "t", metaKey: true, shiftKey: true }),
  ).toEqual({ type: "reopen" });
  expect(documentTabCommand({ key: "w", metaKey: true })).toEqual({
    type: "close",
  });
  expect(documentTabCommand({ key: "w", ctrlKey: true })).toEqual({
    type: "close",
  });
  expect(documentTabCommand({ key: "Tab", ctrlKey: true })).toEqual({
    type: "next",
  });
  expect(
    documentTabCommand({ key: "Tab", ctrlKey: true, shiftKey: true }),
  ).toEqual({ type: "previous" });
  expect(documentTabCommand({ key: "3", metaKey: true })).toEqual({
    type: "select",
    index: 2,
  });
  expect(documentTabCommand({ key: "9", metaKey: true })).toEqual({
    type: "select",
    index: -1,
  });
  for (const input of [
    { key: "w" },
    { key: "Tab" },
    { key: "w", metaKey: true, shiftKey: true },
    { key: "w", metaKey: true, isComposing: true },
    { key: "1", ctrlKey: true, altKey: true },
  ])
    expect(documentTabCommand(input)).toBeNull();
});
