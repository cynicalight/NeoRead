// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { closeHistory } from "@milkdown/kit/prose/history";
import { DOMParser, DOMSerializer } from "@milkdown/kit/prose/model";
import { createPaperNoteEditor } from "./paper-note-milkdown";

const editors: Awaited<ReturnType<typeof createPaperNoteEditor>>[] = [];
const create = async (body: string, change = vi.fn()) => {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = await createPaperNoteEditor(host, body, change);
  editors.push(editor);
  return { editor, view: editor.ctx.get(editorViewCtx), change, host };
};
beforeEach(() => {
  // ProseMirror scrolling requires layout APIs which jsdom does not implement.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
});
afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("roundtrips formulas, structural Markdown and reader links through the real parser and serializer", async () => {
  const body =
    String.raw`# Heading

**bold** *italic* ~~gone~~ [source](reader://document/p?annotation=a) [citation](#reader-citation?block=a)

> Quote

1. First
2. Second
   - Nested

- [x] Done
- [ ] Todo

| A | B |
| :- | -: |
| 1 | 2 |

Inline $\frac{x_{1}}{y^{2}}$ and $a_b$.

$$
\begin{aligned}
x_{1} &= \frac{a}{b} \\
y &= z^{2}
\end{aligned}
$$

` + "```js\nconst price = '$x$';\n```\n";
  const { editor, view, change, host } = await create(body);
  expect(change).not.toHaveBeenCalled();
  const serialize = editor.ctx.get(serializerCtx);
  const parse = editor.ctx.get(parserCtx);
  const result = serialize(view.state.doc);
  expect(parse(result).toJSON()).toEqual(parse(body).toJSON());
  expect(result).toContain(String.raw`$\frac{x_{1}}{y^{2}}$`);
  expect(result).toContain(String.raw`\begin{aligned}`);
  expect(result).toContain("reader://document/p?annotation=a");
  expect(result).toContain("#reader-citation?block=a");
  expect(result).toContain("const price = '$x$';");
  expect(host.querySelectorAll(".katex")).toHaveLength(3);
  expect(host.querySelector("table")).not.toBeNull();
  expect(host.querySelector('[data-checked="true"]')).not.toBeNull();
});

it("updates the shared draft synchronously, ignores selection changes, and never loads images or activates links", async () => {
  const { view, change, host } = await create(
    "Original [unsafe](javascript:alert%281%29) ![private](https://example.com/tracker.png)",
  );
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)),
  );
  expect(change).not.toHaveBeenCalled();
  view.dispatch(view.state.tr.insertText("Latest ", 1));
  expect(change).toHaveBeenCalledTimes(1);
  expect(change.mock.calls[0][0]).toContain("Latest Original");
  expect(host.querySelector("img[src], a[href], script, iframe")).toBeNull();
  expect(change.mock.calls[0][0]).toContain("https://example.com/tracker.png");
});

it.each([
  "reader://document/p?annotation=a",
  "neoread://open?id=p&annotation=a",
])(
  "preserves inert links (%s), image metadata and math through the editor clipboard DOM",
  async (url) => {
    const { view } = await create(
      `[source](${url} "Source title") ![private](https://example.com/tracker.png "Image title") $x_{1}$`,
    );
    const dom = document.createElement("div");
    dom.append(
      DOMSerializer.fromSchema(view.state.schema).serializeFragment(
        view.state.doc.content,
      ),
    );
    expect(dom.querySelector("a[href], img[src]")).toBeNull();
    const pasted = DOMParser.fromSchema(view.state.schema).parse(dom);
    expect(pasted.toJSON()).toEqual(view.state.doc.toJSON());
  },
);

it("lets users toggle task checkboxes without losing their Markdown content", async () => {
  const { view, host, change } = await create("- [ ] Finish this");
  const checkbox = host.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  expect(checkbox).not.toBeNull();
  checkbox!.click();
  expect(view.state.doc.child(0).child(0).attrs.checked).toBe(true);
  expect(change.mock.calls.at(-1)?.[0]).toContain("[x] Finish this");
});

it.each([
  "before\n\n<div>keep me</div>\n\nafter",
  "[link][id]\n\n[id]: https://example.com",
  "```js filename=file.js\nconst x = 1\n```",
  "$$ numbered\nx_{1}\n$$",
])(
  "refuses unsupported content before allowing rich edits: %s",
  async (body) => {
    const host = document.createElement("div");
    await expect(createPaperNoteEditor(host, body, vi.fn())).rejects.toThrow(
      /源码/,
    );
    expect(host.querySelector("[contenteditable]")).toBeNull();
  },
);

const key = (
  view: Awaited<ReturnType<typeof create>>["view"],
  key: string,
  options: KeyboardEventInit = {},
) => {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  view.dom.dispatchEvent(event);
  return event.defaultPrevented;
};
it("uses upstream Enter, Tab and Shift-Tab list commands, but leaves ordinary Tab available for focus", async () => {
  const { view } = await create("- first\n- second");
  view.dispatch(
    view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)),
  );
  expect(key(view, "Enter")).toBe(true);
  expect(view.state.doc.child(0).childCount).toBe(3);
  expect(key(view, "Tab")).toBe(true);
  expect(view.state.selection.$from.depth).toBe(5);
  expect(key(view, "Tab", { shiftKey: true })).toBe(true);
  expect(view.state.selection.$from.depth).toBe(3);
  expect(key(view, "Enter")).toBe(true);
  expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
  expect(view.state.selection.$from.depth).toBe(1);
  expect(key(view, "Tab")).toBe(false);
});

it("binds bold, italic, undo and redo to real editor commands", async () => {
  const { view, editor } = await create("words");
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)),
  );
  expect(key(view, "b", { ctrlKey: true })).toBe(true);
  expect(editor.ctx.get(serializerCtx)(view.state.doc)).toContain("**words**");
  view.dispatch(closeHistory(view.state.tr));
  expect(key(view, "i", { ctrlKey: true })).toBe(true);
  expect(
    view.state.doc.firstChild!.firstChild!.marks.map((mark) => mark.type.name),
  ).toContain("emphasis");
  expect(key(view, "z", { ctrlKey: true })).toBe(true);
  expect(
    view.state.doc.firstChild!.firstChild!.marks.map((mark) => mark.type.name),
  ).not.toContain("emphasis");
  expect(key(view, "z", { ctrlKey: true, shiftKey: true })).toBe(true);
  expect(
    view.state.doc.firstChild!.firstChild!.marks.map((mark) => mark.type.name),
  ).toContain("emphasis");
});
