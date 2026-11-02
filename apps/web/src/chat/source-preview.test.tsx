// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message } from "@neoread/core";
import { SourceReferences } from "../SourceReferences";
import { MessageMarkdown } from "./MessageMarkdown";
import { ChatCitationNavigation } from "./citations";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["hover", "focus"])(
  "previews saved original text and location immediately on %s",
  async (interaction) => {
    const message: Message = {
      id: "answer",
      documentId: "doc",
      role: "assistant",
      createdAt: "now",
      content: "模型给出的总结[S84]。",
      references: [
        {
          sourceId: "S84",
          text: "This is the original passage, not the generated summary.",
          location: { type: "pdf", page: 8 },
          kind: "section",
        },
      ],
    };
    await act(async () =>
      root.render(
        <SourceReferences
          message={message}
          toc={[]}
          onNavigate={async () => {}}
        >
          <MessageMarkdown content={message.content} />
        </SourceReferences>,
      ),
    );
    const button = host.querySelector<HTMLButtonElement>(".chat-source-jump")!;
    expect(button.hasAttribute("title")).toBe(false);
    await act(async () => {
      if (interaction === "focus") button.focus();
      else {
        button.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      }
      await vi.advanceTimersByTimeAsync(1);
    });
    const tooltip = document.querySelector('[data-slot="tooltip-content"]');
    expect(tooltip?.textContent).toContain(message.references![0].text);
    expect(tooltip?.textContent).toContain("跳转到[S84] · 第 8 页");
    await act(async () => {
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  },
);

it("navigates to the same source and closes when the preview is clicked", async () => {
  const navigate = vi.fn();
  await act(async () =>
    root.render(
      <ChatCitationNavigation.Provider
        value={{
          sourceIds: ["S25"],
          navigate,
          previews: {
            S25: { text: "Original paragraph", label: "[S25] · 第 2 页" },
          },
        }}
      >
        <MessageMarkdown content="引用[S25]" />
      </ChatCitationNavigation.Provider>,
    ),
  );
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".chat-source-jump")!.focus();
    await vi.advanceTimersByTimeAsync(1);
  });
  const preview = document.querySelector<HTMLButtonElement>(
    "button.chat-source-preview-card",
  )!;
  expect(preview.textContent).toContain("Original paragraph");
  await act(async () => {
    preview.click();
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(navigate).toHaveBeenCalledExactlyOnceWith("S25");
  expect(document.querySelector(".chat-source-preview")).toBeNull();
});

it.each(["S84", "S109"])(
  "opens a group without navigating and routes the selected %s card",
  async (selectedId) => {
    const navigate = vi.fn();
    await act(async () =>
      root.render(
        <ChatCitationNavigation.Provider
          value={{
            sourceIds: ["S84", "S109"],
            navigate,
            previews: {
              S84: { text: "First original passage", label: "[S84] · 第 2 页" },
              S109: {
                text: "Second original passage",
                label: "[S109] · 第 5 页",
              },
            },
          }}
        >
          <MessageMarkdown content="引用[S84][S109][S84]" />
        </ChatCitationNavigation.Provider>,
      ),
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>(".chat-source-jump")!.click();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(navigate).not.toHaveBeenCalled();
    const cards = document.querySelectorAll<HTMLButtonElement>(
      ".chat-source-preview-card",
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("First original passage");
    expect(cards[1].textContent).toContain("Second original passage");
    expect(cards[0].textContent).toContain("第 2 页");
    expect(cards[1].textContent).toContain("第 5 页");
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `.chat-source-preview-card[aria-label="跳转到原文段落 ${selectedId}"]`,
        )!
        .click();
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(selectedId);
    expect(document.querySelector(".chat-source-preview")).toBeNull();
  },
);
