import { useEffect, useSyncExternalStore } from "react";
import { api, type CustomPrompt } from "@neoread/api";
import { reportDiagnostic } from "../diagnostics";
export type { CustomPrompt } from "@neoread/api";
export const maxPromptBytes = 16000;
export const promptBytes = (prompt: string) =>
  new TextEncoder().encode(prompt).length;
const legacyKey = "neoread.custom-prompts";
type State = {
  prompts: CustomPrompt[];
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error?: string;
};
let state: State = {
  prompts: [],
  loaded: false,
  loading: false,
  saving: false,
};
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
function publish(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}
function diagnostic(event: string, reason: string) {
  reportDiagnostic({ level: "error", event, detail: `reason=${reason}` });
}
function isPrompts(value: unknown): value is CustomPrompt[] {
  return (
    Array.isArray(value) &&
    value.every(
      (p) =>
        p &&
        typeof p.id === "string" &&
        !!p.id.trim() &&
        typeof p.description === "string" &&
        !!p.description.trim() &&
        typeof p.prompt === "string" &&
        !!p.prompt.trim(),
    ) &&
    new Set(value.map((p) => p.id)).size === value.length
  );
}
function readLegacy(): CustomPrompt[] | undefined {
  let raw: string | null;
  try {
    raw = localStorage.getItem(legacyKey);
  } catch {
    diagnostic("chat.prompts.load_failed", "legacy_storage_read_failed");
    throw new Error("legacy_read");
  }
  if (raw === null) return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    diagnostic("chat.prompts.load_failed", "legacy_json_invalid");
    throw new Error("legacy_parse");
  }
  if (!isPrompts(value)) {
    diagnostic("chat.prompts.load_failed", "legacy_data_invalid");
    throw new Error("legacy_shape");
  }
  return value;
}

// Share a request and snapshot between settings and suggestions. A failed read
// must never become an editable empty list that could replace saved data.
export function loadPrompts(): Promise<void> {
  if (loading) return loading;
  publish({ loading: true, loaded: false, error: undefined });
  loading = (async () => {
    let preferences: { prompts?: CustomPrompt[] };
    try {
      preferences = await api.customPromptPreferences();
    } catch {
      diagnostic("chat.prompts.load_failed", "server_read_failed");
      publish({ error: "无法读取常用 prompt，请重试。" });
      return;
    }
    if (
      !preferences ||
      typeof preferences !== "object" ||
      Array.isArray(preferences) ||
      (!("prompts" in preferences) && Object.keys(preferences).length !== 0) ||
      ("prompts" in preferences && !isPrompts(preferences.prompts))
    ) {
      diagnostic("chat.prompts.load_failed", "server_data_invalid");
      publish({ error: "常用 prompt 数据格式无效，原数据已保留。" });
      return;
    }
    if (preferences.prompts !== undefined) {
      publish({ prompts: preferences.prompts, loaded: true });
      return;
    }
    let legacy: CustomPrompt[] | undefined;
    try {
      legacy = readLegacy();
    } catch {
      publish({ error: "无法读取旧版常用 prompt，原数据已保留。" });
      return;
    }
    publish({ prompts: legacy ?? [], loaded: true });
    if (legacy !== undefined && !(await savePrompts(legacy))) {
      publish({
        error: "旧版常用 prompt 迁移未完成，原数据已保留，请重试或编辑后保存。",
      });
    }
  })().finally(() => {
    loading = undefined;
    publish({ loading: false });
  });
  return loading;
}

export async function savePrompts(prompts: CustomPrompt[]): Promise<boolean> {
  if (!state.loaded || state.saving) return false;
  if (
    !isPrompts(prompts) ||
    prompts.length > 50 ||
    prompts.some(
      (p) =>
        promptBytes(p.id) > 128 ||
        promptBytes(p.description) > 320 ||
        promptBytes(p.prompt) > maxPromptBytes,
    )
  ) {
    diagnostic("chat.prompts.save_failed", "validation_failed");
    return false;
  }
  publish({ saving: true });
  try {
    await api.saveCustomPromptPreferences(prompts);
    publish({ prompts, error: undefined });
    // Clear only after a successful database write. The server record (including
    // an empty list) always takes precedence if cleanup is unavailable.
    try {
      localStorage.removeItem(legacyKey);
    } catch {
      diagnostic(
        "chat.prompts.migration_cleanup_failed",
        "legacy_storage_remove_failed",
      );
    }
    return true;
  } catch {
    diagnostic("chat.prompts.save_failed", "server_write_failed");
    return false;
  } finally {
    publish({ saving: false });
  }
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useCustomPrompts() {
  const current = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!state.loaded) void loadPrompts();
  }, []);
  return current;
}
