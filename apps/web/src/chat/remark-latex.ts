import type { Plugin } from "unified";
import type { Extension, State, Tokenizer } from "micromark-util-types";
import type {
  Extension as MarkdownExtension,
  Handle,
} from "mdast-util-from-markdown";

declare module "unified" {
  interface Data {
    micromarkExtensions?: Extension[];
    fromMarkdownExtensions?: (MarkdownExtension | MarkdownExtension[])[];
  }
}

declare module "micromark-util-types" {
  interface TokenTypeMap {
    readerLatex: "readerLatex";
    readerLatexFlow: "readerLatexFlow";
    readerLatexData: "readerLatexData";
  }
}

// Parse delimiters before Markdown consumes backslash escapes. Code spans,
// fences, link destinations and escaped backslashes retain their normal rules.
function latexTokenizer(block: boolean): Tokenizer {
  return function (effects, ok, nok) {
    const type = block ? "readerLatexFlow" : "readerLatex";
    let closing = 0;
    let inData = true;
    const start: State = (code) => {
      effects.enter(type);
      effects.enter("readerLatexData");
      effects.consume(code);
      return opening;
    };
    const opening: State = (code) => {
      if (code !== 91 && (block || code !== 40)) return nok(code);
      closing = code === 40 ? 41 : 93;
      effects.consume(code);
      return content;
    };
    const content: State = (code) => {
      if (code === null) return nok(code);
      if (code === -5 || code === -4 || code === -3) {
        if (inData) effects.exit("readerLatexData");
        inData = false;
        effects.enter("lineEnding");
        effects.consume(code);
        effects.exit("lineEnding");
        return content;
      }
      if (!inData) {
        effects.enter("readerLatexData");
        inData = true;
      }
      effects.consume(code);
      return code === 92 ? close : content;
    };
    const close: State = (code) => {
      if (code === closing) {
        effects.consume(code);
        if (block) return trailing;
        effects.exit("readerLatexData");
        effects.exit(type);
        return ok;
      }
      // A pair of backslashes belongs to the formula (e.g. a matrix row).
      if (code === 92) {
        effects.consume(code);
        return content;
      }
      return content(code);
    };
    const trailing: State = (code) => {
      if (code === null || code === -5 || code === -4 || code === -3) {
        effects.exit("readerLatexData");
        effects.exit(type);
        return ok(code);
      }
      if (code === 32 || code === -2 || code === -1) {
        effects.consume(code);
        return trailing;
      }
      return nok(code);
    };
    return start;
  };
}

const syntax: Extension = {
  flow: { 92: { tokenize: latexTokenizer(true), concrete: true } },
  text: { 92: { tokenize: latexTokenizer(false) } },
};
const enterLatex: Handle = function (token) {
  const raw = this.sliceSerialize(token).trimEnd();
  const value = raw.slice(2, -2).trim();
  const display = raw[1] === "[";
  if (token.type === "readerLatexFlow") {
    this.enter(
      {
        type: "math",
        meta: null,
        value,
        data: {
          hName: "pre",
          hChildren: [
            {
              type: "element",
              tagName: "code",
              properties: { className: ["language-math", "math-display"] },
              children: [{ type: "text", value }],
            },
          ],
        },
      },
      token,
    );
  } else {
    this.enter(
      {
        type: "inlineMath",
        value,
        data: {
          hName: "code",
          hProperties: {
            className: [
              "language-math",
              display ? "math-display" : "math-inline",
            ],
          },
          hChildren: [{ type: "text", value }],
        },
      },
      token,
    );
  }
  this.buffer();
};
const exitLatex: Handle = function (token) {
  this.resume();
  this.exit(token);
};
const markdown: MarkdownExtension = {
  enter: { readerLatex: enterLatex, readerLatexFlow: enterLatex },
  exit: { readerLatex: exitLatex, readerLatexFlow: exitLatex },
};

export const remarkLatex: Plugin = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(markdown);
};
