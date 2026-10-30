import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  parserCtx,
  remarkCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import {
  commonmark,
  imageSchema,
  linkSchema,
} from "@milkdown/kit/preset/commonmark";
import { gfm, extendListItemSchemaForTask } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { EditorState, Selection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $node, $remark } from "@milkdown/kit/utils";
import katex from "katex";
import remarkMath from "remark-math";
import type { Root, RootContent } from "mdast";
import "katex/dist/katex.min.css";

const mathPlugin = $remark("paperNoteMath", () => remarkMath);
const mathNode = (display: boolean) => {
  const id = display ? "paper_math_block" : "paper_math_inline";
  return $node(id, () => ({
    group: display ? "block" : "inline",
    inline: !display,
    atom: true,
    selectable: true,
    attrs: { value: { default: "", validate: "string" } },
    parseDOM: [
      {
        tag: `[data-note-math="${id}"]`,
        getAttrs: (dom) => ({
          value: (dom as HTMLElement).dataset.value ?? "",
        }),
      },
    ],
    toDOM: (node) => {
      const dom = document.createElement(display ? "div" : "span");
      dom.dataset.noteMath = id;
      dom.dataset.value = node.attrs.value;
      dom.className = display ? "markdown-math display" : "markdown-math";
      dom.title = "在源码中编辑公式";
      dom.contentEditable = "false";
      // Only KaTeX produces this HTML, with the same safety limits as previews.
      dom.innerHTML = katex.renderToString(node.attrs.value, {
        displayMode: display,
        throwOnError: false,
        trust: false,
        strict: "warn",
        maxExpand: 100,
        maxSize: 20,
      });
      return dom;
    },
    parseMarkdown: {
      match: (node) => node.type === (display ? "math" : "inlineMath"),
      runner: (state, node, type) => {
        state.addNode(type, { value: node.value });
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === id,
      runner: (state, node) => {
        state.addNode(
          display ? "math" : "inlineMath",
          undefined,
          node.attrs.value,
        );
      },
    },
  }));
};

// Keep destinations as Markdown data; editing must never navigate or fetch.
const inertLink = linkSchema.extendSchema((previous) => (ctx) => ({
  ...previous(ctx),
  parseDOM: [
    {
      tag: "span[data-note-link]",
      getAttrs: (dom) => ({
        href: (dom as HTMLElement).dataset.noteLink,
        title: (dom as HTMLElement).getAttribute("title"),
      }),
    },
    ...(previous(ctx).parseDOM ?? []),
  ],
  toDOM: (mark) => [
    "span",
    { "data-note-link": mark.attrs.href, title: mark.attrs.title },
    0,
  ],
}));
const inertImage = imageSchema.extendSchema((previous) => (ctx) => ({
  ...previous(ctx),
  parseDOM: [
    {
      tag: "span[data-note-image]",
      getAttrs: (dom) => {
        const element = dom as HTMLElement;
        return {
          src: element.dataset.noteImage ?? "",
          alt: element.dataset.alt ?? "",
          title: element.getAttribute("title") ?? "",
        };
      },
    },
    ...(previous(ctx).parseDOM ?? []),
  ],
  toDOM: (node) => [
    "span",
    {
      "data-note-image": node.attrs.src,
      "data-alt": node.attrs.alt,
      title: node.attrs.title,
      class: "text-muted-foreground",
    },
    `[图片：${node.attrs.alt || "未加载"}]`,
  ],
}));
const taskCheckbox = extendListItemSchemaForTask.extendSchema(
  (previous) => (ctx) => ({
    ...previous(ctx),
    toDOM: (node) => {
      if (node.attrs.checked == null) return previous(ctx).toDOM!(node);
      return [
        "li",
        {
          "data-item-type": "task",
          "data-label": node.attrs.label,
          "data-list-type": node.attrs.listType,
          "data-spread": node.attrs.spread,
          "data-checked": node.attrs.checked,
        },
        [
          "input",
          {
            type: "checkbox",
            checked: node.attrs.checked ? "" : undefined,
            contenteditable: "false",
            "aria-label": "完成任务",
            "data-note-task": "",
          },
        ],
        ["div", 0],
      ];
    },
  }),
);

const supported = new Set([
  "root",
  "paragraph",
  "heading",
  "text",
  "emphasis",
  "strong",
  "delete",
  "link",
  "image",
  "inlineCode",
  "code",
  "blockquote",
  "list",
  "listItem",
  "break",
  "thematicBreak",
  "table",
  "tableRow",
  "tableCell",
  "math",
  "inlineMath",
]);
function assertSupported(tree: Root | RootContent) {
  if (!supported.has(tree.type) || ("meta" in tree && tree.meta))
    throw new Error("笔记包含暂不支持的格式，已保留在源码中编辑");
  if ("children" in tree) tree.children.forEach(assertSupported);
}

/** All rich dependencies stay behind PaperNoteRichEditor's dynamic import. */
export async function createPaperNoteEditor(
  host: HTMLElement,
  markdown: string | (() => string),
  onChange: (markdown: string) => void,
) {
  let ready = false;
  let currentMarkdown = "";
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      // Inspect the original AST before Milkdown's HTML/reference transformers.
      ctx.set(defaultValueCtx, "");
      ctx.set(editorViewOptionsCtx, {
        attributes: {
          "aria-label": "编辑论文笔记",
          "aria-multiline": "true",
          spellcheck: "false",
        },
        handleDOMEvents: {
          click(view, event) {
            if (
              !(event.target instanceof HTMLInputElement) ||
              !event.target.hasAttribute("data-note-task")
            )
              return false;
            const pos = view.state.doc.resolve(view.posAtDOM(event.target, 0));
            for (let depth = pos.depth; depth > 0; depth--) {
              const node = pos.node(depth);
              if (node.type.name !== "list_item") continue;
              event.preventDefault();
              view.dispatch(
                view.state.tr.setNodeAttribute(
                  pos.before(depth),
                  "checked",
                  !node.attrs.checked,
                ),
              );
              return true;
            }
            return false;
          },
        },
        dispatchTransaction(this: EditorView, transaction) {
          const previous = this.state.doc;
          const next = this.state.apply(transaction);
          this.updateState(next);
          // Selection, mount, and mode switches must never rewrite raw Markdown.
          // Do this synchronously: the shared autosave is the only debounce.
          if (ready && !previous.eq(next.doc)) {
            currentMarkdown = ctx.get(serializerCtx)(next.doc);
            onChange(currentMarkdown);
          }
        },
      });
    })
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(
      [
        mathPlugin,
        mathNode(false),
        mathNode(true),
        inertLink,
        inertImage,
        taskCheckbox,
      ].flat(),
    );
  await editor.create();
  try {
    const setMarkdown = (value: string) => {
      if (ready && value === currentMarkdown) return;
      assertSupported(editor.ctx.get(remarkCtx).parse(value));
      const view = editor.ctx.get(editorViewCtx);
      const doc = editor.ctx.get(parserCtx)(value);
      if (!view.state.doc.eq(doc)) {
        // An external replacement is a new undo baseline. Never let undo restore
        // an obsolete draft over another editor's changes. Local typing skips this.
        const selection = Selection.near(
          doc.resolve(Math.min(view.state.selection.head, doc.content.size)),
        );
        const wasReady = ready;
        ready = false;
        try {
          view.updateState(
            EditorState.create({
              doc,
              selection,
              schema: view.state.schema,
              plugins: view.state.plugins,
            }),
          );
        } finally {
          ready = wasReady;
        }
      }
      currentMarkdown = value;
    };
    setMarkdown(typeof markdown === "function" ? markdown() : markdown);
    ready = true;
    return Object.assign(editor, { setMarkdown });
  } catch (error) {
    await editor.destroy();
    throw error;
  }
}
