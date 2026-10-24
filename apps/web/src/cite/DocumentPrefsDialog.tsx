import { useEffect, useState } from "react";
import { Button } from "@neoread/ui/components/button";
import { Checkbox } from "@neoread/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@neoread/ui/components/dialog";
import { RadioGroup, RadioGroupItem } from "@neoread/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@neoread/ui/components/select";
import type { DocumentPrefs } from "./codes";
import {
  bundledLocales,
  bundledStyles,
  DEFAULT_STYLE,
  loadStyle,
} from "./styles";

const STYLE_DEFAULT = "style-default";

export function DocumentPrefsDialog({
  current,
  onDone,
}: {
  current: DocumentPrefs | null;
  onDone: (prefs: DocumentPrefs | null) => void;
}) {
  const [prefs, setPrefs] = useState<DocumentPrefs>(
    () =>
      current || {
        styleId: DEFAULT_STYLE,
        locale: "",
        noteType: 0,
        automaticUpdates: true,
      },
  );
  const [noteStyle, setNoteStyle] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadStyle(prefs.styleId).then(
      (style) => alive && setNoteStyle(style.noteStyle),
      () => alive && setNoteStyle(false),
    );
    return () => {
      alive = false;
    };
  }, [prefs.styleId]);
  const known = bundledStyles.some((s) => s.id === prefs.styleId);
  const styleTitle =
    bundledStyles.find((s) => s.id === prefs.styleId)?.title || prefs.styleId;
  const localeTitle =
    bundledLocales.find((l) => l.id === prefs.locale)?.title || "跟随样式";
  return (
    <Dialog open onOpenChange={(open) => !open && onDone(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>文档首选项</DialogTitle>
          <DialogDescription>
            设置只保存在当前文档中，换一台电脑打开也保持一致。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1.5">
            <span className="font-medium">引用样式</span>
            <Select
              value={prefs.styleId}
              onValueChange={(value) =>
                value && setPrefs((p) => ({ ...p, styleId: value as string }))
              }
            >
              <SelectTrigger aria-label="引用样式" className="w-full">
                <SelectValue>{styleTitle}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {!known && (
                  <SelectItem value={prefs.styleId}>{prefs.styleId}</SelectItem>
                )}
                {bundledStyles.map((style) => (
                  <SelectItem key={style.id} value={style.id}>
                    {style.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="font-medium">语言</span>
            <Select
              value={prefs.locale || STYLE_DEFAULT}
              onValueChange={(value) =>
                value &&
                setPrefs((p) => ({
                  ...p,
                  locale: value === STYLE_DEFAULT ? "" : (value as string),
                }))
              }
            >
              <SelectTrigger aria-label="语言" className="w-full">
                <SelectValue>{localeTitle}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={STYLE_DEFAULT}>跟随样式</SelectItem>
                {bundledLocales.map((locale) => (
                  <SelectItem key={locale.id} value={locale.id}>
                    {locale.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {noteStyle && (
            <div className="flex flex-col gap-1.5">
              <span className="font-medium">引注显示为</span>
              <RadioGroup
                value={String(prefs.noteType === 2 ? 2 : 1)}
                onValueChange={(value) =>
                  setPrefs((p) => ({
                    ...p,
                    noteType: Number(value) === 2 ? 2 : 1,
                  }))
                }
              >
                <label className="flex items-center gap-2">
                  <RadioGroupItem value="1" />
                  脚注
                </label>
                <label className="flex items-center gap-2">
                  <RadioGroupItem value="2" />
                  尾注
                </label>
              </RadioGroup>
            </div>
          )}
          <label className="flex items-start gap-2">
            <Checkbox
              checked={prefs.automaticUpdates}
              onCheckedChange={(checked) =>
                setPrefs((p) => ({ ...p, automaticUpdates: !!checked }))
              }
            />
            <span>
              自动更新引注
              <span className="block text-xs text-muted-foreground">
                关闭后，插入引注只更新这一处，其余引注和参考文献表在点“刷新”时更新
              </span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onDone(null)}>
            取消
          </Button>
          <Button
            onClick={() =>
              onDone({
                ...prefs,
                noteType: noteStyle ? prefs.noteType || 1 : 0,
              })
            }
          >
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
