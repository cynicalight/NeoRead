import { useId, useRef, useState, type RefObject } from "react";
import { api, RequestError, type SkillDraft, type SkillSummary } from "@neoread/api";
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
import { Button } from "@neoread/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import { Input } from "@neoread/ui/components/input";
import { Textarea } from "@neoread/ui/components/textarea";

export function CreateSkillDialog({
  draft,
  returnFocus,
  onClose,
  onSaved,
}: {
  draft: SkillDraft;
  returnFocus: RefObject<HTMLTextAreaElement | null>;
  onClose: () => void;
  onSaved: (skill: SkillSummary) => void;
}) {
  const id = useId();
  const [fields, setFields] = useState(draft);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  const validName = /^[a-z0-9-]{1,64}$/.test(fields.name);
  const valid = validName && !!fields.description.trim() && !!fields.body.trim();
  const save = async (overwrite: boolean) => {
    if (savingRef.current || !valid) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      onSaved(await api.saveSkill({ ...fields, overwrite }));
    } catch (failure) {
      const exists =
        !overwrite && failure instanceof RequestError && failure.status === 409;
      setConflict(exists);
      if (!exists)
        setError(failure instanceof Error ? failure.message : "无法保存技能。");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving && !conflict) onClose();
      }}
    >
      <DialogContent
        finalFocus={returnFocus}
        showCloseButton={!saving}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>创建技能</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!conflict) void save(false);
          }}
        >
          <label className="grid gap-1.5 text-sm">
            名称
            <Input
              value={fields.name}
              maxLength={64}
              disabled={saving}
              autoComplete="off"
              aria-invalid={!!fields.name && !validName}
              aria-describedby={`${id}-name-hint`}
              onChange={(event) => {
                const name = event.currentTarget.value;
                setFields((current) => ({ ...current, name }));
              }}
            />
          </label>
          <p id={`${id}-name-hint`} className="-mt-2 text-xs text-muted-foreground">
            最多 64 个小写字母、数字或连字符
          </p>
          <label className="grid gap-1.5 text-sm">
            描述
            <Input
              value={fields.description}
              disabled={saving}
              onChange={(event) => {
                const description = event.currentTarget.value;
                setFields((current) => ({ ...current, description }));
              }}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            正文
            <Textarea
              value={fields.body}
              disabled={saving}
              className="min-h-32 max-h-[40dvh] overflow-y-auto font-mono text-sm"
              onChange={(event) => {
                const body = event.currentTarget.value;
                setFields((current) => ({ ...current, body }));
              }}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={!valid || saving}>
              保存技能
            </Button>
          </DialogFooter>
        </form>
        <AlertDialog
          open={conflict}
          onOpenChange={(open) => {
            if (!saving) setConflict(open);
          }}
        >
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>覆盖技能？</AlertDialogTitle>
              <AlertDialogDescription>
                技能「{fields.name}」已存在。覆盖后将替换原有内容。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={saving}>取消覆盖</AlertDialogCancel>
              <AlertDialogAction disabled={saving} onClick={() => void save(true)}>
                覆盖
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
