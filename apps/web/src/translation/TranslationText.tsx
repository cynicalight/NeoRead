import { FormulaRow } from "./FormulaRow";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
import { blockImageURL } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { reflowSourceParts } from "./reflow";
import {
  citationHref,
  readingLinkTokens,
  ReadingLinkNavigation,
} from "../reading-links";
import { ErrorBoundary } from "../ErrorBoundary";
const FormulaFragment = lazy(() => import("./FormulaFragment"));
const Markdown = lazy(() =>
  import("../chat/MessageMarkdown").then((module) => ({
    default: module.MessageMarkdown,
  })),
);
function MessageMarkdown({
  content,
  blockId,
  onCitation,
}: {
  content: string;
  blockId?: string;
  onCitation?: (blockId: string, label: string) => void;
}) {
  return (
    <Suspense fallback={<span>{content}</span>}>
      <ReadingLinkNavigation.Provider value={onCitation}>
        <Markdown
          content={content}
          citationBlockId={onCitation ? blockId : undefined}
        />
      </ReadingLinkNavigation.Provider>
    </Suspense>
  );
}

/**
 * Layout crops are rasterized with the whole page, so figures look soft once
 * shown at full width. After the lazy crop loads, a vector render at the
 * displayed device-pixel width replaces it without changing the layout.
 */
function BlockImage({
  src,
  alt,
  render,
}: {
  src: string;
  alt: string;
  render?: (width: number) => Promise<string>;
}) {
  const [sharp, setSharp] = useState<{ url: string; width: number }>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <img
      className="translation-image"
      src={sharp?.url ?? src}
      width={sharp?.width}
      alt={alt}
      loading="lazy"
      onLoad={(event) => {
        if (sharp || !render) return;
        const image = event.currentTarget;
        const width = image.naturalWidth;
        const pixels = Math.min(width, image.clientWidth || width);
        render(Math.ceil(pixels * (window.devicePixelRatio || 1)))
          .then((url) => {
            if (mounted.current) setSharp({ url, width });
          })
          .catch(() => {});
      }}
    />
  );
}

export function TranslationText(props: TranslationTextProps) {
  return (
    <ErrorBoundary
      resetKey={props.translation}
      fallback={<p className="translation-warning">此段无法显示</p>}
    >
      <TranslationContent {...props} />
    </ErrorBoundary>
  );
}
type TranslationTextProps = Parameters<typeof TranslationContent>[0];
type DisplayBlock = Pick<
  PDFBlock,
  "id" | "label" | "text" | "image" | "caption"
> &
  Partial<PDFBlock>;
const preservedLabels = [
  "reference",
  "reference_content",
  "display_formula",
  "inline_formula",
  "formula_number",
  "header",
  "footer",
  "number",
];
/**
 * Formulas, references and similar blocks already show their original
 * content in place of a translation; reflowed text must not repeat them.
 */
export function showsOriginal(block: DisplayBlock) {
  const asset =
    !!block.image ||
    ["algorithm", "table", "chart", "image"].includes(block.label);
  return (
    ["display_formula", "inline_formula"].includes(block.label) ||
    preservedLabels.includes(block.label) ||
    (asset && !block.caption)
  );
}

