import { create } from "zustand";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@reader/ui/components/alert-dialog";

export interface LargePaper {
  name: string;
  pages: number;
  /** Browser uploads keep the file; desktop imports keep a one-time ID. */
  file?: File;
  id?: string;
}

export function LargePaperDialog({
  papers,
  busy,
  onChoose,
  onCancel,
}: {
  papers: LargePaper[];
  busy: boolean;
  onChoose: (library: "papers" | "books") => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={papers.length > 0}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>检测到 PDF 过大</AlertDialogTitle>
          <AlertDialogDescription>
            请确认是否是论文？如果是图书类，请导入图书库。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction
            variant="outline"
            disabled={busy}
            onClick={() => onChoose("books")}
          >
            不是论文，导入图书库
          </AlertDialogAction>
          <AlertDialogAction disabled={busy} onClick={() => onChoose("papers")}>
            确认是论文，仍然导入论文库
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const useLargeConfirmation = create<{
  pending?: { resolve: (library: "papers" | "books" | null) => void };
}>(() => ({}));
let confirmationQueue = Promise.resolve();
export function confirmLargePaper(): Promise<"papers" | "books" | null> {
  const next = confirmationQueue.then(
    () =>
      new Promise<"papers" | "books" | null>((resolve) => {
        useLargeConfirmation.setState({ pending: { resolve } });
      }),
  );
  confirmationQueue = next.then(() => {});
  return next;
}
export function LargePaperConfirmation() {
  const pending = useLargeConfirmation((state) => state.pending);
  const choose = (library: "papers" | "books" | null) => {
    useLargeConfirmation.setState({ pending: undefined });
    pending?.resolve(library);
  };
  return (
    <LargePaperDialog
      papers={pending ? [{ name: "PDF", pages: 0 }] : []}
      busy={false}
      onChoose={choose}
      onCancel={() => choose(null)}
    />
  );
}
