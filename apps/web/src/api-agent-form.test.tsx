// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { APIAgentForm } from "./APIAgentForm";

it("drafts a relay protocol override while retaining its saved key", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const save = vi.fn(async () => {});
  try {
    await act(async () =>
      root.render(
        <APIAgentForm
          disabled={false}
          connection={{
            url: "https://relay.example/v1",
            model: "",
            hasKey: true,
          }}
          onChange={save}
        />,
      ),
    );
    await act(async () =>
      (
        host.querySelector('[aria-label="API 协议"]') as HTMLButtonElement
      ).click(),
    );
    const option = Array.from(
      document.querySelectorAll('[role="option"]'),
    ).find((e) => e.textContent === "Anthropic Messages") as HTMLElement;
    expect(option).toBeDefined();
    await act(async () => {
      option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      option.click();
    });
    expect(save).toHaveBeenCalledExactlyOnceWith({
      url: "https://relay.example/v1",
      model: "",
      hasKey: true,
      protocol: "anthropic",
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
