import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  BookText,
  FileText,
  Plus,
  X,
  Check,
  ChevronDown,
} from "lucide-react";
import { documentTabCommand, type Document } from "@neoread/core";
import type { Processing, ReaderTheme } from "@neoread/core";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
import { Button } from "@neoread/ui/components/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@neoread/ui/components/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@neoread/ui/components/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@neoread/ui/components/context-menu";
import { toast } from "sonner";
import { useReaderStore, refreshLibrary, documentTabsShown } from "./store";
import { flushProgress } from "./progress";
import { tabCloseWarning } from "./document-tab-guards";
import { Workspace } from "./Workspace";
import { useTabReorder } from "./useTabReorder";
import "./document-tabs.css";

const closeDuration = 150;
const animated = () =>
  !!window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches;

export function DocumentTabs({
  onSelect,
  onLibrary,
  onNew,
}: {
  onSelect: (doc: Document) => void;
  onLibrary: () => void;
  onNew: () => void;
}) {
  const {
    documents,
    tabIds,
    active,
    closeTabs,
    moveTab,
    closedTabGroups,
    theme,
    setTheme,
  } = useReaderStore();
  const enabled = theme.documentTabs === true;
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [closing, setClosing] = useState(false);
  const [leaving, setLeaving] = useState<string[]>([]);
  // Tabs present at mount are restored, not opened, so only later ones animate in.
  const known = useRef<Set<string> | null>(null);
  known.current ??= new Set(tabIds);
  const pendingClose = useRef(false),
    restoreFocus = useRef(false);
  const strip = useRef<HTMLDivElement>(null);
  const reorder = useTabReorder(strip, moveTab);
  const tabs = tabIds.flatMap(
    (id) => documents.find((doc) => doc.id === id) ?? [],
  );
  const tabOrder = JSON.stringify(tabIds);
  const warningFor = (ids: string[]) => {
    const warnings = ids.flatMap((id) => tabCloseWarning(id) ?? []);
    return warnings.find((warning) => warning.blocked) ?? warnings[0] ?? null;
  };
  const finishClose = async (ids: string[], confirmed = false) => {
    if (pendingClose.current) return;
    pendingClose.current = true;
    setClosing(true);
    try {
      await flushProgress();
      const warning = warningFor(ids);
      if (warning?.blocked || (warning && !confirmed)) {
        setConfirming(ids);
        return;
      }
      const focused = document.activeElement;
      restoreFocus.current =
        confirmed ||
        !focused ||
        focused === document.body ||
        ids.includes(useReaderStore.getState().active?.id ?? "") ||
        ids.some((id) =>
          document
            .getElementById(`document-tab-${id}`)
            ?.parentElement?.contains(focused),
        );
      setConfirming(null);
      if (animated()) {
        setLeaving(ids);
        await new Promise((done) => setTimeout(done, closeDuration));
      }
      closeTabs(ids);
      void refreshLibrary().catch((e) => toast.error(e.message));
    } catch (error) {
      keepTabs();
      toast.error(
        `阅读进度保存失败，标签页已保留：${(error as Error).message}`,
      );
    } finally {
      pendingClose.current = false;
      setClosing(false);
      setLeaving([]);
    }
  };
  // Turning tabs off closes the others; keeping any of them keeps tabs on.
  const keepTabs = () => {
    if (useReaderStore.getState().theme.documentTabs !== true)
      setTheme({ documentTabs: true });
  };
  const requestClose = (requested: string[]) => {
    if (pendingClose.current) return;
    const ids = requested.filter((id) =>
      useReaderStore.getState().tabIds.includes(id),
    );
    if (!ids.length) return;
    if (warningFor(ids)) setConfirming(ids);
    else void finishClose(ids);
  };
  const reopen = () => {
    if (pendingClose.current) return;
    restoreFocus.current = true;
    const doc = useReaderStore.getState().reopenTabs();
    if (doc) onSelect(doc);
    else restoreFocus.current = false;
  };
  const extra = enabled
    ? ""
    : JSON.stringify(tabIds.filter((id) => id !== active?.id));
  useEffect(() => {
    if (!enabled && extra !== "[]") requestClose(JSON.parse(extra));
  }, [enabled, extra]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !enabled ||
        event.defaultPrevented ||
        event.repeat ||
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"]',
        )
      )
        return;
      const command = documentTabCommand(event);
      if (!command) return;
      if (command.type === "reopen") {
        if (closedTabGroups.length) {
          event.preventDefault();
          reopen();
        }
        return;
      }
      if (!tabs.length || (command.type === "close" && !active)) return;
      event.preventDefault();
      if (command.type === "close") {
        requestClose([active!.id]);
        return;
      }
      const index =
        command.type === "select"
          ? command.index < 0
            ? tabs.length - 1
            : command.index
          : active
            ? (tabs.findIndex((doc) => doc.id === active.id) +
                (command.type === "next" ? 1 : -1) +
                tabs.length) %
              tabs.length
            : command.type === "next"
              ? 0
              : tabs.length - 1;
      if (tabs[index]) onSelect(tabs[index]);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => {
    const selected = active
      ? document.getElementById(`document-tab-${active.id}`)
      : document.getElementById("reader-library-tab");
    if (active)
      selected?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
        behavior: animated() ? "smooth" : "auto",
      });
    if (!restoreFocus.current) return;
    const frame = requestAnimationFrame(() => {
      restoreFocus.current = false;
      (selected ?? document.getElementById("reader-library-panel"))?.focus({
        preventScroll: true,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [active?.id, tabOrder]);
  useEffect(() => {
    void window.neoreadDesktop
      ?.setDocumentTabActive?.(enabled && !!active)
      .catch((e: Error) => toast.error(e.message));
  }, [active?.id, enabled]);
  useEffect(() => {
    for (const id of tabIds) known.current!.add(id);
  });
  // Fade the strip edges only where tabs are scrolled out of view.
  const hasTabs = documentTabsShown({ theme, tabIds, closedTabGroups });
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const update = () => {
      const end = element.scrollWidth - element.clientWidth;
      element.toggleAttribute("data-overflow-start", element.scrollLeft > 1);
      element.toggleAttribute(
        "data-overflow-end",
        element.scrollLeft < end - 1,
      );
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(update);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [hasTabs, tabOrder]);
  // Like Chrome, closing with the mouse keeps tab widths until the pointer
  // leaves the strip, so the next close button lands under the cursor.
  const freezeWidths = (tab: HTMLElement | null) => {
    if (!tab || !strip.current) return;
    strip.current.style.setProperty(
      "--document-tab-frozen",
      `${tab.offsetWidth}px`,
    );
    strip.current.dataset.frozen = "";
  };
  const thaw = () => {
    if (strip.current) delete strip.current.dataset.frozen;
  };
  useEffect(() => {
    if (!confirming) return;
    const ids = confirming.filter((id) => tabIds.includes(id));
    if (ids.length !== confirming.length)
      setConfirming(ids.length ? ids : null);
  }, [tabIds, confirming]);
  if (!hasTabs) return null;
  const warning = confirming ? warningFor(confirming) : null;
  const targets = tabs.filter((doc) => confirming?.includes(doc.id));
  return (
    <>
      <Tabs
        className="document-tabbar"
        value={active?.id ?? "library"}
        onValueChange={(value) => {
          if (value === "library") onLibrary();
          else {
            const doc = tabs.find((item) => item.id === value);
            if (doc) onSelect(doc);
          }
        }}
      >
        <TabsList
          variant="line"
          className="document-tabs-list"
          aria-label="已打开的文档"
        >
          <TabsTrigger
            id="reader-library-tab"
            value="library"
            aria-controls="reader-library-panel"
            className="document-library-tab"
            aria-label="返回书库"
          >
            <BookOpen className="size-3.5" />
            书库
          </TabsTrigger>
          <div
            className="document-tabs-scroll"
            ref={strip}
            onPointerLeave={thaw}
            onWheel={(event) => {
              if (Math.abs(event.deltaY) > Math.abs(event.deltaX))
                event.currentTarget.scrollLeft += event.deltaY;
            }}
          >
            {tabs.map((doc, index) => (
              <ContextMenu key={doc.id}>
                <ContextMenuTrigger
                  render={
                    <div
                      className="document-tab"
                      data-tab-id={doc.id}
                      data-active={active?.id === doc.id || undefined}
                      data-new={!known.current!.has(doc.id) || undefined}
                      data-leaving={leaving.includes(doc.id) || undefined}
                      onPointerDown={reorder(doc.id)}
                      onAuxClick={(event) => {
                        if (event.button === 1) {
                          event.preventDefault();
                          freezeWidths(event.currentTarget);
                          requestClose([doc.id]);
                        }
                      }}
                    />
                  }
                >
                  <TabsTrigger
                    value={doc.id}
                    id={`document-tab-${doc.id}`}
                    aria-controls={`document-panel-${doc.id}`}
                    className="document-tab-trigger"
                    title={doc.title}
                  >
                    {doc.type === "epub" ? <BookText /> : <FileText />}
                    <span>{doc.title}</span>
                  </TabsTrigger>
                  <Button
                    className="document-tab-close"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`关闭标签页：${doc.title}`}
                    disabled={closing}
                    onClick={(event) => {
                      if (event.detail)
                        freezeWidths(event.currentTarget.parentElement);
                      requestClose([doc.id]);
                    }}
                  >
                    <X className="size-3" />
                  </Button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    disabled={closing}
                    onClick={() => requestClose([doc.id])}
                  >
                    关闭标签页
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={closing || tabs.length < 2}
                    onClick={() =>
                      requestClose(tabIds.filter((id) => id !== doc.id))
                    }
                  >
                    关闭其他标签页
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={closing || index === tabs.length - 1}
                    onClick={() => requestClose(tabIds.slice(index + 1))}
                  >
                    关闭右侧标签页
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={!index}
                    onClick={() => moveTab(doc.id, index - 1)}
                  >
                    向左移动
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={index === tabs.length - 1}
                    onClick={() => moveTab(doc.id, index + 1)}
                  >
                    向右移动
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={closing || !closedTabGroups.length}
                    onClick={reopen}
                  >
                    重新打开关闭的标签页
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
            <Button
              className="document-tab-new"
              variant="ghost"
              size="icon-sm"
              aria-label="打开其他文档"
              title="打开其他文档"
              onClick={onNew}
            >
              <Plus />
            </Button>
          </div>
        </TabsList>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="标签页列表"
                title={`已打开 ${tabs.length} 份文档`}
              />
            }
          >
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-72 max-w-[calc(100vw-24px)]"
          >
            {tabs.map((doc) => (
              <DropdownMenuItem
                key={doc.id}
                onClick={() => onSelect(doc)}
                title={doc.title}
                aria-current={active?.id === doc.id ? "page" : undefined}
              >
                {active?.id === doc.id ? (
                  <Check className="size-3.5" />
                ) : (
                  <span className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{doc.title}</span>
              </DropdownMenuItem>
            ))}
            {!!tabs.length && <DropdownMenuSeparator />}
            <DropdownMenuItem
              disabled={closing || !closedTabGroups.length}
              onClick={reopen}
            >
              重新打开关闭的标签页
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={closing || !tabs.length}
              onClick={() => requestClose(tabIds)}
            >
              关闭所有标签页
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="document-tabs-drag" aria-hidden="true" />
      </Tabs>
      <AlertDialog
        open={!!confirming}
        onOpenChange={(open) => {
          if (open || closing) return;
          setConfirming(null);
          keepTabs();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {warning?.blocked
                ? "暂时无法关闭标签页"
                : targets.length > 1
                  ? `关闭这 ${targets.length} 个标签页？`
                  : "关闭这个标签页？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="mb-2 block">
                {targets
                  .slice(0, 3)
                  .map((doc) => `《${doc.title}》`)
                  .join("、")}
                {targets.length > 3 ? `等 ${targets.length} 份文档` : ""}
              </span>
              {warning?.message ?? "已保存的阅读记录和对话会保留。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={closing}>返回阅读</AlertDialogCancel>
            {!warning?.blocked && (
              <AlertDialogAction
                disabled={closing}
                onClick={(event) => {
                  event.preventDefault();
                  if (confirming) void finishClose(confirming, true);
                }}
              >
                关闭标签页
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Only visited tabs create readers; switching keeps their drafts and streams alive. */
export function ReadingWorkspaces({
  theme,
  jobs,
  onLibrary,
  onSettings,
}: {
  theme: ReaderTheme;
  jobs: Processing[];
  onLibrary: () => void;
  onSettings: () => void;
}) {
  const { documents, tabIds, visitedTabs, active } = useReaderStore();
  return tabIds.map((id) => {
    const doc = documents.find((item) => item.id === id);
    if (!doc) return null;
    const selected = active?.id === id;
    return (
      <div
        key={id}
        id={`document-panel-${id}`}
        role="tabpanel"
        aria-labelledby={`document-tab-${id}`}
        className="reader-tab-panel"
        hidden={!selected}
        inert={!selected}
      >
        {visitedTabs.includes(id) && (
          <Workspace
            document={doc}
            active={selected}
            theme={theme}
            processing={jobs.find((job) => job.documentId === id)}
            onBack={onLibrary}
            onSettings={onSettings}
          />
        )}
      </div>
    );
  });
}
