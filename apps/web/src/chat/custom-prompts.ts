import { useEffect, useState } from "react";
import { reportDiagnostic } from "../diagnostics";
export type CustomPrompt = { id: string; description: string; prompt: string };
const key = "neoread.custom-prompts";
const changed = "neoread-custom-prompts-changed";
export function readPrompts(): CustomPrompt[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (Array.isArray(value))
      return value.filter(
        (p): p is CustomPrompt =>
          !!p &&
          typeof p.id === "string" &&
          typeof p.description === "string" &&
          typeof p.prompt === "string" &&
          !!p.description.trim() &&
          !!p.prompt.trim(),
      );
  } catch {
    /* Never overwrite stored data on a failed read. */
  }
  return [];
}
export function savePrompts(prompts: CustomPrompt[]) {
  try {
    localStorage.setItem(key, JSON.stringify(prompts));
  } catch {
    reportDiagnostic({
      level: "error",
      event: "chat.prompts.save_failed",
      detail: "reason=storage_write_failed",
    });
    return false;
  }
  window.dispatchEvent(new Event(changed));
  return true;
}
export function useCustomPrompts() {
  const [prompts, setPrompts] = useState(readPrompts);
  useEffect(() => {
    const refresh = () => setPrompts(readPrompts());
    const storage = (e: StorageEvent) => {
      if (e.key === key || e.key === null) refresh();
    };
    window.addEventListener(changed, refresh);
    window.addEventListener("storage", storage);
    refresh();
    return () => {
      window.removeEventListener(changed, refresh);
      window.removeEventListener("storage", storage);
    };
  }, []);
  return prompts;
}
