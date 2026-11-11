import { $inputRule, $node, $prose, $remark, $view } from "@milkdown/kit/utils";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import {
  Plugin,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { Fragment, type Node, type NodeType } from "@milkdown/kit/prose/model";
import katex from "katex";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

export interface MathEditRequest {
  anchor: HTMLElement;
  focusTarget: HTMLElement;
  value: string;
  display: boolean;
  update: (value: string) => boolean;
  finish: () => void;
}

function renderMath(node: Node, dom: HTMLElement) {
  dom.dataset.noteMath = node.type.name;
  dom.dataset.value = node.attrs.value;
  dom.classList.add("markdown-math");
  dom.classList.toggle("display", !node.isInline);
  dom.contentEditable = "false";
  // Only KaTeX produces this HTML, with the same safety limits as previews.
  dom.innerHTML = katex.renderToString(node.attrs.value, {
    displayMode: !node.isInline,
    throwOnError: false,
    trust: false,
    strict: "warn",
    maxExpand: 100,
    maxSize: 20,
  });
}

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
      renderMath(node, dom);
      return dom;
    },
    parseMarkdown: {
      match: (node) => node.type === (display ? "math" : "inlineMath"),
      runner: (state, node, type) => state.addNode(type, { value: node.value }),
    },
    toMarkdown: {
      match: (node) => node.type.name === id,
      runner: (state, node) => {
        // Clearing a formula removes its Markdown content, including empty fences.
        if (node.attrs.value.trim())
          state.addNode(
            display ? "math" : "inlineMath",
            undefined,
            node.attrs.value,
          );
      },
    },
  }));
};

const inlineMath = mathNode(false);
const blockMath = mathNode(true);

function insertBlockMath(state: EditorState, type: NodeType, value: string) {
  const { $from } = state.selection;
  const paragraph = state.schema.nodes.paragraph;
  const index = $from.index(-1);
  // List items require a leading paragraph even when the first content is math.
  const leading = $from.node(-1).canReplaceWith(index, index + 1, type)
    ? []
    : [paragraph.create()];
  const node = type.create({ value });
  const pos = $from.before() + (leading[0]?.nodeSize ?? 0);
  const content = Fragment.fromArray([...leading, node, paragraph.create()]);
  if (!$from.node(-1).canReplace(index, index + 1, content)) return null;
  const tr = state.tr.replaceWith($from.before(), $from.after(), content);
  tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize + 1));
  return { tr, pos };
}

// Typed and pasted block formulas both need loose list items. Otherwise the
// HTML break used for an empty paragraph can swallow the following math fence.
export function normalizeMathLists(transaction: Transaction) {
  transaction.doc.descendants((node, pos) => {
    if (node.type.name !== "paper_math_block") return;
    const at = transaction.doc.resolve(pos);
    for (let depth = at.depth; depth > 0; depth--) {
      if (
        at.node(depth).type.name === "list_item" &&
        !at.node(depth).attrs.spread
      )
        transaction.setNodeAttribute(at.before(depth), "spread", true);
    }
  });
}

