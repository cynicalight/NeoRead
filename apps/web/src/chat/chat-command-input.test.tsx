// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, RequestError, type SkillDraft } from "@neoread/api";
import type { DocumentChatSession } from "@neoread/core";
import { ChatCommandInput } from "./ChatCommandInput";
import { createDocumentChatSession } from "./create-session";

vi.mock("@neoread/api", async (importOriginal) => ({
  ...(await importOriginal<{ RequestError: typeof RequestError }>()),
  api: {
    skills: vi.fn(),
    createChatSession: vi.fn(),
    sessionMessages: vi.fn(),
    draftSkill: vi.fn(),
    saveSkill: vi.fn(),
  },
}));
vi.mock("sonner", () => ({
  toast: { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn() },
}));
vi.mock("./custom-prompts", () => ({
  useCustomPrompts: () => ({
    prompts: [{ id: "explain", description: "解释公式", prompt: "请逐步解释公式。" }],
    loading: false,
  }),
}));

let root: Root;
let host: HTMLDivElement;
let input: HTMLTextAreaElement;
const send = vi.fn();
const exit = vi.fn();
const create = vi.fn();
const setInputValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
const type = async (value: string) => {
  await act(async () => {
    setInputValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const key = async (key: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }));
  });
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  vi.mocked(api.skills).mockResolvedValue([
    { name: "review", description: "检查推导", source: "agents" },
  ]);
  function Composer() {
    const ref = useRef<HTMLTextAreaElement>(null);
    const [value, setValue] = useState("");
    const [skill, setSkill] = useState<string>();
    return (
      <ChatCommandInput
        documentId="doc"
        sessionId="session"
        inputRef={ref}
        value={value}
        onChange={setValue}
        skill={skill}
        onSkillChange={setSkill}
        onNew={create}
        onExit={exit}
        onSend={() => {
          send({ prompt: value, skill });
          setValue("");
          setSkill(undefined);
        }}
      />
    );
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Composer />));
  input = host.querySelector("textarea")!;
  await act(async () => input.focus());
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("filters and navigates command options without moving focus from the textarea", async () => {
  await type("/");
  const list = document.getElementById(input.getAttribute("aria-controls")!)!;
  expect(input.closest('[role="combobox"]')?.getAttribute("aria-expanded")).toBe("true");
  expect(list.getAttribute("role")).toBe("listbox");
  expect(list.querySelector('[aria-selected="true"]')!.textContent).toContain("/new");
  await key("ArrowDown");
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)!.textContent).toContain("/exit");
  expect(document.activeElement).toBe(input);
  await key("Enter");
  expect(exit).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
  await type("/ne");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  await key("Tab");
  expect(create).toHaveBeenCalledOnce();
});

