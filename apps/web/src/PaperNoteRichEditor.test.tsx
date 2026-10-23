// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PaperNoteRichEditor } from "./PaperNoteRichEditor";

vi.mock("./paper-note-milkdown", () => {
  throw new Error("chunk unavailable");
});

it("retains an editable source draft when the rich editor chunk fails to load", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const change = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PaperNoteRichEditor
          body="原始 draft $x_{1}$"
          disabled={false}
          onChange={change}
          onBlur={() => {}}
        />,
      ),
    );
    await act(async () => {
      await vi.waitFor(() => expect(host.textContent).toContain("加载失败"));
    });
    const source = host.querySelector("textarea")!;
    expect(source.value).toBe("原始 draft $x_{1}$");
    expect(source.disabled).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe(
      "源码",
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(source, "保留后的编辑");
      source.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(change).toHaveBeenLastCalledWith("保留后的编辑");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
