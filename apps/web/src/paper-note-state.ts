import { api } from "@neoread/api";
import { toast } from "sonner";
import { reportDiagnostic } from "./diagnostics";
import { diagnosticError } from "../../../packages/neoread-core/src/diagnostics";

type NoteStatus = "loading" | "load-error" | "dirty" | "saving" | "saved";
type NoteSnapshot = { body: string; status: NoteStatus; error: string };
// One renderer session / library. Failed writes discard pending edits.
let saveWarning = false;
export function takePaperNoteSaveWarning() {
  const warning = saveWarning;
  saveWarning = false;
  return warning;
}
const autosaveInterval = 5000;
const notes = new Map<string, PaperNoteState>();
const message = (error: unknown) =>
  error instanceof Error ? error.message : "笔记保存失败";

class PaperNoteState {
  private snapshot: NoteSnapshot = { body: "", status: "loading", error: "" };
  private listeners = new Set<() => void>();
  private saved: string | undefined;
  private pending = false;
  private uncertain = false;
  private timer?: ReturnType<typeof setTimeout>;
  private loading?: Promise<void>;
  private saving?: Promise<string>;
  private merging?: Promise<void>;
  private needsRefresh = false;
  private discarded = false;
  constructor(readonly id: string) {}
  getSnapshot = () => this.snapshot;
  private update(patch: Partial<NoteSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      // Strict Mode's immediate remount keeps the same entry and request.
      queueMicrotask(() => {
        if (this.listeners.size) return;
        if (this.pending) void this.flush().catch(() => {});
        else this.release();
      });
    };
  };
  private release() {
    if (
      !this.listeners.size &&
      !this.pending &&
      !this.loading &&
      !this.saving &&
      !this.merging &&
      !this.needsRefresh &&
      notes.get(this.id) === this
    )
      notes.delete(this.id);
  }
  load = (): Promise<void> => {
    if (this.discarded) return Promise.resolve();
    if (this.merging) return this.merging.then(() => this.load());
    if (this.needsRefresh) return this.refresh();
    if (this.saved !== undefined) return Promise.resolve();
    if (this.loading) return this.loading;
    this.update({ status: "loading", error: "" });
    this.loading = api
      .documentNote(this.id)
      .then((note) => {
        if (this.discarded) return;
        this.saved = note.body;
        this.update({ body: note.body, status: "saved" });
      })
      .catch((error) => {
        if (this.discarded) return;
        this.update({ status: "load-error", error: message(error) });
        throw error;
      })
      .finally(() => {
        this.loading = undefined;
        this.release();
      });
    return this.loading;
  };
  edit = (body: string) => {
    if (this.discarded || this.saved === undefined) return;
    // An in-flight PUT may replace the saved text; a concurrent revert must
    // still be written after that request finishes.
    this.pending = body !== this.saved || this.uncertain;
    this.update({
      body,
      status: this.saving ? "saving" : this.pending ? "dirty" : "saved",
      error: "",
    });
    if (this.pending) this.scheduleSave();
    else this.clearTimer();
  };
  flush = (): Promise<string> => {
    if (this.discarded) return Promise.resolve(this.snapshot.body);
    this.clearTimer();
    if (this.merging) return this.merging.then(() => this.flush());
    if (this.needsRefresh) return this.refresh().then(() => this.flush());
    if (this.saving) return this.saving;
    if (this.saved === undefined)
      return this.load().then(() => this.snapshot.body);
    if (!this.pending) return Promise.resolve(this.snapshot.body);
    this.saving = this.write().finally(() => {
      this.saving = undefined;
      this.scheduleSave();
      this.release();
    });
    return this.saving;
  };
  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private scheduleSave() {
    // A fixed deadline from the first edit: continuous typing must not postpone it.
    if (
      this.discarded ||
      this.timer !== undefined ||
      this.saving ||
      this.merging ||
      !this.hasPending()
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush()
        .catch(() => {})
        .finally(() => this.scheduleSave());
    }, autosaveInterval);
  }
  private refresh = (): Promise<void> => {
    if (this.loading) return this.loading;
    this.clearTimer();
    this.update({ status: "loading", error: "" });
    this.loading = api
      .documentNote(this.id)
      .then((remote) => {
        if (this.discarded) return;
        // Count Unicode characters, matching the server's note selection rule.
        const body =
          [...this.snapshot.body].length > [...remote.body].length
            ? this.snapshot.body
            : remote.body;
        this.saved = remote.body;
        this.needsRefresh = false;
        this.uncertain = false;
        this.pending = body !== remote.body;
        this.update({
          body,
          status: this.pending ? "dirty" : "saved",
          error: "",
        });
        this.scheduleSave();
      })
      .catch((error) => {
        if (this.discarded) return;
        // A failed refresh must block stale writes until a successful retry.
        this.update({ status: "load-error", error: message(error) });
        throw error;
      })
      .finally(() => {
        this.loading = undefined;
        this.release();
      });
    return this.loading;
  };
  merge = (from: string[]): Promise<void> =>
    this.synchronize(() => api.mergeDocuments(this.id, from));
  synchronize = (change: () => Promise<unknown>): Promise<void> => {
    if (this.merging) return this.merging;
    this.clearTimer();
    this.merging = Promise.resolve()
      .then(async () => {
        if (this.saving) await this.saving;
        if (this.pending) await this.write();
        // Even a lost merge response may mean the server already changed the note.
        this.needsRefresh = true;
        await change();
        if (this.discarded) return;
        await this.refresh().catch(() => {
          toast.error("笔记刷新失败，请在笔记页重试");
        });
      })
      .finally(() => {
        this.merging = undefined;
        this.scheduleSave();
        this.release();
      });
    return this.merging;
  };
  private async write() {
    try {
      while (this.pending) {
        const body = this.snapshot.body;
        this.update({ status: "saving", error: "" });
        this.uncertain = true;
        await api.saveDocumentNote(this.id, body);
        if (this.discarded) return this.snapshot.body;
        this.uncertain = false;
        this.saved = body;
        this.pending = this.snapshot.body !== body;
      }
      this.update({ status: "saved", error: "" });
      return this.snapshot.body;
    } catch (error) {
      if (this.discarded) return this.snapshot.body;
      this.clearTimer();
      this.pending = false;
      this.uncertain = false;
      this.needsRefresh = false;
      this.update({ body: this.saved ?? "", status: "saved", error: "" });
      saveWarning = true;
      try {
        reportDiagnostic({
          level: "error",
          event: "paper_note.save_failed_discarded",
          detail: diagnosticError(error).detail,
        });
      } catch {
        /* Diagnostic transport cannot prevent discarding the failed write. */
      }
      toast.error("论文笔记保存失败，本次未保存的修改已丢弃");
      throw error;
    }
  }
  discard = () => {
    this.discarded = true;
    this.clearTimer();
    this.pending = false;
    this.needsRefresh = false;
    this.update({ status: "saved", error: "" });
  };
  hasPending = () =>
    !this.discarded &&
    (this.pending || !!this.saving || !!this.merging || this.needsRefresh);
}

