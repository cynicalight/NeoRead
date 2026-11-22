// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CustomPrompt } from "@neoread/api";
import { reportDiagnostic } from "../diagnostics";
let CustomPromptSettings: typeof import("../CustomPromptSettings").CustomPromptSettings;
let CustomPrompts: typeof import("./CustomPrompts").CustomPrompts;
const transport = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@neoread/api", () => ({
  api: {
    customPromptPreferences: transport.read,
    saveCustomPromptPreferences: transport.write,
  },
}));
let saved: CustomPrompt[] | undefined;
const readPrompts = () => saved ?? [];

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
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  saved = undefined;
  transport.read.mockImplementation(async () =>
    saved === undefined ? {} : { prompts: structuredClone(saved) },
  );
  transport.write.mockImplementation(async (prompts: CustomPrompt[]) => {
    saved = structuredClone(prompts);
    return { prompts: saved };
  });
  ({ CustomPromptSettings } = await import("../CustomPromptSettings"));
  ({ CustomPrompts } = await import("./CustomPrompts"));
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
  transport.write.mockRejectedValue(
    new Error("private prompt must not enter logs"),
  );
  await click("保存");
  expect(button("原描述")).toBeDefined();
  expect(button("新描述")).toBeUndefined();
  expect(document.querySelector("input")?.value).toBe("新描述");
  expect(readPrompts()[0].description).toBe("原描述");
});

it("does not overwrite invalid storage while reading", async () => {
  localStorage.setItem("neoread.custom-prompts", "invalid-json");
  await render();
  expect(readPrompts()).toEqual([]);
  expect(localStorage.getItem("neoread.custom-prompts")).toBe("invalid-json");
  expect(transport.write).not.toHaveBeenCalled();
  expect(button("添加").disabled).toBe(true);
  expect(reportDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chat.prompts.load_failed",
      detail: "reason=legacy_json_invalid",
    }),
  );
});

const legacy = [
  { id: "legacy", description: "旧功能", prompt: "private_prompt_marker" },
];

it("migrates legacy data only after persistence succeeds", async () => {
  localStorage.setItem("neoread.custom-prompts", JSON.stringify(legacy));
  await render();
  expect(saved).toEqual(legacy);
  expect(localStorage.getItem("neoread.custom-prompts")).toBeNull();
  expect(button("旧功能")).toBeDefined();
  // A fresh renderer at a different origin has no access to the old localStorage.
  await act(async () => root.render(null));
  localStorage.clear();
  vi.resetModules();
  ({ CustomPromptSettings } = await import("../CustomPromptSettings"));
  ({ CustomPrompts } = await import("./CustomPrompts"));
  await render();
  await click("旧功能");
  expect(send).toHaveBeenCalledWith("private_prompt_marker");
});

it("keeps the legacy copy and editable draft after a migration write fails", async () => {
  localStorage.setItem("neoread.custom-prompts", JSON.stringify(legacy));
  transport.write.mockRejectedValue(new Error("private_prompt_marker"));
  await render();
  expect(localStorage.getItem("neoread.custom-prompts")).toBe(
    JSON.stringify(legacy),
  );
  expect(button("旧功能")).toBeDefined();
  expect(reportDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "chat.prompts.save_failed",
      detail: "reason=server_write_failed",
    }),
  );
  expect(JSON.stringify(vi.mocked(reportDiagnostic).mock.calls)).not.toContain(
    "private_prompt_marker",
  );
  await click("编辑");
  await type("input", "新功能");
  await click("保存");
  expect(document.querySelector("input")?.value).toBe("新功能");
});

it("blocks writes after a failed server read, then recovers on retry", async () => {
  localStorage.setItem("neoread.custom-prompts", JSON.stringify(legacy));
  transport.read.mockRejectedValueOnce(new Error("private_prompt_marker"));
  await render();
  expect(button("添加").disabled).toBe(true);
  expect(transport.write).not.toHaveBeenCalled();
  expect(localStorage.getItem("neoread.custom-prompts")).not.toBeNull();
  expect(reportDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ detail: "reason=server_read_failed" }),
  );
  await click("重试");
  expect(saved).toEqual(legacy);
  expect(button("添加").disabled).toBe(false);
});

