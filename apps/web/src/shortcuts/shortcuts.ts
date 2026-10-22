import { useEffect, useSyncExternalStore } from "react";
import { api } from "@reader/api";

export const shortcutActions = [
  { id: "readerLeft", name: "阅读模式－左侧栏", scope: "reader", key: "l" },
  { id: "readerRight", name: "阅读模式－右侧栏", scope: "reader", key: "j" },
  { id: "libraryLeft", name: "主界面－左侧栏", scope: "library", key: "l" },
  { id: "primaryLibrary", name: "首选书库", scope: "all", key: "f1" },
  { id: "secondaryLibrary", name: "第二书库", scope: "all", key: "f2" },
  { id: "search", name: "搜索", scope: "all", key: "f" },
] as const;
export type ShortcutId = (typeof shortcutActions)[number]["id"];
export type Binding = { key: string; shift: boolean };
export type Bindings = Record<ShortcutId, Binding>;

export const isMac = () =>
  window.readerDesktop?.platform
    ? window.readerDesktop.platform === "darwin"
    : /Mac|iPhone|iPad/.test(navigator.platform);
export const defaults = (): Bindings =>
  Object.fromEntries(
    shortcutActions.map((action) => [
      action.id,
      { key: action.key, shift: false },
    ]),
  ) as Bindings;
let current = defaults();
const listeners = new Set<() => void>();
export function readBindings() {
  return current;
}
export function normalizeBindings(saved: unknown): Bindings {
  const result = defaults();
  if (saved && typeof saved === "object") {
    for (const { id } of shortcutActions) {
      const value = (saved as Record<string, Binding>)[id];
      if (
        value &&
        typeof value.key === "string" &&
        /^(?:[a-z0-9]|f[12])$/.test(value.key) &&
        typeof value.shift === "boolean"
      )
        result[id] = value;
    }
  }
  return result;
}
function publish(bindings: Bindings) {
  current = bindings;
  listeners.forEach((listener) => listener());
}
export async function loadBindings() {
  publish(normalizeBindings(await api.shortcutPreferences()));
}
export async function saveBindings(bindings: Bindings) {
  await api.saveShortcutPreferences(bindings);
  publish(bindings);
}
export function useBindings() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, readBindings);
}
export function label(binding: Binding, mac = isMac()) {
  if (/^f[12]$/.test(binding.key))
    return `${binding.shift ? "Shift + " : ""}${binding.key.toUpperCase()}`;
  return `${mac ? "Cmd" : "Ctrl"}${binding.shift ? " + Shift" : ""} + ${binding.key.toUpperCase()}`;
}
export function bindingFromEvent(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
  mac = isMac(),
): Binding | null {
  if (
    /^F[12]$/i.test(event.key) &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  )
    return { key: event.key.toLowerCase(), shift: event.shiftKey };
  if (
    !(mac
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey) ||
    event.altKey ||
    !/^[a-z0-9]$/i.test(event.key)
  )
    return null;
  return { key: event.key.toLowerCase(), shift: event.shiftKey };
}
export function bindingError(
  id: ShortcutId,
  binding: Binding,
  bindings: Bindings,
): string | null {
  // Keep editing, import, command palette and native window shortcuts available.
  if ("acvxyzkoqwrhnt".includes(binding.key))
    return "该组合键已用于文本编辑或应用、系统操作，请换一个。";
  const action = shortcutActions.find((item) => item.id === id)!;
  const conflict = shortcutActions.find(
    (item) =>
      item.id !== id &&
      (item.scope === "all" ||
        action.scope === "all" ||
        item.scope === action.scope) &&
      bindings[item.id].key === binding.key &&
      bindings[item.id].shift === binding.shift,
  );
  return conflict ? `与「${conflict.name}」冲突，请换一个。` : null;
}
export function matches(
  event: KeyboardEvent,
  id: ShortcutId,
  bindings = readBindings(),
  mac = isMac(),
) {
  const binding = bindingFromEvent(event, mac);
  return (
    !!binding &&
    binding.key === bindings[id].key &&
    binding.shift === bindings[id].shift
  );
}
export function useShortcut(
  id: ShortcutId,
  action: () => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        (event.target instanceof Element &&
          event.target.closest("[data-reader-floating-preview]")) ||
        document.querySelector(
          '[role="dialog"]:not([data-reader-floating-preview]), [role="alertdialog"]',
        )
      )
        return;
      if (!matches(event, id)) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [id, action, enabled]);
}
/** Keyboard events inside Readium frames do not bubble to the renderer window. */
export function forwardReaderShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.repeat) return;
  if (
    ![
      "readerLeft",
      "readerRight",
      "search",
      "primaryLibrary",
      "secondaryLibrary",
    ].some((id) => matches(event, id as ShortcutId))
  )
    return;
  const forwarded = new KeyboardEvent("keydown", {
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    cancelable: true,
  });
  window.dispatchEvent(forwarded);
  if (forwarded.defaultPrevented) event.preventDefault();
}
