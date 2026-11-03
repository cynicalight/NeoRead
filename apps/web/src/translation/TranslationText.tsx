import { FormulaRow } from "./FormulaRow";
import type { PDFBlock, TranslationBlock } from "@neoread/core";
import { blockImageURL } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ReadingLinkNavigation } from "../reading-links";
import { ErrorBoundary } from "../ErrorBoundary";
import { Expand } from "lucide-react";
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
  release,
  scale = 1,
}: {
  src: string;
  alt: string;
  render?: (width: number) => Promise<string>;
  release?: () => void;
  scale?: number;
}) {
  const [sharp, setSharp] = useState<{
    url: string;
    width: number;
    pixels: number;
  }>();
  const imageRef = useRef<HTMLImageElement>(null);
  const visible = useRef(typeof IntersectionObserver === "undefined");
  const originalWidth = useRef<number | undefined>(undefined);
  const originalHeight = useRef<number | undefined>(undefined);
  const generation = useRef(0);
  const releaseRef = useRef(release);
  releaseRef.current = release;
  const requested = useRef(0);
  const sharpen = (image: HTMLImageElement) => {
    if (!visible.current || !render || !image.naturalWidth) return;
    originalWidth.current ??= image.naturalWidth;
    if (image.naturalHeight) originalHeight.current ??= image.naturalHeight;
    const width = originalWidth.current;
    const pixels = Math.ceil(
      Math.min(width, image.clientWidth || width) *
        scale *
        (window.devicePixelRatio || 1),
    );
    if (pixels <= requested.current) return;
    requested.current = pixels;
    const version = generation.current;
    render(pixels)
      .then((url) => {
        if (mounted.current && generation.current === version)
          setSharp((previous) =>
            previous && previous.pixels > pixels
              ? previous
              : { url, width, pixels },
          );
      })
      .catch(() => {
        if (generation.current === version && requested.current === pixels)
          requested.current = 0;
      });
  };
  const mounted = useRef(false);
  const update = useRef(sharpen);
  update.current = sharpen;
  useEffect(() => {
    mounted.current = true;
    let retirement: ReturnType<typeof setTimeout> | undefined;
    const root = imageRef.current?.closest(".translation-document") ?? null;
    let visibility: IntersectionObserver | undefined;
    let preRenderHeight = -1;
    const observeVisibility = () => {
      if (typeof IntersectionObserver === "undefined") return;
      const height = root?.clientHeight ?? window.innerHeight;
      if (height === preRenderHeight) return;
      preRenderHeight = height;
      visibility?.disconnect();
      visibility = new IntersectionObserver(
        ([entry], observed) => {
          if (!mounted.current || observed !== visibility) return;
          const wasVisible = visible.current;
          visible.current = entry.isIntersecting;
          clearTimeout(retirement);
          const image = imageRef.current;
          if (entry.isIntersecting && image) image.loading = "eager";
          if (entry.isIntersecting && image?.complete) update.current(image);
          else if (wasVisible && !entry.isIntersecting) {
            // Keep decoded pixels during brief boundary crossings.
            retirement = setTimeout(() => {
              generation.current++;
              requested.current = 0;
              setSharp(undefined);
              releaseRef.current?.();
            }, 800);
          }
        },
        {
          root,
          rootMargin: `${height}px 0px`,
        },
      );
      if (imageRef.current) visibility.observe(imageRef.current);
    };
    const observer = new ResizeObserver(() => {
      observeVisibility();
      const image = imageRef.current;
      if (!image?.complete) return;
      if (visible.current) update.current(image);
    });
    if (imageRef.current) observer.observe(imageRef.current);
    observer.observe(root ?? document.documentElement);
    observeVisibility();
    return () => {
      mounted.current = false;
      clearTimeout(retirement);
      observer.disconnect();
      visibility?.disconnect();
      generation.current++;
      releaseRef.current?.();
    };
  }, []);
  useEffect(() => {
    const image = imageRef.current;
    if (!image?.complete) return;
    sharpen(image);
  }, [scale]);
  return (
    <img
      className="translation-image"
      ref={imageRef}
      src={sharp?.url ?? src}
      width={originalWidth.current}
      style={{
        aspectRatio:
          originalWidth.current && originalHeight.current
            ? `${originalWidth.current} / ${originalHeight.current}`
            : undefined,
      }}
      alt={alt}
      loading="lazy"
      onLoad={(event) => {
        sharpen(event.currentTarget);
      }}
    />
  );
}

