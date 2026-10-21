import type { DocumentLocation } from "@neoread/core";
import { api } from "@neoread/api";
type Progress = { progress: DocumentLocation; percentage: number };
type Update = { id: string; patch: Progress; version: number };
const latest = new Map<string, Update>();
const versions = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<unknown> = Promise.resolve();
const errors = new Map<string, unknown>();
/** Deleted or merged documents must not leave failed writes blocking other tabs. */
export function forgetProgress(ids: string[]) {
  for (const id of ids) {
    versions.set(id, (versions.get(id) || 0) + 1);
    latest.delete(id);
    errors.delete(id);
  }
}
export function scheduleProgress(
  id: string,
  patch: Progress,
  onError: (error: Error) => void,
) {
  const version = (versions.get(id) || 0) + 1;
  versions.set(id, version);
  latest.set(id, { id, patch, version });
  clearTimeout(timer);
  timer = setTimeout(() => {
    void flushProgress().catch(onError);
  }, 350);
}
export async function flushProgress() {
  clearTimeout(timer);
  const updates = [...latest.values()];
  latest.clear();
  if (updates.length) {
    saving = saving
      .catch(() => {})
      .then(async () => {
        let failure: unknown;
        for (const update of updates) {
          try {
            await api.update(update.id, update.patch);
            errors.delete(update.id);
          } catch (error) {
            if (versions.get(update.id) !== update.version) continue;
            errors.set(update.id, error);
            if (
              !latest.has(update.id) &&
              versions.get(update.id) === update.version
            )
              latest.set(update.id, update);
            failure ??= error;
          }
        }
        if (failure) throw failure;
      });
  }
  const pending = saving;
  await pending;
  if (pending !== saving || latest.size) return flushProgress();
  if (errors.size) throw errors.values().next().value;
}
