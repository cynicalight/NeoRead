import { create } from "zustand";
import { toast } from "sonner";
import type { LibraryEntry } from "../../../packages/neoread-core/src/library-archive";

type ArchiveKind = "export" | "import";
type Task = {
  kind: ArchiveKind | null;
  phase: "idle" | "selecting" | "running" | "ready" | "switching" | "failed";
  foreground: boolean;
  error: string;
  entry?: LibraryEntry;
};
export const useLibraryArchiveTask = create<Task>(() => ({
  kind: null,
  phase: "idle",
  foreground: false,
  error: "",
}));

export async function switchImportedLibrary() {
  const task = useLibraryArchiveTask.getState();
  if (!task.entry || task.phase !== "ready") return;
  useLibraryArchiveTask.setState({ phase: "switching" });
  try {
    const switched = await window.neoreadDesktop?.switchLibrary?.(
      task.entry.id,
    );
    if (switched)
      useLibraryArchiveTask.setState({
        kind: null,
        phase: "idle",
        foreground: false,
        entry: undefined,
      });
    else useLibraryArchiveTask.setState({ phase: "ready" });
  } catch (error) {
    useLibraryArchiveTask.setState({
      phase: "ready",
      error: (error as Error).message,
    });
  }
}

/** Lives outside settings, so closing settings never abandons the operation. */
export async function runLibraryArchive(
  kind: ArchiveKind,
  operation: (started: () => void) => Promise<boolean | LibraryEntry>,
) {
  if (
    ["selecting", "running", "ready", "switching"].includes(
      useLibraryArchiveTask.getState().phase,
    )
  )
    return;
  useLibraryArchiveTask.setState({
    kind,
    phase: "selecting",
    foreground: true,
    error: "",
    entry: undefined,
  });
  try {
    const result = await operation(() =>
      useLibraryArchiveTask.setState({ phase: "running" }),
    );
    if (!result) {
      useLibraryArchiveTask.setState({
        kind: null,
        phase: "idle",
        foreground: false,
      });
      return;
    }
    if (kind === "import" && typeof result === "object") {
      useLibraryArchiveTask.setState({ phase: "ready", entry: result });
      if (useLibraryArchiveTask.getState().foreground)
        await switchImportedLibrary();
      else toast.success("书库已导入，可切换查看");
    } else {
      useLibraryArchiveTask.setState({
        kind: null,
        phase: "idle",
        foreground: false,
      });
      toast.success("书库已导出");
    }
  } catch (error) {
    const message = (error as Error).message;
    useLibraryArchiveTask.setState({ phase: "failed", error: message });
    toast.error(message);
  }
}
