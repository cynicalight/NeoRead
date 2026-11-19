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

it("shows the rich surface without a loading notice, then focuses the loaded editor", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Note() {
    const [body, setBody] = useState("original");
    return (
      <PaperNoteRichEditor
        documentId="doc"
        body={body}
        disabled={false}
        autoFocus
        onChange={setBody}
      />
    );
  }
  try {
    await act(async () => root.render(<Note />));
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector<HTMLElement>(".paper-note-rich")!.hidden).toBe(
      false,
    );
    await act(async () => {
      chunk.resolve();
      await import("./paper-note-milkdown");
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(host.querySelector(".ProseMirror")?.textContent).toContain(
          "original",
        ),
      );
    });
    expect(
      host.querySelector(".ProseMirror")!.contains(document.activeElement),
    ).toBe(true);
    expect(host.querySelector("textarea")).toBeNull();
  } finally {
    chunk.resolve();
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
