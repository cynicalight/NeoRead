// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PaperNoteRichEditor } from "./PaperNoteRichEditor";

const chunk = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
});
vi.mock("./paper-note-milkdown", async (importOriginal) => {
  await chunk.promise;
  return importOriginal();
});

it("keeps the source caret when typing during chunk loading, then allows explicitly entering rich mode", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Note() {
    const [body, setBody] = useState("original");
    return (
      <PaperNoteRichEditor
        body={body}
        disabled={false}
        onChange={setBody}
        onBlur={() => {}}
      />
    );
  }
  try {
    await act(async () => root.render(<Note />));
    const source = host.querySelector("textarea")!;
    await act(async () => {
      source.focus();
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(source, "loading 时输入中文 English");
      source.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe(
      "源码",
    );
    await act(async () => {
      chunk.resolve();
      await import("./paper-note-milkdown");
    });
    expect(host.querySelector("textarea")).toBe(source);
    expect(document.activeElement).toBe(source);
    expect(source.value).toBe("loading 时输入中文 English");
    await act(async () =>
      host.querySelector<HTMLButtonElement>("button")!.click(),
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(host.querySelector(".ProseMirror")?.textContent).toContain(
          "loading 时输入中文 English",
        ),
      );
    });
    expect(host.querySelector("textarea")).toBeNull();
  } finally {
    chunk.resolve();
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
