import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  Annotation,
  PDFBlock,
  Document,
  Processing,
  ReaderAdapter,
  ReaderEvents,
  ReaderTheme,
  TOCItem,
} from "@neoread/core";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { PDFOCRPreview } from "./readers/pdf-ocr-preview";

const noBlocks: PDFBlock[] = [];

export function ReaderView({
  document: doc,
  active = true,
  theme,
  annotations,
  blocks = noBlocks,
  blocksRevision,
  processing,
  onReady,
  events,
}: {
  document: Document;
  active?: boolean;
  theme: ReaderTheme;
  annotations: Annotation[];
  blocks?: PDFBlock[];
  blocksRevision?: string;
  processing?: Processing;
  onReady: (adapter: ReaderAdapter, toc: TOCItem[]) => void;
  events: ReaderEvents;
}) {
  const host = useRef<HTMLDivElement>(null);
  const adapter = useRef<ReaderAdapter | null>(null);
  const preview = useRef<PDFOCRPreview | undefined>(undefined);
  const latest = useRef({
    theme,
    annotations,
    blocks,
    blocksRevision,
    processing,
    events,
    onReady,
    active,
  });
  latest.current = {
    theme,
    annotations,
    blocks,
    blocksRevision,
    processing,
    events,
    onReady,
    active,
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    let disposed = false;
    const container = document.createElement("div");
    container.className = "neoread-engine";
    host.current!.append(container);
    let engine: ReaderAdapter | undefined;
    const setup = async () => {
      const { PDFReaderAdapter } =
        doc.type === "pdf"
          ? await import("./readers/pdf")
          : { PDFReaderAdapter: undefined };
      const { EPUBReaderAdapter } =
        doc.type === "epub"
          ? await import("./readers/epub-web")
          : { EPUBReaderAdapter: undefined };
      if (disposed) return;
      const Engine = PDFReaderAdapter || EPUBReaderAdapter!;
      engine = new Engine(container, {
        epubInteraction: () => {
          if (!disposed && latest.current.active)
            latest.current.events.epubInteraction?.();
        },
        epubBlocksChanged: (blocks) => {
          if (!disposed) latest.current.events.epubBlocksChanged?.(blocks);
        },
        epubReadingAnchor: (id, fraction) => {
          if (!disposed && latest.current.active)
            latest.current.events.epubReadingAnchor?.(id, fraction);
        },
        epubBlockHover: (id) => {
          if (!disposed) latest.current.events.epubBlockHover?.(id);
        },
        epubBlockFocus: (id) => {
          if (!disposed) latest.current.events.epubBlockFocus?.(id);
        },
        epubBlockAction: (block, action) => {
          if (!disposed) latest.current.events.epubBlockAction?.(block, action);
        },
        readingAnchor: (anchor) => {
          if (!disposed && latest.current.active)
            latest.current.events.readingAnchor?.(anchor);
        },
        blockFocus: (block) => {
          if (!disposed && latest.current.active)
            latest.current.events.blockFocus?.(block);
        },
        annotationHover: (target) => {
          if (!disposed && latest.current.active)
            latest.current.events.annotationHover?.(target);
        },
        annotation: (target) => {
          if (!disposed && latest.current.active)
            latest.current.events.annotation?.(target);
        },
        zoom: (zoom, origin, widthRatio) => {
          if (!disposed && latest.current.active) {
            if (origin === "layout")
              latest.current.events.zoom?.(zoom, origin, widthRatio);
            else if (origin) latest.current.events.zoom?.(zoom, origin);
            else latest.current.events.zoom?.(zoom);
          }
        },
        blockHover: (block) => {
          if (!disposed && latest.current.active)
            latest.current.events.blockHover?.(block);
        },
        blockAction: (block, action) => {
          if (!disposed && latest.current.active)
            latest.current.events.blockAction?.(block, action);
        },
        location: (...args) => {
          if (!disposed && latest.current.active)
            latest.current.events.location(...args);
        },
        selection: (selection) => {
          if (!disposed && latest.current.active)
            latest.current.events.selection(selection);
        },
        linkPreview: (preview) => {
          if (!disposed && latest.current.active)
            latest.current.events.linkPreview?.(preview);
        },
        internalLink: (origin) => {
          if (!disposed && latest.current.active)
            latest.current.events.internalLink?.(origin);
        },
      });
      engine.preferTheme?.(latest.current.theme);
      await engine.open(doc);
      if (disposed) return;
      await engine.setTheme(latest.current.theme);
      await engine.highlight(latest.current.annotations).catch((e) => {
        if (!disposed) toast.error(e.message);
      });
      const toc = await engine.getTOC();
      if (disposed) return;
      adapter.current = engine;
      engine.setBlocks?.(latest.current.blocks);
      const applyPreview = engine.setOCRPreview?.bind(engine);
      if (applyPreview) {
        preview.current = new PDFOCRPreview(doc.id, applyPreview);
        preview.current.update(
          latest.current.processing,
          latest.current.blocksRevision,
        );
      }
      latest.current.onReady(engine, toc);
      setLoading(false);
    };
    const pending = setup().catch((e) => {
      if (!disposed) {
        setError(e.message);
        setLoading(false);
      }
    });
    return () => {
      disposed = true;
      adapter.current = null;
      preview.current?.close();
      preview.current = undefined;
      void pending
        .finally(async () => {
          await engine?.destroy();
          container.remove();
        })
        .catch(() => {});
    };
  }, [doc.id]);
  useEffect(() => {
    if (!active) return;
    void adapter.current?.setTheme(theme).catch((e) => toast.error(e.message));
  }, [theme, active]);
  useEffect(() => {
    void adapter.current
      ?.highlight(annotations)
      .catch((e) => toast.error(e.message));
  }, [annotations]);
  useLayoutEffect(() => {
    adapter.current?.setBlocks?.(blocks);
  }, [blocks]);
  useLayoutEffect(() => {
    preview.current?.update(processing, blocksRevision);
  }, [processing, blocksRevision]);
  return (
    <div
      className="neoread-stage"
      data-theme={theme.mode}
      data-dark-contrast={theme.pdfDarkContrast ?? "soft"}
    >
      <div className="neoread-host" ref={host} />
      {loading && (
        <div className="neoread-loading">
          <Loader2 className="animate-spin" />
          <p>正在排版，准备阅读…</p>
        </div>
      )}
      {error && (
        <div className="neoread-loading">
          <h3>这份文档暂时无法打开</h3>
          <p className="max-w-md text-center text-sm text-muted-foreground">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}
