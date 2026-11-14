// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { closeHistory } from "@milkdown/kit/prose/history";
import { Slice, DOMParser, DOMSerializer } from "@milkdown/kit/prose/model";
import { createPaperNoteEditor } from "./paper-note-milkdown";

const editors: Awaited<ReturnType<typeof createPaperNoteEditor>>[] = [];
const create = async (
  body: string,
  change = vi.fn(),
  options: Parameters<typeof createPaperNoteEditor>[3] = {},
) => {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = await createPaperNoteEditor(host, body, change, options);
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
  'before<br onclick="alert(1)">after',
  "before<br class=custom>after",
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

it("preserves selection on self-echo and makes external replacement the undo baseline", async () => {
  const { editor, view, change } = await create("old text");
  view.dispatch(view.state.tr.insertText("!", 4));
  const echo = change.mock.calls.at(-1)![0];
  const localState = view.state;
  editor.setMarkdown(echo);
  expect(view.state).toBe(localState);
  const raw = "##  External\n\n$x_2$\n";
  editor.setMarkdown(raw);
  expect(view.state.doc.textContent).toContain("External");
  const beforeUndo = view.state.doc;
  const { undo } = await import("@milkdown/kit/prose/history");
  expect(undo(view.state, view.dispatch)).toBe(false);
  expect(view.state.doc.eq(beforeUndo)).toBe(true);
  expect(change).toHaveBeenCalledTimes(1);
});

it.each(["<br>", "<br/>", "<br />", "<BR >"])(
  "accepts %s through source and rich round trips",
  async (br) => {
    const raw = `first${br}second\n\n${br}\n\nlast`;
    const { editor, view, change } = await create(raw);
    expect(change).not.toHaveBeenCalled();
    expect(view.state.doc.childCount).toBe(3);
    expect(view.state.doc.child(1).textContent).toBe("");
    expect(view.dom.querySelector("p br")).not.toBeNull();
    expect(view.dom.querySelector("[data-type=html]")).toBeNull();
    view.dispatch(view.state.tr.insertText("!", 2));
    const saved = change.mock.calls.at(-1)![0];
    const reopened = await create(saved);
    expect(reopened.view.state.doc.toJSON()).toEqual(view.state.doc.toJSON());
    editor.setMarkdown(raw);
    expect(view.state.doc.child(0).textContent).toBe("firstsecond");
  },
);
it("preserves br inside code and roundtrips table cell breaks", async () => {
  const raw =
    "`<br>`\n\n```html\n<br />\n```\n\n| a | b |\n| - | - |\n| first<br>second | x |";
  const { editor, view } = await create(raw);
  const saved = editor.ctx.get(serializerCtx)(view.state.doc);
  expect(saved).toContain("`<br>`");
  expect(saved).toContain("```html\n<br />\n```");
  expect((await create(saved)).view.state.doc.toJSON()).toEqual(
    view.state.doc.toJSON(),
  );
});

const typeText = (
  view: import("@milkdown/kit/prose/view").EditorView,
  text: string,
) => {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (handler) =>
      handler(view, from, to, char, () => view.state.tr.insertText(char)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char));
  }
};

it("turns typed inline and display math into formulas in rich mode", async () => {
  const { view, editor } = await create("");
  typeText(view, "$x_1$");
  expect(view.dom.querySelectorAll(".katex")).toHaveLength(1);
  expect(editor.ctx.get(serializerCtx)(view.state.doc)).toContain("$x_1$");
  editor.setMarkdown("");
  typeText(view, String.raw`$\frac{a}{b}$`);
  expect(view.dom.querySelector(".katex")).not.toBeNull();
  expect(view.state.doc.firstChild?.firstChild?.attrs.value).toBe(
    String.raw`\frac{a}{b}`,
  );
  editor.setMarkdown("");
  typeText(view, "$$x^2$$");
  expect(view.state.doc.firstChild?.type.name).toBe("paper_math_block");
  expect(
    view.dom.querySelector(".markdown-math.display .katex"),
  ).not.toBeNull();
});

it("starts an editable display formula with dollar fences and Enter, while respecting IME", async () => {
  const onEditMath = vi.fn();
  const { view, editor } = await create("", vi.fn(), { onEditMath });
  typeText(view, "$$");
  view.dispatch(
    view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)),
  );
  key(view, "Enter", { isComposing: true });
  expect(onEditMath).not.toHaveBeenCalled();
  expect(view.dom.querySelector("[data-note-math]")).toBeNull();
  editor.setMarkdown("");
  typeText(view, "$$");
  view.dispatch(
    view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)),
  );
  expect(key(view, "Enter")).toBe(true);
  expect(onEditMath).toHaveBeenCalledOnce();
  expect(onEditMath.mock.calls[0][0].display).toBe(true);
  expect(onEditMath.mock.calls[0][0].update("x^2")).toBe(true);
  expect(view.state.doc.firstChild?.attrs.value).toBe("x^2");
});