export function getPaperNote(id: string) {
  let note = notes.get(id);
  if (!note) {
    note = new PaperNoteState(id);
    notes.set(id, note);
  }
  return note;
}
/** Read the shared draft without triggering a write when opening export. */
export async function readPaperNote(id: string): Promise<string> {
  const note = notes.get(id);
  if (!note) return (await api.documentNote(id)).body;
  await note.load();
  return note.getSnapshot().body;
}
/** A fresh, saved snapshot for export, including edits made after opening it. */
export async function flushPaperNote(id: string): Promise<string> {
  const note = notes.get(id);
  return note ? note.flush() : (await api.documentNote(id)).body;
}
export async function flushPaperNotes() {
  // Another document may become dirty while the current batch is saving.
  while (hasPendingPaperNotes()) {
    const results = await Promise.allSettled(
      [...notes.values()]
        .filter((note) => note.hasPending())
        .map((note) => note.flush()),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
export const hasPendingPaperNotes = () =>
  [...notes.values()].some((note) => note.hasPending());

/** Persist participating drafts before merging, then reconcile the open editor. */
export async function mergePaperNotes(master: string, from: string[]) {
  const entry = getPaperNote(master);
  const release = entry.subscribe(() => {});
  try {
    await entry.load();
    await Promise.all([master, ...from].map((id) => notes.get(id)?.flush()));
    await entry.merge(from);
  } finally {
    release();
  }
}

/** Only call after permanent deletion succeeds; trash/restore keeps pending work. */
export function discardPaperNotes(ids: string[]) {
  for (const id of ids) {
    notes.get(id)?.discard();
    notes.delete(id);
  }
}

/** Imports identify duplicate PDFs on the server, so hold cached editors during import. */
export async function importWithPaperNotes<T>(
  run: () => Promise<T>,
): Promise<T> {
  const entries = [...notes.values()];
  const releases = entries.map((entry) => entry.subscribe(() => {}));
  try {
    await Promise.all(entries.map((entry) => entry.load()));
    await Promise.all(entries.map((entry) => entry.flush()));
    let result!: T;
    let change = async (): Promise<void> => {
      result = await run();
    };
    for (const entry of entries) {
      const next = change;
      change = () => entry.synchronize(next);
    }
    await change();
    return result;
  } finally {
    releases.forEach((release) => release());
  }
}
