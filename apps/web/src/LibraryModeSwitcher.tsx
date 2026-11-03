import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { LibraryCatalogSnapshot } from "../../../packages/neoread-core/src/library-archive";
import { Input } from "@neoread/ui/components/input";
import { doubleClickWindow } from "./DetailSheet";
import type { LibraryMode } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@neoread/ui/components/dropdown-menu";

export const libraryModes: Record<
  LibraryMode,
  { label: string; description: string }
> = {
  papers: { label: "论文库", description: "论文、论文信息与引用" },
  books: { label: "图书库", description: "EPUB 与 PDF 书籍、文章" },
};

export function LibraryModeSwitcher({
  mode,
  onChange,
}: {
  mode: LibraryMode;
  onChange: (mode: LibraryMode) => void;
}) {
  const desktop = window.neoreadDesktop;
  const [catalog, setCatalog] = useState<LibraryCatalogSnapshot>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saving = useRef(false);
  const canceled = useRef(false);
  useEffect(() => {
    let current = true;
    void desktop
      ?.libraryCatalog?.()
      .then((value) => {
        if (current) setCatalog(value);
      })
      .catch((error) => toast.error(error.message));
    return () => {
      current = false;
      clearTimeout(timer.current);
    };
  }, [desktop]);
  const active = catalog?.libraries.find(
    (entry) => entry.id === catalog.activeId,
  );
  const name = active?.name ?? libraryModes[mode].label;
  const rename = async () => {
    if (
      canceled.current ||
      saving.current ||
      !active ||
      !desktop?.renameLibrary
    )
      return;
    saving.current = true;
    try {
      setCatalog(await desktop.renameLibrary(active.id, draft));
      setEditing(false);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      saving.current = false;
    }
  };
  if (editing)
    return (
      <Input
        autoFocus
        aria-label="书库名称"
        value={draft}
        maxLength={80}
        className="h-9 text-lg font-semibold"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void rename();
          }
          if (event.key === "Escape") {
            canceled.current = true;
            setEditing(false);
          }
        }}
      />
    );
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next, details) => {
        if (next)
          void desktop
            ?.libraryCatalog?.()
            .then(setCatalog)
            .catch((error) => toast.error(error.message));
        clearTimeout(timer.current);
        if (
          next &&
          active &&
          details.reason === "trigger-press" &&
          details.event instanceof MouseEvent
        )
          timer.current = setTimeout(() => setOpen(true), doubleClickWindow);
        else setOpen(next);
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="library-mode-trigger"
            aria-label={`切换书库，当前为${name}`}
            disabled={busy}
            title={active ? "双击重命名" : undefined}
            onDoubleClick={(event) => {
              if (!active || !desktop?.renameLibrary) return;
              event.preventDefault();
              clearTimeout(timer.current);
              setOpen(false);
              canceled.current = false;
              setDraft(name);
              setEditing(true);
            }}
          />
        }
      >
        <span className="min-w-0 truncate">{name}</span>
        <ChevronDown className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {catalog?.libraries.map((entry) => (
          <DropdownMenuItem
            key={entry.id}
            disabled={busy}
            onClick={() => {
              if (entry.id === catalog.activeId) return;
              setBusy(true);
              void desktop
                ?.switchLibrary?.(entry.id)
                .catch((error) => toast.error(error.message))
                .finally(() => setBusy(false));
            }}
          >
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {entry.id === catalog.activeId && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
        {!!catalog?.libraries.length && <DropdownMenuSeparator />}
        {(Object.keys(libraryModes) as LibraryMode[]).map((key) => (
          <DropdownMenuItem
            key={key}
            className="library-mode-item"
            onClick={() => onChange(key)}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm">
                {catalog
                  ? key === "papers"
                    ? "论文"
                    : "图书"
                  : libraryModes[key].label}
              </span>
              <span className="block text-xs text-muted-foreground">
                {libraryModes[key].description}
              </span>
            </span>
            {key === mode && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