it.each([
  { prompts: [] },
  {
    prompts: [
      { id: "server", description: "数据库配置", prompt: "保留数据库配置" },
    ],
  },
])(
  "prefers the database over a stale legacy copy (case %#)",
  async ({ prompts }) => {
    saved = prompts;
    localStorage.setItem("neoread.custom-prompts", JSON.stringify(legacy));
    await render();
    expect(saved).toEqual(prompts);
    expect(button("旧功能")).toBeUndefined();
    expect(transport.write).not.toHaveBeenCalled();
  },
);

it("diagnoses legacy storage read errors without leaking their text", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("private_prompt_marker");
  });
  await render();
  expect(reportDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ detail: "reason=legacy_storage_read_failed" }),
  );
  expect(JSON.stringify(vi.mocked(reportDiagnostic).mock.calls)).not.toContain(
    "private_prompt_marker",
  );
  expect(transport.write).not.toHaveBeenCalled();
});

it.each([
  null,
  { unexpected: "private_prompt_marker" },
  { prompts: "private_prompt_marker" },
  { prompts: [{ id: "p", prompt: "private_prompt_marker" }] },
])(
  "rejects malformed server data without replacing it (case %#)",
  async (value) => {
    transport.read.mockResolvedValue(value);
    await render();
    expect(button("添加").disabled).toBe(true);
    expect(transport.write).not.toHaveBeenCalled();
    expect(reportDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "reason=server_data_invalid" }),
    );
  },
);

it("diagnoses malformed legacy data and keeps it intact", async () => {
  const raw = JSON.stringify([{ prompt: "private_prompt_marker" }]);
  localStorage.setItem("neoread.custom-prompts", raw);
  await render();
  expect(reportDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ detail: "reason=legacy_data_invalid" }),
  );
  expect(localStorage.getItem("neoread.custom-prompts")).toBe(raw);
  expect(transport.write).not.toHaveBeenCalled();
});

it("treats cleanup failure as saved and ignores the leftover copy on reload", async () => {
  localStorage.setItem("neoread.custom-prompts", JSON.stringify(legacy));
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("private_prompt_marker");
  });
  await render();
  expect(saved).toEqual(legacy);
  expect(button("添加").disabled).toBe(false);
  expect(reportDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ event: "chat.prompts.migration_cleanup_failed" }),
  );
});

it("waits for persistence before updating suggestions and prevents duplicate saves", async () => {
  await render();
  expect(transport.read).toHaveBeenCalledTimes(1);
  await click("添加");
  await type("input", "等待保存");
  await type("textarea", "保存后才出现");
  let finish!: () => void;
  transport.write.mockImplementationOnce(
    (prompts: CustomPrompt[]) =>
      new Promise((resolve) => {
        finish = () => {
          saved = structuredClone(prompts);
          resolve({ prompts: saved });
        };
      }),
  );
  await click("保存");
  expect(button("保存").disabled).toBe(true);
  expect(document.querySelector("textarea")?.disabled).toBe(true);
  expect(button("等待保存")).toBeUndefined();
  await click("保存");
  expect(transport.write).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(button("等待保存")).toBeDefined();
});

it("does not erase an oversized legacy prompt and lets the user shorten it", async () => {
  const oversized = [{ ...legacy[0], prompt: "汉".repeat(5334) }];
  const raw = JSON.stringify(oversized);
  localStorage.setItem("neoread.custom-prompts", raw);
  await render();
  expect(transport.write).not.toHaveBeenCalled();
  expect(localStorage.getItem("neoread.custom-prompts")).toBe(raw);
  expect(button("旧功能").disabled).toBe(true);
  await click("编辑");
  expect(button("保存").disabled).toBe(true);
  await type("textarea", "缩短后的提示词");
  await click("保存");
  expect(saved?.[0].prompt).toBe("缩短后的提示词");
  expect(localStorage.getItem("neoread.custom-prompts")).toBeNull();
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
