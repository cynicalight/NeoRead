import { api } from "@neoread/api";
import { toast } from "sonner";

type NoteStatus =
  "loading" | "load-error" | "dirty" | "saving" | "saved" | "save-error";
type NoteSnapshot = { body: string; status: NoteStatus; error: string };
// One renderer session / library. Failed drafts stay here when React unmounts.
const notes = new Map<string, PaperNoteState>();
const message = (error: unknown) =>
  error instanceof Error ? error.message : "笔记保存失败";
export const paperNoteLimit = 100000;
function exceedsLimit(body: string) {
  if (body.length <= paperNoteLimit) return false;
  let count = 0;
  for (const _ of body) if (++count > paperNoteLimit) return true;
  return false;
}

class PaperNoteState {
  private snapshot: NoteSnapshot = { body: "", status: "loading", error: "" };
  private listeners = new Set<() => void>();
  private saved: string | undefined;
  private pending = false;
  private uncertain = false;
  private timer?: ReturnType<typeof setTimeout>;
  private loading?: Promise<void>;
  private saving?: Promise<string>;
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
        if (this.pending && this.snapshot.status !== "save-error")
          void this.flush().catch(() => {});
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
      notes.get(this.id) === this
    )
      notes.delete(this.id);
  }
  load = (): Promise<void> => {
    if (this.saved !== undefined) return Promise.resolve();
    if (this.loading) return this.loading;
    this.update({ status: "loading", error: "" });
    this.loading = api
      .documentNote(this.id)
      .then((note) => {
        this.saved = note.body;
        this.update({ body: note.body, status: "saved" });
      })
      .catch((error) => {
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
    if (this.saved === undefined) return;
    clearTimeout(this.timer);
    // A failed PUT may already have reached the server; rewriting also repairs
    // that uncertainty when the user reverts to the previously saved text.
    this.pending = body !== this.saved || this.uncertain;
    this.update({
      body,
      status: this.saving ? "saving" : this.pending ? "dirty" : "saved",
      error: "",
    });
    if (this.pending)
      this.timer = setTimeout(() => void this.flush().catch(() => {}), 800);
  };
  flush = (): Promise<string> => {
    clearTimeout(this.timer);
    if (this.saving) return this.saving;
    if (this.saved === undefined)
      return this.load().then(() => this.snapshot.body);
    if (!this.pending) return Promise.resolve(this.snapshot.body);
    this.saving = this.write().finally(() => {
      this.saving = undefined;
      this.release();
    });
    return this.saving;
  };
  private async write() {
    try {
      while (this.pending) {
        const body = this.snapshot.body;
        if (exceedsLimit(body))
          throw new Error(`笔记超过 ${paperNoteLimit} 字，请缩短后重试`);
        this.update({ status: "saving", error: "" });
        this.uncertain = true;
        await api.saveDocumentNote(this.id, body);
        this.uncertain = false;
        this.saved = body;
        this.pending = this.snapshot.body !== body;
      }
      this.update({ status: "saved", error: "" });
      return this.snapshot.body;
    } catch (error) {
      clearTimeout(this.timer);
      this.update({ status: "save-error", error: message(error) });
      if (!this.listeners.size)
        toast.error(`论文笔记未保存：${message(error)}`);
      throw error;
    }
  }
  hasPending = () => this.pending || !!this.saving;
}

export function getPaperNote(id: string) {
  let note = notes.get(id);
  if (!note) {
    note = new PaperNoteState(id);
    notes.set(id, note);
  }
  return note;
}
/** A fresh, saved snapshot for export, including edits made after opening it. */
export async function flushPaperNote(id: string): Promise<string> {
  const note = notes.get(id);
  return note ? note.flush() : (await api.documentNote(id)).body;
}
export async function flushPaperNotes() {
  // Another document may become dirty while the current batch is saving.
  while (hasPendingPaperNotes()) {
    await Promise.all(
      [...notes.values()]
        .filter((note) => note.hasPending())
        .map((note) => note.flush()),
    );
  }
}
export const hasPendingPaperNotes = () =>
  [...notes.values()].some((note) => note.hasPending());
