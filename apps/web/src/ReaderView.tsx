import { useEffect, useRef, useState } from "react";
import type {
  Annotation,
  PDFBlock,
  Document,
  ReaderAdapter,
  ReaderEvents,
  ReaderTheme,
  TOCItem,
} from "@reader/core";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
export function ReaderView({
  document: doc,
  theme,
  annotations,
  blocks = [],
  onReady,
  events,
}: {
  document: Document;
  theme: ReaderTheme;
  annotations: Annotation[];
  blocks?: PDFBlock[];
  onReady: (adapter: ReaderAdapter, toc: TOCItem[]) => void;
  events: ReaderEvents;
}) {
  const host = useRef<HTMLDivElement>(null);
  const adapter = useRef<ReaderAdapter | null>(null);
  const latest = useRef({ theme, annotations, blocks, events, onReady });
  latest.current = { theme, annotations, blocks, events, onReady };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const container = document.createElement("div");
    container.className = "reader-engine";
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
          if (!disposed) latest.current.events.epubInteraction?.();
        },
        epubReadingAnchor: (id) => {
          if (!disposed) latest.current.events.epubReadingAnchor?.(id);
        },
        readingAnchor: (anchor) => {
          if (!disposed) latest.current.events.readingAnchor?.(anchor);
        },
        blockFocus: (block) => {
          if (!disposed) latest.current.events.blockFocus?.(block);
        },
        annotationHover: (target) => {
          if (!disposed) latest.current.events.annotationHover?.(target);
        },
        annotation: (target) => {
          if (!disposed) latest.current.events.annotation?.(target);
        },
        zoom: (zoom) => {
          if (!disposed) latest.current.events.zoom?.(zoom);
        },
        blockHover: (block) => {
          if (!disposed) latest.current.events.blockHover?.(block);
        },
        blockAction: (block, action) => {
          if (!disposed) latest.current.events.blockAction?.(block, action);
        },
        location: (...args) => {
          if (!disposed) latest.current.events.location(...args);
        },
        selection: (selection) => {
          if (!disposed) latest.current.events.selection(selection);
        },
        linkPreview: (preview) => {
          if (!disposed) latest.current.events.linkPreview?.(preview);
        },
        internalLink: (origin) => {
          if (!disposed) latest.current.events.internalLink?.(origin);
        },
      });
      engine.preferTheme?.(latest.current.theme);
      await engine.open(doc);
      if (disposed) return;
      await engine.setTheme(latest.current.theme);
      await engine.highlight(latest.current.annotations).catch((e) => {
        if (!disposed) toast.error(e.message);
      });
      engine.setBlocks?.(latest.current.blocks);
      const toc = await engine.getTOC();
      if (disposed) return;
      adapter.current = engine;
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
      void pending
        .finally(async () => {
          await engine?.destroy();
          container.remove();
        })
        .catch(() => {});
    };
  }, [doc.id]);
  useEffect(() => {
    void adapter.current?.setTheme(theme).catch((e) => toast.error(e.message));
  }, [theme]);
  useEffect(() => {
    void adapter.current
      ?.highlight(annotations)
      .catch((e) => toast.error(e.message));
  }, [annotations]);
  useEffect(() => {
    adapter.current?.setBlocks?.(blocks);
  }, [blocks]);
  return (
    <div
      className="reader-stage"
      data-theme={theme.mode}
      data-dark-contrast={theme.pdfDarkContrast ?? "soft"}
    >
      <div className="reader-host" ref={host} />
      {loading && (
        <div className="reader-loading">
          <Loader2 className="animate-spin" />
          <p>正在排版，准备阅读…</p>
        </div>
      )}
      {error && (
        <div className="reader-loading">
          <h3>这份文档暂时无法打开</h3>
          <p className="max-w-md text-center text-sm text-muted-foreground">
            {error}
          </p>
        </div>
      )}
    </div>
  );
}
