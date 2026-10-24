import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type CiteEvent } from "@neoread/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@neoread/ui/components/alert-dialog";
import { useReaderStore } from "../store";
import { CitationEditor } from "./CitationEditor";
import type { Citation, DocumentPrefs } from "./codes";
import { DocumentPrefsDialog } from "./DocumentPrefsDialog";
import { librarySource } from "./items";
import type { CiteCommand, DocumentPort } from "./protocol";
import type { CiteUI } from "./session";
import { encodeForVBA } from "./vba";

type Request =
  | {
      kind: "citation";
      props: Parameters<CiteUI["editCitation"]>[0];
      resolve: (value: Citation | null) => void;
    }
  | {
      kind: "prefs";
      current: DocumentPrefs | null;
      resolve: (value: DocumentPrefs | null) => void;
    }
  | {
      kind: "confirm";
      message: string;
      action: string;
      resolve: (value: boolean) => void;
    }
  | { kind: "alert"; message: string; resolve: () => void };

const commands: CiteCommand[] = [
  "addEditCitation",
  "addEditBibliography",
  "setDocPrefs",
  "refresh",
  "removeCodes",
];

const focusWindow = () => void window.neoreadDesktop?.focusWindow?.();

/**
 * Receives commands from the Word and WPS plugins and runs them with the
 * library open in this window. Dialogs take focus; refreshes run unseen.
 */
export function CiteHost() {
  const [request, setRequest] = useState<Request | null>(null);
  const documents = useReaderStore((s) => s.documents);

  useEffect(() => {
    const controller = new AbortController();
    // An object, so the cleanup below sees assignments made inside `run`.
    const active: {
      current: { transaction: string; cancel: () => void } | null;
    } = { current: null };

    const run = async (
      event: Extract<CiteEvent, { type: "command" }>,
    ): Promise<void> => {
      const { transaction } = event;
      let cancelled = false;
      let pending: (() => void) | null = null;
      active.current = {
        transaction,
        cancel: () => {
          cancelled = true;
          pending?.();
          setRequest(null);
        },
      };
      // Each dialog resolves with its "cancel" value if Word disconnects.
      const ask = <T,>(
        make: (resolve: (value: T) => void) => Request,
        cancelValue: T,
      ) =>
        new Promise<T>((resolve) => {
          if (cancelled) return resolve(cancelValue);
          focusWindow();
          pending = () => resolve(cancelValue);
          setRequest(
            make((value) => {
              pending = null;
              setRequest(null);
              resolve(value);
            }),
          );
        });
      const ui: CiteUI = {
        editCitation: (props) =>
          ask<Citation | null>(
            (resolve) => ({ kind: "citation", props, resolve }),
            null,
          ),
        documentPrefs: (prefs) =>
          ask<DocumentPrefs | null>(
            (resolve) => ({ kind: "prefs", current: prefs, resolve }),
            null,
          ),
        confirm: (message, action) =>
          ask<boolean>(
            (resolve) => ({ kind: "confirm", message, action, resolve }),
            false,
          ),
        alert: (message) =>
          ask<void>(
            (resolve) => ({ kind: "alert", message, resolve }),
            undefined,
          ),
      };
      const port: DocumentPort = {
        call: async (operation) => {
          if (cancelled) throw new Error("文字处理软件已断开");
          const word = event.client.startsWith("word-");
          return (await api.citeCall(
            transaction,
            word ? { ...operation, vba: encodeForVBA(operation) } : operation,
          )) as never;
        },
      };
      let error = "";
      try {
        if (!commands.includes(event.command as CiteCommand))
          throw new Error("Reader 版本过旧，不支持这个命令");
        // citeproc loads with the first command, not with the app.
        const { CiteSession } = await import("./session");
        await new CiteSession(
          port,
          ui,
          librarySource(useReaderStore.getState().documents),
        ).run(event.command as CiteCommand);
      } catch (e) {
        error = (e as Error).message;
        if (!cancelled) toast.error(`引用操作失败：${error}`);
      } finally {
        active.current = null;
        setRequest(null);
        if (!cancelled)
          await api
            .citeComplete(transaction, { activate: true, error })
            .catch(() => {});
      }
    };

    const onEvent = (event: CiteEvent) => {
      if (event.type === "focus") focusWindow();
      else if (event.type === "aborted") {
        if (active.current?.transaction === event.transaction) {
          active.current.cancel();
          toast.info("文字处理软件已断开，本次操作已取消");
        }
      } else void run(event);
    };

    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await api.citeEvents(controller.signal, onEvent);
        } catch {
          /* Reconnect below; the server may be restarting. */
        }
        if (controller.signal.aborted) return;
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
      }
    })();
    return () => {
      controller.abort();
      active.current?.cancel();
    };
  }, []);

  if (!request) return null;
  if (request.kind === "citation")
    return (
      <CitationEditor
        documents={documents}
        {...request.props}
        onDone={request.resolve}
      />
    );
  if (request.kind === "prefs")
    return (
      <DocumentPrefsDialog current={request.current} onDone={request.resolve} />
    );
  const confirm = request.kind === "confirm";
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (open) return;
        if (request.kind === "confirm") request.resolve(false);
        else request.resolve();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm ? "请确认" : "提示"}</AlertDialogTitle>
          <AlertDialogDescription>{request.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {request.kind === "confirm" ? (
            <>
              <AlertDialogCancel onClick={() => request.resolve(false)}>
                取消
              </AlertDialogCancel>
              <AlertDialogAction onClick={() => request.resolve(true)}>
                {request.action}
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction onClick={() => request.resolve()}>
              好
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