export function paperNoteMath(onEdit?: (request: MathEditRequest) => void) {
  const views = [inlineMath, blockMath].map((type) =>
    $view(type, () => (initial, view, getPos) => {
      let node = initial;
      let destroyed = false;
      const dom = document.createElement(node.isInline ? "span" : "div");
      renderMath(node, dom);
      dom.tabIndex = 0;
      dom.setAttribute("role", "button");
      dom.setAttribute("aria-label", "编辑公式");
      dom.title = "点击编辑公式";
      const open = () => {
        if (!onEdit || destroyed) return;
        let expected = node.attrs.value;
        onEdit({
          anchor: dom,
          focusTarget: view.dom,
          value: expected,
          display: !node.isInline,
          finish() {
            if (destroyed) return;
            const pos = getPos();
            if (pos === undefined) return;
            const empty = !node.attrs.value.trim();
            const tr = empty
              ? view.state.tr.delete(pos, pos + node.nodeSize)
              : view.state.tr;
            const after = Math.min(
              empty ? pos : pos + node.nodeSize,
              tr.doc.content.size,
            );
            let selection = Selection.near(tr.doc.resolve(after), 1);
            if (!selection.$from.parent.inlineContent) {
              tr.insert(after, view.state.schema.nodes.paragraph.create());
              selection = TextSelection.create(tr.doc, after + 1);
            }
            view.dispatch(tr.setSelection(selection));
          },
          update(value) {
            if (destroyed || node.attrs.value !== expected) return false;
            const pos = getPos();
            if (pos === undefined) return false;
            view.dispatch(
              view.state.tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                value,
              }),
            );
            expected = value;
            return true;
          },
        });
      };
      dom.onclick = (event) => {
        event.preventDefault();
        open();
      };
      dom.onkeydown = (event) => {
        if (
          event.isComposing ||
          event.keyCode === 229 ||
          event.metaKey ||
          event.ctrlKey
        )
          return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          open();
        }
      };
      return {
        dom,
        update(next) {
          if (next.type !== node.type) return false;
          node = next;
          renderMath(node, dom);
          return true;
        },
        stopEvent: (event) => event.type === "click" || event.defaultPrevented,
        ignoreMutation: () => true,
        destroy: () => {
          destroyed = true;
        },
      };
    }),
  );
  const inlineRule = $inputRule(
    (ctx) =>
      new InputRule(
        /(^|[^$])\$((?:\\.|[^\\$\n])+)\$$/,
        (state, match, start, end) => {
          const from = start + match[1].length;
          const before = state.selection.$from.parent.textBetween(
            0,
            from - state.selection.$from.start(),
          );
          if ((before.match(/\\*$/)?.[0].length ?? 0) % 2) return null;
          // Milkdown's custom input-rule runner does not honor inCodeMark.
          if (state.doc.rangeHasMark(from, end, state.schema.marks.inlineCode))
            return null;
          return state.tr.replaceWith(
            from,
            end,
            inlineMath.type(ctx).create({ value: match[2] }),
          );
        },
        { inCodeMark: false },
      ),
  );
  const blockRule = $inputRule(
    (ctx) =>
      new InputRule(
        /^\$\$([^$\n]+)\$\$$/,
        (state, match, start, end) => {
          const { $from } = state.selection;
          if (
            $from.parent.type.name !== "paragraph" ||
            end !== $from.end() ||
            state.doc.rangeHasMark(start, end, state.schema.marks.inlineCode)
          )
            return null;
          return (
            insertBlockMath(state, blockMath.type(ctx), match[1])?.tr ?? null
          );
        },
        { inCodeMark: false },
      ),
  );
  const blockStart = $prose(
    (ctx) =>
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            if (
              event.key !== "Enter" ||
              event.isComposing ||
              event.keyCode === 229 ||
              event.shiftKey ||
              event.metaKey ||
              event.ctrlKey
            )
              return false;
            const { $from, empty } = view.state.selection;
            if (
              !empty ||
              $from.parent.type.name !== "paragraph" ||
              $from.parent.textContent !== "$$" ||
              $from.parentOffset !== 2 ||
              view.state.doc.rangeHasMark(
                $from.start(),
                $from.end(),
                view.state.schema.marks.inlineCode,
              )
            )
              return false;
            const inserted = insertBlockMath(
              view.state,
              blockMath.type(ctx),
              "",
            );
            if (!inserted) return false;
            const { tr, pos } = inserted;
            view.dispatch(tr);
            (view.nodeDOM(pos) as HTMLElement | null)?.click();
            return true;
          },
        },
      }),
  );
  return [
    $remark("paperNoteMath", () => remarkMath),
    inlineMath,
    blockMath,
    ...views,
    inlineRule,
    blockRule,
    blockStart,
  ];
}
