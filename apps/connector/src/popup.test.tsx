// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act } from "react";

it("offers to collect a standalone ScienceDirect viewer without putting its signed URL or page title in the request", async () => {
  const pii = "S0167572925000172";
  const url = `https://pdf.sciencedirectassets.com/123/1-s2.0-S0167572925X00010/1-s2.0-${pii}/main.pdf?signature=private`;
  const sourceUrl = `https://www.sciencedirect.com/science/article/pii/${pii}`;
  const sendMessage = vi.fn(async (message) => message.type === "save" ?
    { pending: { status: "done", title: pii } } : {});
  vi.stubGlobal("chrome", {
    storage: { local: { get: async () => ({ secret: "test" }) } },
    tabs: { query: async () => [{ id: 41, url, title: url }] },
    runtime: { sendMessage }, permissions: { request: async () => true },
  });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ folders: [], tags: [] })));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  try {
    // The popup entry mounts on import, after its browser APIs and root exist.
    await act(async () => { await import("./popup"); });
    const button = document.querySelector<HTMLButtonElement>(".footer button");
    expect(button?.textContent).toBe("收录 1 篇到 NeoRead");
    await act(async () => button!.click());
    expect(document.querySelector('[role="status"]')?.textContent).toBe("已收录到 NeoRead。");
    const save = sendMessage.mock.calls.map(([message]) => message).find(m => m.type === "save");
    expect(save).toMatchObject({ viewerTabId: 41, candidate: { sourceUrl } });
    expect(JSON.stringify(save)).not.toContain("signature=private");
  } finally {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  }
});