export function TranslationText(props: TranslationTextProps) {
  const latest = useRef(props);
  latest.current = props;
  // Progress and hover updates recreate the caller's handlers. Keep the heavy
  // Markdown/formula subtree cached while dispatching to the latest callbacks.
  const actions = useMemo(
    () => ({
      retry: () => latest.current.retry(),
      onPreview: () => latest.current.onPreview?.(),
      onCitation: (id: string, label: string) =>
        latest.current.onCitation?.(id, label),
    }),
    [],
  );
  return (
    <TranslationBody
      {...props}
      retry={actions.retry}
      onPreview={props.onPreview ? actions.onPreview : undefined}
      onCitation={props.onCitation ? actions.onCitation : undefined}
    />
  );
}
const TranslationBody = memo(function TranslationBody(
  props: TranslationTextProps,
) {
  return (
    <ErrorBoundary
      resetKey={props.translation}
      fallback={<p className="translation-warning">此段无法显示</p>}
    >
      <TranslationContent {...props} />
    </ErrorBoundary>
  );
});
type TranslationTextProps = Parameters<typeof TranslationContent>[0];
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
  releaseImage,
  onPreview,
  imageScale,
}: {
  // PDF blocks and EPUB paragraphs share these fields.
  block: Pick<PDFBlock, "id" | "label" | "text" | "image" | "caption"> &
    Partial<PDFBlock>;
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
  renderImage?: (
    blockId: string,
    width: number,
    owner?: string,
  ) => Promise<string>;
  releaseImage?: (blockId: string, owner?: string) => void;
  onPreview?: () => void;
  imageScale?: number;
}) {
  const imageOwner = useId();
  const formula = ["display_formula", "inline_formula"].includes(block.label);
  const idle = translation?.status === "idle";
  const halted = paused && translation?.status === "pending";
  const asset =
    !!block.image ||
    ["algorithm", "table", "chart", "image"].includes(block.label);
  const crop = block.image ? (
    <BlockImage
      key={`${block.id}:${block.image}`}
      src={imageURL ?? blockImageURL(documentId, block.id, block.image)}
      alt={block.caption || block.text || block.label}
      scale={imageScale}
      render={
        imageURL || !renderImage
          ? undefined
          : (width) => renderImage(block.id, width, imageOwner)
      }
      release={
        releaseImage ? () => releaseImage(block.id, imageOwner) : undefined
      }
    />
  ) : null;
  const image = block.image ? (
    <div className="translation-image-container">
      {onPreview ? (
        <Button
          variant="ghost"
          className="translation-image-open"
          aria-label="双击放大查看图片"
          title="双击放大查看图片"
          onClick={(event) => {
            if (event.detail !== 0) return;
            event.stopPropagation();
            onPreview();
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onPreview();
          }}
        >
          {crop}
        </Button>
      ) : (
        crop
      )}
      {onPreview && (
        <Button
          variant="secondary"
          size="icon-sm"
          className="translation-image-preview"
          aria-label="放大查看原图"
          title="放大查看原图"
          onClick={(event) => {
            event.stopPropagation();
            onPreview();
          }}
        >
          <Expand />
        </Button>
      )}
    </div>
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
    [
      "reference",
      "reference_content",
      "display_formula",
      "inline_formula",
      "formula_number",
      "header",
      "footer",
      "number",
    ].includes(block.label) ||
    (asset && !block.caption);
  return (
    <>
      {image}
      {preserve ? (
        !asset && (
          <MessageMarkdown
            content={block.text}
            blockId={block.id}
            onCitation={onCitation}
          />
        )
      ) : translation?.status === "complete" ? (
        <div className="translation-sentences">
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
