// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { focusSelectionScope, selectAllInScope } from "./scoped-selection";
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  host.innerHTML =
    '<div class="neoread-engine"><p>原文内容</p></div><div class="translation-document"><p>译文内容</p></div><div class="chat-scroll"><p>聊天内容</p><button>复制</button></div><textarea>问题草稿</textarea>';
  host.addEventListener("pointerdown", focusSelectionScope);
  host.addEventListener("keydown", selectAllInScope);
  document.body.append(host);
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  host.remove();
});
it.each(["neoread-engine", "translation-document", "chat-scroll"])(
  "selects only the focused %s pane",
  (name) => {
    const scope = host.querySelector<HTMLElement>(`.${name}`)!;
    scope
      .querySelector("p")!
      .dispatchEvent(
        new MouseEvent("pointerdown", { button: 0, bubbles: true }),
      );
    expect(document.activeElement).toBe(scope);
    const event = new KeyboardEvent("keydown", {
      key: "a",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.activeElement!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(window.getSelection()!.toString()).toBe(scope.textContent);
    expect(window.getSelection()!.toString()).not.toContain("问题草稿");
  },
);
it("preserves native text editing and ignores composition, unrelated keys and inactive panes", () => {
  const input = host.querySelector("textarea")!;
  input.focus();
  input.select();
  const event = new KeyboardEvent("keydown", {
    key: "a",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(input.selectionEnd).toBe(input.value.length);
  host
    .querySelector("button")!
    .dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }));
  expect(document.activeElement).toBe(input);
  const scope = host.querySelector<HTMLElement>(".translation-document")!;
  for (const options of [
    { key: "a", ctrlKey: true, isComposing: true },
    { key: "c", ctrlKey: true },
  ]) {
    const key = new KeyboardEvent("keydown", {
      ...options,
      bubbles: true,
      cancelable: true,
    });
    scope.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
  }
  scope.setAttribute("inert", "");
  const inactive = new KeyboardEvent("keydown", {
    key: "a",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  scope.dispatchEvent(inactive);
  expect(inactive.defaultPrevented).toBe(false);
});
