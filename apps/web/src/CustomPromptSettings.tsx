import { useId, useState } from "react";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { Textarea } from "@neoread/ui/components/textarea";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import {
  maxPromptBytes,
  loadPrompts,
  promptBytes,
  savePrompts,
  useCustomPrompts,
} from "./chat/custom-prompts";

export function CustomPromptSettings() {
  const id = useId();
  const { prompts, loaded, loading, saving, error } = useCustomPrompts();
  const busy = !loaded || loading || saving;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const tooLong = promptBytes(prompt.trim()) > maxPromptBytes;
  function reset() {
    setEditing(undefined);
    setDescription("");
    setPrompt("");
  }
  const failed = () =>
    toast.error(
      "无法保存常用 prompt，请检查连接或存储空间；最多 50 条，每条提示词不超过 16,000 UTF-8 字节。",
    );
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">常用 prompt</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || prompts.length >= 50}
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          添加
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 text-sm text-destructive"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || saving}
            onClick={() => void loadPrompts()}
          >
            重试
          </Button>
        </div>
      )}
      <div className="space-y-2">
        {prompts.map((p) => (
          <div key={p.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate" title={p.description}>
              {p.description}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`编辑 ${p.description}`}
              disabled={busy}
              onClick={() => {
                setEditing(p.id);
                setDescription(p.description);
                setPrompt(p.prompt);
                setOpen(true);
              }}
            >
              编辑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`删除 ${p.description}`}
              disabled={busy}
              onClick={async () => {
                if (await savePrompts(prompts.filter((x) => x.id !== p.id))) {
                  if (editing === p.id) reset();
                } else failed();
              }}
            >
              删除
            </Button>
          </div>
        ))}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? "编辑常用 prompt" : "添加常用 prompt"}
            </DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy || !description.trim() || !prompt.trim() || tooLong)
                return;
              const next = {
                id: editing ?? crypto.randomUUID(),
                description: description.trim(),
                prompt: prompt.trim(),
              };
              if (
                await savePrompts(
                  editing
                    ? prompts.map((p) => (p.id === editing ? next : p))
                    : [...prompts, next],
                )
              ) {
                reset();
                setOpen(false);
              } else failed();
            }}
          >
            <div className="space-y-2">
              <label htmlFor={`${id}-description`} className="block text-sm">
                功能描述
              </label>
              <Input
                id={`${id}-description`}
                maxLength={80}
                disabled={saving}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor={`${id}-prompt`} className="block text-sm">
                具体 prompt
              </label>
              <Textarea
                id={`${id}-prompt`}
                className="max-h-[min(20rem,40dvh)] overflow-y-auto"
                rows={6}
                disabled={saving}
                maxLength={maxPromptBytes}
                aria-invalid={tooLong}
                aria-describedby={tooLong ? `${id}-prompt-error` : undefined}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              {tooLong && (
                <p
                  id={`${id}-prompt-error`}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  提示词最多 16,000 UTF-8 字节，当前为{" "}
                  {promptBytes(prompt.trim()).toLocaleString()}{" "}
                  字节。请缩短后保存。
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={
                  busy || !description.trim() || !prompt.trim() || tooLong
                }
              >
                保存
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
