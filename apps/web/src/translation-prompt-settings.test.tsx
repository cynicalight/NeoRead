// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TranslationPromptSettings } from "./TranslationPromptSettings";

it("keeps a failed reset editable and applies successful saved preferences", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const save = vi.fn(async () => false);
  try {
    await act(async () =>
      root.render(
        <TranslationPromptSettings
          value="保留术语"
          disabled={false}
          onSave={save}
        />,
      ),
    );
    const reset = () =>
      [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "恢复默认",
      )!;
    await act(async () => reset().click());
    expect(save).toHaveBeenLastCalledWith("");
    expect(host.querySelector("textarea")?.value).toBe("保留术语");
    save.mockResolvedValueOnce(true);
    await act(async () => reset().click());
    expect(host.querySelector("textarea")?.value).toBe("");
    await act(async () =>
      root.render(
        <TranslationPromptSettings
          value="自然中文"
          disabled={true}
          onSave={save}
        />,
      ),
    );
    expect(host.querySelector("textarea")?.value).toBe("自然中文");
    expect([...host.querySelectorAll("button")].every((b) => b.disabled)).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
