import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@neoread/ui/components/alert-dialog";
import { Button } from "@neoread/ui/components/button";
import { Checkbox } from "@neoread/ui/components/checkbox";
import { confirmReparse, refreshOCR, useOCRStore } from "./ocr";
import { useReaderStore } from "./store";

/**
 * Reads OCR notices when a document opens (processing polls cover the rest),
 * and asks before re-parsing scanned documents with a newly available engine.
 */
export function OCRHost() {
  const activeId = useReaderStore((s) => s.active?.id);
  const documents = useReaderStore((s) => s.documents);
  const offer = useOCRStore((s) => s.reparseOffer);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => void refreshOCR(), [activeId]);
  const candidates = offer.filter((doc) =>
    documents.some((d) => d.id === doc.id),
  );
  useEffect(() => setSelected(new Set(offer.map((doc) => doc.id))), [offer]);
  const close = () => useOCRStore.setState({ reparseOffer: [] });
  const chosen = candidates.filter((doc) => selected.has(doc.id));
  return (
    <AlertDialog
      open={candidates.length > 0}
      onOpenChange={(open) => !open && close()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>用新的文字识别重新解析？</AlertDialogTitle>
          <AlertDialogDescription>
            将在后台重新解析所选文档的版面并识别扫描页。解析成功前保留现有内容。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 space-y-2 overflow-y-auto text-sm">
          {candidates.map((doc) => (
            <li key={doc.id}>
              <label className="flex min-w-0 items-center gap-2">
                <Checkbox
                  checked={selected.has(doc.id)}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(doc.id);
                      else next.delete(doc.id);
                      return next;
                    })
                  }
                />
                <span className="truncate">{doc.title}</span>
              </label>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>暂不</AlertDialogCancel>
          <Button
            disabled={chosen.length === 0}
            onClick={() => confirmReparse(chosen.map((doc) => doc.id))}
          >
            重新解析
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
