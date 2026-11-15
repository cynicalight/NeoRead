import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Minus,
  Plus,
  Search,
} from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { api, paperAttachmentSource } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import {
  attachmentPreviewKind,
  downloadAttachment,
  useAttachments,
} from "./attachments";
import { toast } from "sonner";
import { SearchInput } from "../SearchInput";
pdfjs.GlobalWorkerOptions.workerSrc = workerURL;

export default function AttachmentPreview() {
  const preview = useAttachments((s) => s.preview);
  return (
    <Dialog
      open={!!preview}
      onOpenChange={(open) => {
        if (!open) useAttachments.setState({ preview: null });
      }}
    >
      <DialogContent
        className="attachment-preview-dialog flex h-[90vh] min-h-0 min-w-0 flex-col sm:max-w-5xl"
        aria-describedby="attachment-preview-parent"
      >
        <DialogHeader className="min-w-0 pr-7">
          <DialogTitle className="truncate">{preview?.item.title}</DialogTitle>
          <DialogDescription
            id="attachment-preview-parent"
            className="truncate"
          >
            {preview?.doc.title}
          </DialogDescription>
        </DialogHeader>
        {preview && <PreviewContent key={preview.item.id} />}
      </DialogContent>
    </Dialog>
  );
}

function PreviewContent() {
  const preview = useAttachments((s) => s.preview)!;
  const host = useRef<HTMLDivElement>(null);
  const pdf = useRef<{ viewer: PDFViewer; bus: EventBus } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [image, setImage] = useState("");
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState("");
  const [downloading, setDownloading] = useState(false);
  const kind = attachmentPreviewKind(preview.item);
  useEffect(() => {
    let disposed = false;
    let objectURL = "";
    let task: pdfjs.PDFDocumentLoadingTask | undefined;
    let viewer: PDFViewer | undefined;
    let resize: ResizeObserver | undefined;
    const controller = new AbortController();
    const load = async () => {
      try {
        if (kind === "image") {
          const blob = await api.downloadPaperAttachment(
            preview.doc.id,
            preview.item.id,
            controller.signal,
          );
          if (disposed) return;
          const type = /\.png$/i.test(preview.item.filename)
            ? "image/png"
            : /\.jpe?g$/i.test(preview.item.filename)
              ? "image/jpeg"
              : /\.webp$/i.test(preview.item.filename)
                ? "image/webp"
                : /\.gif$/i.test(preview.item.filename)
                  ? "image/gif"
                  : "image/bmp";
          objectURL = URL.createObjectURL(new Blob([blob], { type }));
          setImage(objectURL);
          setLoading(false);
          return;
        }
        const container = host.current!;
        const surface = document.createElement("div");
        surface.className = "pdfViewer";
        container.append(surface);
        const bus = new EventBus();
        // Attachment previews do not execute PDF actions or submit forms.
        const links = new PDFLinkService({
          eventBus: bus,
        });
        const find = new PDFFindController({
          eventBus: bus,
          linkService: links,
        });
        viewer = new PDFViewer({
          container,
          viewer: surface,
          eventBus: bus,
          linkService: links,
          findController: find,
          annotationMode: pdfjs.AnnotationMode.DISABLE,
          textLayerMode: 1,
          maxCanvasPixels: 4 * 1024 * 1024,
          maxCanvasDim: 4096,
          removePageBorders: true,
        });
        links.externalLinkEnabled = false;
        links.setViewer(viewer);
        task = pdfjs.getDocument({
          ...paperAttachmentSource(preview.doc.id, preview.item.id),
          // Request only needed ranges; disabling streaming is necessary for
          // PDF.js to honor disableAutoFetch rather than consume the full file.
          disableStream: true,
          disableAutoFetch: true,
          rangeChunkSize: 1 << 20,
          cMapUrl: "/pdf-assets/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdf-assets/standard_fonts/",
          wasmUrl: "/pdf-assets/wasm/",
        });
        const pdfDocument = await task.promise;
        if (disposed) return;
        pdf.current = { viewer, bus };
        bus.on("pagesinit", () => {
          if (!disposed) {
            viewer!.currentScaleValue = "page-width";
            setPages(pdfDocument.numPages);
            setLoading(false);
          }
        });
        bus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
          if (!disposed) setPage(pageNumber);
        });
        bus.on(
          "updatefindmatchescount",
          ({
            matchesCount,
          }: {
            matchesCount: { current: number; total: number };
          }) => {
            if (!disposed)
              setMatches(`${matchesCount.current}/${matchesCount.total}`);
          },
        );
        bus.on("updatefindcontrolstate", ({ state }: { state: number }) => {
          if (!disposed && state === 1) setMatches("未找到");
        });
        viewer.setDocument(pdfDocument);
        links.setDocument(pdfDocument);
        find.setDocument(pdfDocument);
        resize = new ResizeObserver(() => {
          if (!disposed && viewer?.pagesCount) viewer.update();
        });
        resize.observe(container);
      } catch (e) {
        if (!disposed) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
      resize?.disconnect();
      pdf.current = null;
      viewer?.setDocument(null as unknown as pdfjs.PDFDocumentProxy);
      void task?.destroy();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [preview.doc.id, preview.item.id, kind]);
  const search = (backward = false, again = false) => {
    setMatches("");
    pdf.current?.bus.dispatch("find", {
      source: null,
      type: again ? "again" : "",
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: backward,
      matchDiacritics: false,
    });
  };
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadAttachment(preview.item);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <>
      <div
        className="flex flex-wrap items-center gap-1"
        role="toolbar"
        aria-label="附件预览操作"
      >
        {kind === "pdf" && (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="上一页"
              disabled={page <= 1 || loading}
              onClick={() => {
                if (pdf.current)
                  pdf.current.viewer.currentPageNumber = page - 1;
              }}
            >
              <ChevronLeft />
            </Button>
            <span className="min-w-16 text-center text-xs tabular-nums">
              {page} / {pages || "—"}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="下一页"
              disabled={page >= pages || loading}
              onClick={() => {
                if (pdf.current)
                  pdf.current.viewer.currentPageNumber = page + 1;
              }}
            >
              <ChevronRight />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="缩小附件"
              disabled={loading}
              onClick={() => {
                if (pdf.current)
                  pdf.current.viewer.currentScale = Math.max(
                    0.25,
                    pdf.current.viewer.currentScale / 1.2,
                  );
              }}
            >
              <Minus />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="放大附件"
              disabled={loading}
              onClick={() => {
                if (pdf.current)
                  pdf.current.viewer.currentScale = Math.min(
                    4,
                    pdf.current.viewer.currentScale * 1.2,
                  );
              }}
            >
              <Plus />
            </Button>
            <form
              className="flex min-w-0 flex-1 items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                search(false, true);
              }}
            >
              <SearchInput
                wrapperClassName="min-w-20 max-w-48 flex-1"
                className="h-7 text-xs"
                aria-label="搜索附件正文"
                placeholder="搜索附件"
                value={query}
                disabled={loading}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setMatches("");
                }}
                onClear={() => {
                  setQuery("");
                  setMatches("");
                }}
              />
              <Button
                type="submit"
                size="icon-xs"
                variant="ghost"
                aria-label="查找附件内容"
                disabled={!query.trim() || loading}
              >
                <Search />
              </Button>
              <span className="text-xs text-muted-foreground" role="status">
                {matches}
              </span>
            </form>
          </>
        )}
        <Button
          className="ml-auto"
          size="sm"
          variant="outline"
          disabled={downloading}
          onClick={() => void download()}
        >
          <Download />
          {downloading ? "下载中…" : "下载"}
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border bg-muted/30">
        {loading && (
          <p
            className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            正在读取附件…
          </p>
        )}
        {error && (
          <p className="p-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {kind === "pdf" ? (
          <div
            ref={host}
            className="attachment-pdf-container absolute inset-0 overflow-auto"
          />
        ) : (
          image && (
            <img
              className="absolute inset-0 h-full w-full object-contain"
              src={image}
              alt={preview.item.title}
              onError={() => setError("无法预览这张图片，可下载后查看")}
            />
          )
        )}
      </div>
    </>
  );
}