// Extracted PDF text carries inline math as Markdown; other text stays plain.
const markdownSource = /\$|\\\(|\\\[/;
// One shown sentence: Markdown when it carries math, else text with links.
function sourceText(
  text: string,
  blockId: string,
  onCitation?: (blockId: string, label: string) => void,
): ReactNode {
  if (markdownSource.test(text))
    return (
      <MessageMarkdown
        content={text}
        blockId={blockId}
        onCitation={onCitation}
      />
    );
  if (!onCitation) return text;
  return readingLinkTokens(text).map((token, k) =>
    token.label ? (
      <a
        key={k}
        href={citationHref(blockId, token.label)}
        onClick={(event) => {
          event.preventDefault();
          onCitation(blockId, token.label!);
        }}
      >
        {token.text}
      </a>
    ) : (
      token.text
    ),
  );
}
/** A reflowed source paragraph whose sentences hover with their translation. */
export function ReflowSource({
  block,
  translation,
  onCitation,
}: {
  block: DisplayBlock;
  translation?: TranslationBlock;
  /** Citation and figure links preview on hover and jump on click. */
  onCitation?: (blockId: string, label: string) => void;
}) {
  const text = block.image ? block.caption || block.text : block.text;
  if (!text.trim()) return null;
  return (
    <div className="reflow-source" data-reflow-source={block.id}>
      {reflowSourceParts(text, translation).map(
        ({ text: part, display }, i) => (
          <span
            key={i}
            className="reflow-sentence"
            data-source-sentence={i}
            data-anchor={display ? part : undefined}
          >
            {sourceText(display ?? part, block.id, onCitation)}
          </span>
        ),
      )}
    </div>
  );
}

function TranslationContent({
  block,
  translation,
  documentId,
  retry,
  paused = false,
  linked = [],
  formulaNumber,
  onCitation,
  imageURL,
  renderImage,
  imageTheme,
  source,
  showTranslation = true,
  markTranslation = false,
}: {
  // PDF blocks and EPUB paragraphs share these fields.
  block: DisplayBlock;
  translation?: TranslationBlock;
  documentId: string;
  /** Requests this block; also used for blocks that were never requested. */
  retry: () => void;
  paused?: boolean;
  linked?: number[];
  formulaNumber?: string;
  onCitation?: (blockId: string, label: string) => void;
  /** EPUB images come from the publication rather than the PDF asset store. */
  imageURL?: string;
  /** Replaces the low-resolution layout crop with a render sized for display. */
  renderImage?: (blockId: string, width: number) => Promise<string>;
  imageTheme?: string;
  /** Reflowed source text, shown between the image and the translation. */
  source?: ReactNode;
  /** Reflowed source-only reading hides the translation of text blocks. */
  showTranslation?: boolean;
  /**
   * Marks only the translated sentences as the translation block, so
   * selection offsets exclude reflowed source text in the same paragraph.
   */
  markTranslation?: boolean;
}) {
  const formula = ["display_formula", "inline_formula"].includes(block.label);
  const idle = translation?.status === "idle";
  const halted = paused && translation?.status === "pending";
  const asset =
    !!block.image ||
    ["algorithm", "table", "chart", "image"].includes(block.label);
  const image = block.image ? (
    <BlockImage
      key={`${block.id}:${block.image}:${imageTheme ?? ""}`}
      src={imageURL ?? blockImageURL(documentId, block.id, block.image)}
      alt={block.caption || block.text || block.label}
      render={
        imageURL || !renderImage
          ? undefined
          : (width) => renderImage(block.id, width)
      }
    />
  ) : null;
  const formulaFallback = image || <MessageMarkdown content={block.text} />;
  if (
    formula &&
    translation?.status === "complete" &&
    translation.formulaMarkdown
  ) {
    return (
      <Suspense
        fallback={
          <FormulaRow number={formulaNumber}>{formulaFallback}</FormulaRow>
        }
      >
        <FormulaFragment
          content={translation.formulaMarkdown}
          fallback={formulaFallback}
          number={formulaNumber}
        />
      </Suspense>
    );
  }
  if (formula)
    return (
      <div>
        <FormulaRow number={formulaNumber}>{formulaFallback}</FormulaRow>
        {block.image && (
          <div className="translation-formula-status" role="status">
            {translation?.status === "failed" ? (
              <>
                <span>{translation.error || "公式转换失败"}</span>
                <Button variant="ghost" size="sm" onClick={retry}>
                  重试公式
                </Button>
              </>
            ) : idle ? (
              <Button variant="ghost" size="sm" onClick={retry}>
                转换公式
              </Button>
            ) : (
              <span>{halted ? "翻译已暂停" : "公式转换中…"}</span>
            )}
          </div>
        )}
      </div>
    );
  const preserve =
    preservedLabels.includes(block.label) || (asset && !block.caption);
  return (
    <>
      {image}
      {!preserve && source}
      {!preserve && !showTranslation ? null : preserve ? (
        !asset && (
          <MessageMarkdown
            content={block.text}
            blockId={block.id}
            onCitation={onCitation}
          />
        )
      ) : translation?.status === "complete" ? (
        <div
          className="translation-sentences"
          data-translation-block={markTranslation ? block.id : undefined}
        >
          {translation.sentences.map((sentence, i) => (
            <div
              key={i}
              className="translation-sentence"
              data-sentence={i}
              data-linked={linked.includes(i) || undefined}
            >
              <MessageMarkdown
                content={sentence.target}
                blockId={block.id}
                onCitation={onCitation}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="translation-pending" role="status">
          <span>
            {translation?.status === "failed"
              ? translation.error || "此段翻译失败"
              : idle
                ? "未翻译"
                : halted
                  ? "翻译已暂停"
                  : "正在翻译中…"}
          </span>
          {(translation?.status === "failed" || idle) && (
            <Button variant="ghost" size="sm" onClick={retry}>
              {idle ? "翻译此段" : "重试此段"}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
