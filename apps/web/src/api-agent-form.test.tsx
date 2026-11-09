// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { APIAgentForm } from "./APIAgentForm";

it("persists a relay protocol override while retaining its saved key", async () => {
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
          onSave={save}
        />,
      ),
    );
    const anthropic = Array.from(
      host.querySelectorAll<HTMLElement>('[role="tab"]'),
    ).find((tab) => tab.textContent === "Anthropic");
    expect(anthropic).toBeDefined();
    await act(async () => anthropic!.click());
    expect(save).not.toHaveBeenCalled();
    const submit = host.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(save).toHaveBeenCalledExactlyOnceWith({
      url: "https://relay.example/v1",
      model: "",
      hasKey: true,
      protocol: "anthropic",
      key: undefined,
    });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("offers exactly the three wire protocols and saves Responses", async () => {
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
            url: "https://api.openai.com/v1",
            model: "",
            hasKey: true,
            protocol: "auto",
          }}
          onSave={save}
        />,
      ),
    );
    const tabs = Array.from(host.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Chat",
      "Responses",
      "Anthropic",
    ]);
    // A legacy value is shown as Chat Completions and is not a pending change.
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    const submit = host.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await act(async () => tabs[1].click());
    await act(async () => submit.click());
    expect(save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ protocol: "responses" }),
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
