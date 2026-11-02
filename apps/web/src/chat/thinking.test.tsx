// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Thinking } from "./Thinking";

it("opens streamed thinking, folds after completion and keeps history readable", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Thinking text="核对原文" active />));
    const button = host.querySelector("button")!;
    expect(button.textContent).toContain("正在思考");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("核对原文");
    await act(async () =>
      root.render(<Thinking text="核对原文并确认来源" active={false} />),
    );
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent).toBe("思考过程");
    await act(async () => button.click());
    expect(host.textContent).toContain("核对原文并确认来源");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("respects manual folding while reasoning streams and after completion", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Thinking text="核对原文" active />));
    const button = host.querySelector("button")!;
    await act(async () => button.click());
    await act(async () =>
      root.render(<Thinking text="核对原文并确认来源" active />),
    );
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    await act(async () =>
      root.render(
        <Thinking text="核对原文并确认来源" active={false} incomplete />,
      ),
    );
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.textContent).toContain("未完成");
    expect(
      host
        .querySelector('[data-slot="trace-line"]')
        ?.hasAttribute("data-status"),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
