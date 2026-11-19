// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "@neoread/api";
import { PaperNoteRichEditor } from "./PaperNoteRichEditor";

vi.mock("./diagnostics", () => ({ reportDiagnostic: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
// Source mode is the editor whenever the rich chunk is unavailable.
vi.mock("./paper-note-milkdown", () => {
  throw new Error("chunk unavailable");
});

const asset = `assets/${"a".repeat(64)}.png`;
const png = new File(["png"], "image.png", { type: "image/png" });
const paste = (files: File[], text = "") => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  return event;
};
const setValue = (input: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

let root: Root, host: HTMLDivElement;
let latest = "";
const uploading = vi.fn();
const orphaned = vi.fn();
function Note({ initial }: { initial: string }) {
  const [body, setBody] = useState(initial);
  latest = body;
  return (
    <PaperNoteRichEditor
      documentId="doc"
      body={body}
      disabled={false}
      onChange={setBody}
      onUploadingChange={uploading}
      onOrphanedImage={orphaned}
    />
  );
}
const mount = async (initial: string) => {
  await act(async () => root.render(<Note initial={initial} />));
  await act(async () => {
    await vi.waitFor(() => expect(host.textContent).toContain("加载失败"));
  });
  return host.querySelector("textarea")!;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 18, 9, 5, 7));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  uploading.mockReset();
  orphaned.mockReset();
});

it("replaces the selection with a timestamped image where it was pasted, despite later typing", async () => {
  let finish!: (value: { path: string }) => void;
  const pending = new Promise<{ path: string }>(
    (resolve) => (finish = resolve),
  );
  const upload = vi.spyOn(api, "uploadNoteImage").mockReturnValue(pending);
  const input = await mount("before middle after");
  input.setSelectionRange(7, 13);
  const event = paste([png]);
  await act(async () => input.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(upload).toHaveBeenCalledExactlyOnceWith("doc", png);
  expect(latest).toBe("before middle after");
  expect(host.textContent).toContain("正在上传图片");
  expect(uploading).toHaveBeenLastCalledWith(true);
  await act(async () => setValue(input, "new before middle after"));
  await act(async () => finish({ path: asset }));
  expect(latest).toBe(`new before ![2026-11-18_09-05-07](${asset}) after`);
  expect(host.textContent).not.toContain("正在上传图片");
  expect(uploading).toHaveBeenLastCalledWith(false);
});

it("keeps text and mixed clipboards as ordinary Markdown paste", async () => {
  const upload = vi.spyOn(api, "uploadNoteImage");
  const input = await mount("text");
  const event = paste(
    [png],
    "**粘贴的文字** ![远程](https://example.com/x.png)",
  );
  await act(async () => input.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(upload).not.toHaveBeenCalled();
  expect(latest).toBe("text");
});

it("reports a failed upload without changing the note", async () => {
  vi.spyOn(api, "uploadNoteImage").mockRejectedValue(new Error("磁盘已满"));
  const input = await mount("text");
  input.setSelectionRange(0, 4);
  await act(async () => input.dispatchEvent(paste([png])));
  expect(toast.error).toHaveBeenCalledWith("图片上传失败", {
    description: "磁盘已满",
  });
  expect(latest).toBe("text");
});

it("hands an upload that finishes after unmount to the owner", async () => {
  let finish!: (value: { path: string }) => void;
  const pending = new Promise<{ path: string }>(
    (resolve) => (finish = resolve),
  );
  vi.spyOn(api, "uploadNoteImage").mockReturnValue(pending);
  const input = await mount("text");
  await act(async () => input.dispatchEvent(paste([png])));
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => finish({ path: asset }));
  expect(orphaned).toHaveBeenCalledExactlyOnceWith(
    `![2026-11-18_09-05-07](${asset})`,
  );
  expect(uploading).toHaveBeenLastCalledWith(false);
});
