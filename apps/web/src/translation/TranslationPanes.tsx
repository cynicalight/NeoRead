import {
  useId,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowLeftRight, ArrowUpDown, Columns2, Rows2 } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef,
} from "@neoread/ui/components/resizable";
import { useReaderStore } from "../store";
import { readerLayout, updateReaderLayout } from "../neoread-layout";

export function TranslationPanes({
  mode,
  swapped,
  onSwap,
  onResizeStart,
  sourceWidth,
  onSourceWidthChange,
  source,
  translation,
}: {
  mode: "source" | "parallel" | "translation";
  swapped: boolean;
  onSwap: () => void;
  onResizeStart?: () => void;
  sourceWidth: number;
  onSourceWidthChange: (width: number) => void;
  source: ReactNode;
  translation: ReactNode;
}) {
  const id = useId();
  const sourcePanel = usePanelRef();
  const rememberedWidth = useRef(sourceWidth);
  rememberedWidth.current = sourceWidth;
  // Written directly on layout changes: a React render per drag frame is wasted.
  const controls = useRef<HTMLDivElement>(null);
  const dividerAt = useRef(50);
  const panes = useRef<HTMLDivElement>(null);
  // While dragging, offscreen translation sections skip relayout (translation.css).
  // Not `data-resizing`: `body[data-resizing] *` makes that attribute restyle
  // every descendant wherever it changes.
  const markResizing = () => {
    const node = panes.current;
    if (!node || node.hasAttribute("data-divider-drag")) return;
    node.setAttribute("data-divider-drag", "");
    const end = () => {
      node.removeAttribute("data-divider-drag");
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", end);
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", end);
  };
  const stacked = useReaderStore(
    (state) => readerLayout(state.theme.readerLayout).stacked,
  );
  const parallel = mode === "parallel";
  const sourceId = `${id}-${swapped ? "right" : "left"}`;

  useLayoutEffect(() => {
    sourcePanel.current?.resize(
      `${mode === "source" ? 100 : mode === "translation" ? 0 : rememberedWidth.current}%`,
    );
  }, [mode, swapped, stacked, sourcePanel]);

  // Keep DOM order stable: reinserting a panel resets descendant scroll positions.
  // CSS order swaps sides; positional IDs refresh the resize library's ordering.
  const panels = [
    <ResizablePanel
      key="source"
      id={sourceId}
      panelRef={sourcePanel}
      defaultSize={`${mode === "source" ? 100 : mode === "translation" ? 0 : sourceWidth}%`}
      minSize={parallel ? "20%" : "0%"}
      className="translation-pane-content"
      style={{ overflow: "hidden" }}
      inert={mode === "translation"}
    >
      {source}
    </ResizablePanel>,
    <ResizableHandle
      key="divider"
      className="translation-divider"
      disabled={!parallel}
      hidden={!parallel}
      aria-label={stacked ? "调整原文和译文高度" : "调整原文和译文宽度"}
    />,
    <ResizablePanel
      key="translation"
      id={`${id}-${swapped ? "left" : "right"}`}
      defaultSize={`${mode === "source" ? 0 : mode === "translation" ? 100 : 100 - sourceWidth}%`}
      minSize={parallel ? "20%" : "0%"}
      className="translation-pane-content"
      style={{ overflow: "hidden" }}
      inert={mode === "source"}
    >
      {translation}
    </ResizablePanel>,
  ];

  return (
    <div
      ref={panes}
      className="translation-panes"
      data-mode={mode}
      data-stacked={stacked || undefined}
      data-swapped={swapped || undefined}
    >
      <ResizablePanelGroup
        orientation={stacked ? "vertical" : "horizontal"}
        disabled={!parallel}
        onPointerDownCapture={(event) => {
          if (
            event.button === 0 &&
            (event.target as Element).closest('[data-slot="resizable-handle"]')
          ) {
            onResizeStart?.();
            markResizing();
          }
        }}
        onKeyDownCapture={(event) => {
          if (
            (event.target as Element).closest('[data-slot="resizable-handle"]')
          )
            onResizeStart?.();
        }}
        onLayoutChange={(layout) => {
          if (!parallel) return;
          dividerAt.current = layout[`${id}-left`];
          controls.current?.style.setProperty(
            "--divider-at",
            `${dividerAt.current}%`,
          );
        }}
        onLayoutChanged={(layout, { isUserInteraction }) => {
          if (parallel && isUserInteraction) {
            rememberedWidth.current = layout[sourceId];
            onSourceWidthChange(layout[sourceId]);
          }
        }}
      >
        {panels}
      </ResizablePanelGroup>
      {/* Overlay the divider outside the group so its capture-phase drag handler
          does not consume pointer events intended for these buttons. */}
      {parallel && (
        <div
          ref={controls}
          className="translation-pane-controls"
          style={{ "--divider-at": `${dividerAt.current}%` } as CSSProperties}
        >
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="交换原文和译文"
            title="交换原文和译文"
            onClick={onSwap}
          >
            {stacked ? <ArrowUpDown /> : <ArrowLeftRight />}
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            aria-label={stacked ? "左右排列" : "上下排列"}
            title={stacked ? "左右排列" : "上下排列"}
            onClick={() => updateReaderLayout({ stacked: !stacked })}
          >
            {stacked ? <Columns2 /> : <Rows2 />}
          </Button>
        </div>
      )}
    </div>
  );
}