it("edits formulas synchronously, supports undo, and rejects stale editors after replacement", async () => {
  const onEditMath = vi.fn();
  const { view, editor, change } = await create("$x_1$", vi.fn(), {
    onEditMath,
  });
  (view.dom.querySelector("[data-note-math]") as HTMLElement).click();
  const request = onEditMath.mock.calls[0][0];
  expect(request.update("x_2")).toBe(true);
  expect(change.mock.calls.at(-1)?.[0]).toContain("$x_2$");
  expect(request.update("x_3")).toBe(true);
  expect(change.mock.calls.at(-1)?.[0]).toContain("$x_3$");
  const formula = view.dom.querySelector<HTMLElement>("[data-note-math]")!;
  formula.focus();
  const undo = new KeyboardEvent("keydown", {
    key: "z",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  formula.dispatchEvent(undo);
  expect(undo.defaultPrevented).toBe(true);
  expect(view.state.doc.firstChild?.firstChild?.attrs.value).toBe("x_1");
  editor.setMarkdown("$external$");
  expect(request.update("stale")).toBe(false);
  expect(view.state.doc.firstChild?.firstChild?.attrs.value).toBe("external");
});

it("pastes Markdown math into rich content and keeps surrounding text", async () => {
  const { view, editor } = await create("before after");
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, 8)),
  );
  const event = {
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? "$x_1$" : ""),
    },
  } as ClipboardEvent;
  expect(
    view.someProp("handlePaste", (handler) =>
      handler(view, event, Slice.empty),
    ),
  ).toBe(true);
  const saved = editor.ctx.get(serializerCtx)(view.state.doc);
  expect(saved).toContain("before $x_1$after");
  expect(view.dom.querySelector(".katex")).not.toBeNull();
});

it("keeps code and escaped dollars literal and serializes cleared math without empty fences", async () => {
  const { view, editor } = await create("`code`");
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)),
  );
  typeText(view, "$x$");
  expect(view.dom.querySelector(".katex")).toBeNull();
  editor.setMarkdown("");
  typeText(view, "\\$x$");
  expect(view.dom.querySelector(".katex")).toBeNull();
  editor.setMarkdown("$x$");
  view.dispatch(view.state.tr.setNodeAttribute(1, "value", ""));
  const saved = editor.ctx.get(serializerCtx)(view.state.doc);
  expect(saved).not.toContain("$");
});

it("inserts block math inside lists without losing the item or following content", async () => {
  const onEditMath = vi.fn();
  const { view, editor } = await create("- first\n- middle\n- last", vi.fn(), {
    onEditMath,
  });
  let target = 0;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === "middle")
      target = pos + 1;
  });
  const tr = view.state.tr.insertText("$$", target, target + 6);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, target + 2)));
  expect(view.state.selection.$from.parent.textContent).toBe("$$");
  expect(key(view, "Enter")).toBe(true);
  expect(onEditMath.mock.calls[0][0].update("x^2")).toBe(true);
  const saved = editor.ctx.get(serializerCtx)(view.state.doc);
  expect(saved).toContain("first");
  expect(saved).toContain("last");
  expect(view.state.doc.firstChild?.type.name).toBe("bullet_list");
  expect(view.dom.querySelector("li [data-note-math]")).not.toBeNull();
  const parsed = editor.ctx.get(parserCtx)(saved);
  expect(parsed.firstChild?.type.name).toBe("bullet_list");
  const values: string[] = [];
  parsed.descendants((node) => {
    if (node.type.name === "paper_math_block") values.push(node.attrs.value);
  });
  expect(values).toContain("x^2");
});

it("keeps formula edits attached to their node after surrounding text moves", async () => {
  const onEditMath = vi.fn();
  const { view, editor } = await create("word $x$", vi.fn(), { onEditMath });
  view.dom.querySelector<HTMLElement>("[data-note-math]")!.click();
  view.dispatch(view.state.tr.insertText("before ", 1));
  expect(onEditMath.mock.calls[0][0].update("y")).toBe(true);
  expect(editor.ctx.get(serializerCtx)(view.state.doc)).toContain(
    "before word $y$",
  );
});

it("preserves pasted block math when a tight list is serialized and reopened", async () => {
  const { view, editor } = await create("- first\n- middle\n- last");
  let from = 0;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" && node.textContent === "middle")
      from = pos + 1;
  });
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, from, from + 6),
    ),
  );
  const event = {
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? "$$\nx^2\n$$" : ""),
    },
  } as ClipboardEvent;
  expect(
    view.someProp("handlePaste", (handler) =>
      handler(view, event, Slice.empty),
    ),
  ).toBe(true);
  const saved = editor.ctx.get(serializerCtx)(view.state.doc);
  editor.setMarkdown(saved + "\n");
  expect(
    view.dom.querySelector("li [data-note-math]")?.getAttribute("data-value"),
  ).toBe("x^2");
  expect(saved).toContain("first");
  expect(saved).toContain("last");
});