it("opens saved prompts and inserts the selected text without sending", async () => {
  await type("/prompt");
  await key("Enter");
  expect(document.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("常用 prompt");
  await type("/prompt 公式");
  await key("Tab");
  expect(input.value).toBe("请逐步解释公式。");
  expect(send).not.toHaveBeenCalled();
});

it("sends unmatched and dismissed commands as plain text, without intercepting IME", async () => {
  await type("/xyz");
  await key("Enter");
  expect(send).toHaveBeenNthCalledWith(1, { prompt: "/xyz", skill: undefined });
  await type("/new");
  await key("Enter", { isComposing: true });
  await key("Enter", { keyCode: 229 });
  await key("Escape", { keyCode: 229 });
  expect(input.closest('[role="combobox"]')?.getAttribute("aria-expanded")).toBe("true");
  expect(create).not.toHaveBeenCalled();
  await key("Escape");
  await key("Enter");
  expect(send).toHaveBeenNthCalledWith(2, { prompt: "/new", skill: undefined });
  await type("/prompt");
  await key("Enter");
  await type("/prompt 找不到");
  await key("Enter");
  expect(send).toHaveBeenNthCalledWith(3, { prompt: "/prompt 找不到", skill: undefined });
});

it("attaches a removable skill chip to just one question", async () => {
  await type("/rev");
  await key("Tab");
  expect(input.value).toBe("");
  const removeSkill = host.querySelector<HTMLButtonElement>('[aria-label="移除技能 review"]')!;
  expect(removeSkill).not.toBeNull();
  await act(async () => removeSkill.click());
  await type("/review");
  await key("Enter");
  await type("这个推导正确吗？");
  await key("Enter");
  expect(send).toHaveBeenNthCalledWith(1, { prompt: "这个推导正确吗？", skill: "review" });
  expect(host.querySelector('[aria-label="移除技能 review"]')).toBeNull();
  await type("下一问");
  await key("Enter");
  expect(send).toHaveBeenNthCalledWith(2, { prompt: "下一问", skill: undefined });
});

const exampleDraft: SkillDraft = {
  name: "review-derivation",
  description: "检查推导",
  body: "逐步核对公式和假设。",
};
const draftFields = () => {
  const dialog = document.querySelector('[role="dialog"]')!;
  return Array.from(
    dialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
  );
};
const clickDialogButton = async (text: string) => {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find((element) => element.textContent === text)!;
  await act(async () => button.click());
};

it("drafts from a request and opens an editable preview without saving", async () => {
  vi.mocked(api.draftSkill).mockResolvedValue(exampleDraft);
  await type("/create-skill 帮我检查推导");
  await key("Enter");
  expect(api.draftSkill).toHaveBeenCalledExactlyOnceWith(
    { documentId: "doc", sessionId: "session", request: "帮我检查推导" },
    expect.any(AbortSignal),
  );
  expect(draftFields().map((field) => field.value)).toEqual([
    exampleDraft.name, exampleDraft.description, exampleDraft.body,
  ]);
  expect(api.saveSkill).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("opens blank skill fields without calling the model and saves manual edits after confirmation", async () => {
  await type("/create-skill");
  await key("Tab");
  const fields = draftFields();
  expect(fields.map((field) => field.value)).toEqual(["", "", ""]);
  expect(api.draftSkill).not.toHaveBeenCalled();
  const values = [exampleDraft.name, exampleDraft.description, exampleDraft.body];
  await act(async () => {
    for (const [index, field] of fields.entries()) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
      setter.call(field, values[index]);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  vi.mocked(api.saveSkill).mockResolvedValue({
    name: exampleDraft.name, description: exampleDraft.description, source: "agents",
  });
  await clickDialogButton("保存技能");
  expect(api.saveSkill).toHaveBeenCalledExactlyOnceWith({ ...exampleDraft, overwrite: false });
});

it("asks before overwriting and shows the saved skill on the next slash", async () => {
  vi.mocked(api.draftSkill).mockResolvedValue(exampleDraft);
  vi.mocked(api.saveSkill).mockImplementation(async ({ overwrite }) => {
    if (!overwrite) throw new RequestError("技能已存在", undefined, undefined, 409);
    return {
      name: exampleDraft.name,
      description: exampleDraft.description,
      source: "agents",
    };
  });
  await type("/create-skill 帮我检查推导");
  await key("Enter");
  await clickDialogButton("保存技能");
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("覆盖技能？");
  expect(api.saveSkill).toHaveBeenCalledExactlyOnceWith({ ...exampleDraft, overwrite: false });
  await clickDialogButton("取消覆盖");
  expect(api.saveSkill).toHaveBeenCalledOnce();
  expect(draftFields()[0].value).toBe(exampleDraft.name);
  await clickDialogButton("保存技能");
  expect(api.saveSkill).toHaveBeenNthCalledWith(2, { ...exampleDraft, overwrite: false });
  await clickDialogButton("覆盖");
  expect(api.saveSkill).toHaveBeenNthCalledWith(3, { ...exampleDraft, overwrite: true });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  // Rendering the new skill does not wait for the next list request.
  vi.mocked(api.skills).mockReturnValueOnce(new Promise(() => {}));
  await type("/review-derivation");
  expect(document.querySelector('[role="option"]')?.textContent).toContain("/review-derivation");
});

it("reuses only a message-free new session, even before its messages load", async () => {
  const current: DocumentChatSession = {
    id: "session", documentId: "doc", title: "新会话", provider: "api", createdAt: "", updatedAt: "",
  };
  const chat = { loaded: false, busy: false, messages: [], archived: [], messageKeys: {} };
  const refresh = vi.fn().mockResolvedValue(undefined);
  const select = vi.fn();
  vi.mocked(api.sessionMessages).mockResolvedValue([]);
  await createDocumentChatSession("doc", "api", refresh, select, { current, chat });
  expect(api.sessionMessages).toHaveBeenCalledWith("doc", "session");
  expect(api.createChatSession).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();

  vi.mocked(api.createChatSession).mockResolvedValue({ ...current, id: "new" });
  const user = { id: "user", documentId: "doc", role: "user" as const, content: "question", createdAt: "" };
  await createDocumentChatSession("doc", "api", refresh, select, {
    current,
    chat: { ...chat, loaded: true, messages: [user] },
  });
  expect(api.createChatSession).toHaveBeenCalledExactlyOnceWith("doc", "api");
  expect(refresh).toHaveBeenCalledOnce();
  expect(select).toHaveBeenCalledExactlyOnceWith("new");
});
