import { useEffect, useState } from "react";
import { Button } from "@reader/ui/components/button";
import { Input } from "@reader/ui/components/input";
import { toast } from "sonner";
import { updateLibraryPreferences, useReaderStore } from "../store";

export function PaperServiceSettings({ open }: { open: boolean }) {
  const savedEmail = useReaderStore(
    (s) => s.libraryPreferences.crossrefEmail ?? "",
  );
  const [email, setEmail] = useState(savedEmail);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setEmail(savedEmail);
  }, [open, savedEmail]);

  return (
    <section className="mt-7 border-t pt-5">
      <h3 className="mb-3 text-sm font-medium">论文信息服务</h3>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const previous = savedEmail;
          const next = email.trim();
          setSaving(true);
          try {
            await updateLibraryPreferences({ crossrefEmail: next });
            toast.success(
              next ? "Crossref 联系邮箱已保存" : "Crossref 联系邮箱已清除",
            );
          } catch (error) {
            const state = useReaderStore.getState();
            if (state.libraryPreferences.crossrefEmail === next) {
              state.setLibraryPreferences({
                ...state.libraryPreferences,
                crossrefEmail: previous,
              });
            }
            toast.error((error as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <label htmlFor="crossref-email" className="text-sm">
          Crossref 联系邮箱（可选）
        </label>
        <p
          id="crossref-email-help"
          className="mb-3 mt-1 text-xs text-muted-foreground"
        >
          Crossref 用于查询 DOI
          和补全论文信息。填写可联系到你的邮箱后，可使用服务商提供的更高请求额度，无需注册。
          请求额度由 Crossref 限制，Reader 不额外设置此项额度。邮箱仅随 Crossref
          查询发送给该服务商；填写后仍可能触发限流。留空并保存可清除。
        </p>
        <div className="flex gap-2">
          <Input
            id="crossref-email"
            name="crossrefEmail"
            type="email"
            autoComplete="email"
            maxLength={254}
            aria-describedby="crossref-email-help"
            value={email}
            disabled={saving}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
          <Button
            type="submit"
            variant="outline"
            disabled={saving || email.trim() === savedEmail}
          >
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </form>
    </section>
  );
}
