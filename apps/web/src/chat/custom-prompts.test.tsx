// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CustomPromptSettings } from "../CustomPromptSettings";
import { CustomPrompts } from "./CustomPrompts";
import { readPrompts } from "./custom-prompts";

vi.mock("../diagnostics", () => ({ reportDiagnostic: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
let host: HTMLDivElement, root: Root;
const send = vi.fn();
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  )!;
const click = async (label: string) => act(async () => button(label).click());
async function type(tag: "input" | "textarea", value: string) {
  await act(async () => {
    const element = document.querySelector(tag)!;
    const prototype =
      tag === "input"
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(disabled = false) {
  await act(async () =>
    root.render(
      <>
        <CustomPromptSettings />
        <CustomPrompts disabled={disabled} onSend={send} />
      </>,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  send.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("saves description and prompt separately, updates badges, restores and deletes", async () => {
  await render();
  expect(document.querySelector("input")).toBeNull();
  await click("添加");
  await type("input", "解释术语");
  await type("textarea", "请解释当前阅读内容中的专业术语。");
  await click("保存");
  expect(readPrompts()[0]).toMatchObject({
    description: "解释术语",
    prompt: "请解释当前阅读内容中的专业术语。",
  });
  await click("解释术语");
  expect(send).toHaveBeenCalledWith("请解释当前阅读内容中的专业术语。");
  await click("编辑");
  await type("input", "举例说明");
  await type("textarea", "请举一个具体例子。");
  await click("保存");
  expect(button("解释术语")).toBeUndefined();
  await click("举例说明");
  expect(send).toHaveBeenLastCalledWith("请举一个具体例子。");
  await render(true);
  expect(button("举例说明").disabled).toBe(true);
  await act(async () => root.render(null));
  await render();
  expect(button("举例说明")).toBeDefined();
  await click("删除");
  expect(readPrompts()).toEqual([]);
  expect(button("举例说明")).toBeUndefined();
});

it("retains the saved item and edit draft when persistence fails", async () => {
  await render();
  expect(document.querySelector("input")).toBeNull();
  await click("添加");
  await type("input", "原描述");
  await type("textarea", "原 prompt");
  await click("保存");
  await click("编辑");
  await type("input", "新描述");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await click("保存");
  expect(button("原描述")).toBeDefined();
  expect(button("新描述")).toBeUndefined();
  expect(document.querySelector("input")?.value).toBe("新描述");
  expect(readPrompts()[0].description).toBe("原描述");
});

it("does not overwrite invalid storage while reading", () => {
  localStorage.setItem("neoread.custom-prompts", "invalid-json");
  expect(readPrompts()).toEqual([]);
  expect(localStorage.getItem("neoread.custom-prompts")).toBe("invalid-json");
});

it.each([
  ["a".repeat(16000), false],
  ["a".repeat(16001), true],
  ["汉".repeat(5333), false],
  ["汉".repeat(5334), true],
  ["😀".repeat(4000), false],
  ["😀".repeat(4001), true],
])("validates UTF-8 bytes before saving (case %#)", async (prompt, invalid) => {
  await render();
  await click("添加");
  await type("input", "长度检查");
  await type("textarea", prompt);
  expect(button("保存").disabled).toBe(invalid);
  expect(document.querySelector("textarea")?.getAttribute("aria-invalid")).toBe(
    String(invalid),
  );
});
