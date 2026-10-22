// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import { GuideDialog } from "../guide/GuideDialog";
import { ShortcutPanel } from "./ShortcutPanel";
import {
  bindingError,
  loadBindings,
  normalizeBindings,
  defaults,
  forwardReaderShortcut,
  label,
  matches,
  readBindings,
  saveBindings,
  useShortcut,
} from "./shortcuts";

vi.mock("@reader/api", () => ({
  api: {
    shortcutPreferences: vi.fn(async () => ({})),
    saveShortcutPreferences: vi.fn(async (value) => value),
  },
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api.shortcutPreferences).mockResolvedValue({});
  vi.mocked(api.saveShortcutPreferences).mockImplementation(
    async (value) => value,
  );
  await loadBindings();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("maps Cmd on Mac to Ctrl on Windows, with exact modifiers", () => {
  const bindings = defaults();
  expect(
    matches(
      new KeyboardEvent("keydown", { key: "L", metaKey: true }),
      "readerLeft",
      bindings,
      true,
    ),
  ).toBe(true);
  expect(
    matches(
      new KeyboardEvent("keydown", { key: "l", ctrlKey: true }),
      "readerLeft",
      bindings,
      false,
    ),
  ).toBe(true);
  expect(
    matches(
      new KeyboardEvent("keydown", { key: "l", metaKey: true }),
      "readerLeft",
      bindings,
      false,
    ),
  ).toBe(false);
  expect(
    matches(
      new KeyboardEvent("keydown", { key: "l", ctrlKey: true, shiftKey: true }),
      "readerLeft",
      bindings,
      false,
    ),
  ).toBe(false);
  expect(label(bindings.readerLeft, false)).toBe("Ctrl + L");
  expect(label(bindings.readerLeft, true)).toBe("Cmd + L");
});
it("allows distinct scopes and rejects overlapping and reserved shortcuts", () => {
  expect(
    bindingError("readerLeft", defaults().libraryLeft, defaults()),
  ).toBeNull();
  expect(
    bindingError("readerRight", defaults().readerLeft, defaults()),
  ).toContain("冲突");
  expect(bindingError("search", defaults().libraryLeft, defaults())).toContain(
    "冲突",
  );
  expect(
    bindingError("search", { key: "k", shift: false }, defaults()),
  ).toContain("系统操作");
});
it("recovers from malformed preferences", () => {
  expect(normalizeBindings(null)).toEqual(defaults());
  expect(
    normalizeBindings({ search: { key: "Escape", shift: false } }),
  ).toEqual(defaults());
});
it("reloads saved preferences and retains bindings when a save fails", async () => {
  vi.mocked(api.shortcutPreferences).mockResolvedValue({
    search: { key: "g", shift: true },
  });
  await loadBindings();
  expect(readBindings().search).toEqual({ key: "g", shift: true });
  vi.mocked(api.saveShortcutPreferences).mockRejectedValueOnce(
    new Error("offline"),
  );
  await expect(saveBindings(defaults())).rejects.toThrow("offline");
  expect(readBindings().search.key).toBe("g");
});
it("applies saved changes immediately, ignores dialogs and repeat, forwards frame events, and cleans up", async () => {
  const run = vi.fn();
  function Harness() {
    useShortcut("readerLeft", run);
    return null;
  }
  await act(async () => root.render(<Harness />));
  const fire = (key: string, repeat = false) => {
    const event = new KeyboardEvent("keydown", {
      key,
      ctrlKey: true,
      cancelable: true,
      repeat,
    });
    window.dispatchEvent(event);
    return event;
  };
  expect(fire("l").defaultPrevented).toBe(true);
  await saveBindings({ ...defaults(), readerLeft: { key: "b", shift: false } });
  expect(fire("l").defaultPrevented).toBe(false);
  fire("b");
  fire("b", true);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  fire("b");
  dialog.remove();
  const frameKey = new KeyboardEvent("keydown", {
    key: "b",
    ctrlKey: true,
    cancelable: true,
  });
  forwardReaderShortcut(frameKey);
  expect(frameKey.defaultPrevented).toBe(true);
  expect(run).toHaveBeenCalledTimes(3);
  await act(async () => root.render(null));
  fire("b");
  expect(run).toHaveBeenCalledTimes(3);
});
it("records, persists, cancels and restores shortcuts in the panel", async () => {
  await act(async () => root.render(<ShortcutPanel />));
  const button = () =>
    host.querySelector<HTMLButtonElement>(
      '[aria-label="修改阅读模式－左侧栏快捷键"]',
    )!;
  await act(async () => button().click());
  await act(async () =>
    button().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "b",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(readBindings().readerLeft.key).toBe("b");
  expect(button().textContent).toBe("Ctrl + B");
  await act(async () => button().click());
  await act(async () =>
    button().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(button().getAttribute("aria-pressed")).toBe("false");
  await act(async () =>
    Array.from(host.querySelectorAll("button"))
      .find((el) => el.textContent === "恢复默认")!
      .click(),
  );
  expect(readBindings()).toEqual(defaults());
});
it("searches actions by name", async () => {
  await act(async () => root.render(<ShortcutPanel />));
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "右侧栏");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("阅读模式－右侧栏");
  expect(host.textContent).not.toContain("主界面－左侧栏");
});

it("pins the shortcuts tab and cancels recording without closing the guide", async () => {
  const close = vi.fn();
  await act(async () =>
    root.render(
      <GuideDialog
        open
        topic="shortcuts"
        onTopicChange={() => {}}
        onOpenChange={close}
        onAction={() => {}}
      />,
    ),
  );
  expect(document.querySelector('[role="tab"]')?.textContent).toContain(
    "快捷键",
  );
  const edit = document.querySelector<HTMLButtonElement>(
    '[aria-label="修改阅读模式－左侧栏快捷键"]',
  )!;
  await act(async () => edit.click());
  await act(async () =>
    edit.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(close).not.toHaveBeenCalled();
  expect(edit.getAttribute("aria-pressed")).toBe("false");
});

it("allows reading shortcuts beside a pinned preview but not from its controls", async () => {
  const run = vi.fn();
  function Harness() {
    useShortcut("readerLeft", run);
    return (
      <div role="dialog" data-reader-floating-preview="">
        <button>Preview</button>
      </div>
    );
  }
  await act(async () => root.render(<Harness />));
  const fire = (target: EventTarget) =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "l",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  fire(window);
  expect(run).toHaveBeenCalledOnce();
  fire(host.querySelector("button")!);
  expect(run).toHaveBeenCalledOnce();
  const modal = document.createElement("div");
  modal.setAttribute("role", "dialog");
  document.body.append(modal);
  fire(window);
  expect(run).toHaveBeenCalledOnce();
  modal.remove();
});

it("supports bare function keys, exact modifiers, persistence and conflicts", () => {
  for (const mac of [true, false]) {
    expect(
      matches(
        new KeyboardEvent("keydown", { key: "F1" }),
        "primaryLibrary",
        defaults(),
        mac,
      ),
    ).toBe(true);
    expect(
      matches(
        new KeyboardEvent("keydown", { key: "F2" }),
        "secondaryLibrary",
        defaults(),
        mac,
      ),
    ).toBe(true);
    for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) {
      expect(
        matches(
          new KeyboardEvent("keydown", { key: "F1", [modifier]: true }),
          "primaryLibrary",
          defaults(),
          mac,
        ),
      ).toBe(false);
    }
  }
  expect(label(defaults().primaryLibrary)).toBe("F1");
  const saved = { ...defaults(), primaryLibrary: { key: "f2", shift: true } };
  expect(normalizeBindings(saved)).toEqual(saved);
  expect(
    bindingError("secondaryLibrary", defaults().primaryLibrary, defaults()),
  ).toContain("冲突");
});

it("forwards library function keys from EPUB frames and blocks them in dialogs", async () => {
  const run = vi.fn();
  function Harness() {
    useShortcut("primaryLibrary", run);
    return null;
  }
  await act(async () => root.render(<Harness />));
  const fire = () => {
    const event = new KeyboardEvent("keydown", { key: "F1", cancelable: true });
    forwardReaderShortcut(event);
    return event;
  };
  expect(fire().defaultPrevented).toBe(true);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  expect(fire().defaultPrevented).toBe(false);
  dialog.remove();
  expect(run).toHaveBeenCalledTimes(1);
});
