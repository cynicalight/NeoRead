import { useState } from "react";
import { Button } from "@reader/ui/components/button";
import { Input } from "@reader/ui/components/input";
import {
  bindingError,
  bindingFromEvent,
  defaults,
  isMac,
  label,
  useBindings,
  saveBindings,
  shortcutActions,
  type ShortcutId,
  type Bindings,
} from "./shortcuts";

export function ShortcutPanel() {
  const bindings = useBindings();
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ShortcutId | null>(null);
  const [error, setError] = useState("");
  const save = async (next: Bindings) => {
    setSaving(true);
    try {
      await saveBindings(next);
      setEditing(null);
      setError("");
    } catch {
      setError("保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  };
  const filtered = shortcutActions.filter((action) =>
    action.name.includes(query.trim()),
  );
  return (
    <section className="space-y-4 min-w-0" aria-label="快捷键设置">
      <h2 className="text-base font-medium">快捷键</h2>
      <p className="text-sm text-muted-foreground">
        点击组合键后按下新快捷键，按 Esc 取消。使用 {isMac() ? "Cmd" : "Ctrl"}{" "}
        加字母或数字，或使用 F1、F2，可搭配 Shift。
      </p>
      <p className="text-sm text-muted-foreground">
        F1 默认打开设置中的首选书库，F2 打开另一个书库。
      </p>
      <div className="flex items-center gap-2">
        <Input
          className="min-w-0 flex-1"
          aria-label="搜索快捷键"
          placeholder="搜索快捷键名称…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setEditing(null);
            setError("");
          }}
        />
        <Button
          variant="ghost"
          className="shrink-0"
          disabled={saving}
          onClick={() => void save(defaults())}
        >
          恢复默认
        </Button>
      </div>
      <div className="divide-y">
        {filtered.map((action) => (
          <div
            key={action.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <span className="text-sm">{action.name}</span>
            <Button
              variant="outline"
              disabled={saving}
              aria-label={`修改${action.name}快捷键`}
              aria-pressed={editing === action.id}
              onClick={() => {
                setEditing(action.id);
                setError("");
              }}
              onBlur={() => {
                if (editing === action.id) setEditing(null);
              }}
              onKeyDown={(event) => {
                if (editing !== action.id) return;
                event.stopPropagation();
                if (event.key === "Tab") {
                  setEditing(null);
                  return;
                }
                event.preventDefault();
                if (event.key === "Escape") {
                  setEditing(null);
                  setError("");
                  return;
                }
                if (["Meta", "Control", "Shift", "Alt"].includes(event.key))
                  return;
                const binding = bindingFromEvent(event);
                if (!binding) {
                  setError(
                    `请使用 ${isMac() ? "Cmd" : "Ctrl"} 加字母或数字，或使用 F1、F2，可搭配 Shift。`,
                  );
                  return;
                }
                const problem = bindingError(action.id, binding, bindings);
                if (problem) {
                  setError(problem);
                  return;
                }
                void save({ ...bindings, [action.id]: binding });
              }}
            >
              {editing === action.id
                ? "请按下新快捷键…"
                : label(bindings[action.id])}
            </Button>
          </div>
        ))}
        {!filtered.length && (
          <p className="py-6 text-sm text-muted-foreground">
            没有找到匹配的快捷键
          </p>
        )}
      </div>
      <p role="status" className="text-sm text-destructive">
        {error}
      </p>
    </section>
  );
}
