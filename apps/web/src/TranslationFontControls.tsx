import { useState } from "react";
import { Bold, Loader2 } from "lucide-react";
import { defaultTheme, type ReaderTheme } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@reader/ui/components/select";
import { Toggle } from "@reader/ui/components/toggle";
import { toast } from "sonner";
import { translationFont, translationFontLabel } from "./appearance";
import { canQueryLocalFonts, localFontFamilies } from "./local-fonts";

/** Font family, installed fonts on request, and weight for translated text. */
export function TranslationFontControls({
  theme,
  setTheme,
}: {
  theme: ReaderTheme;
  setTheme: (patch: Partial<ReaderTheme>) => void;
}) {
  const family =
    theme.translationFontFamily ??
    defaultTheme.translationFontFamily ??
    "serif";
  const [installed, setInstalled] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  // A saved font stays selectable before the installed list is read.
  const fonts =
    family === "serif" || family === "sans-serif" || installed.includes(family)
      ? installed
      : [family, ...installed];
  const load = async () => {
    setLoading(true);
    try {
      const found = await localFontFamilies();
      setInstalled(found);
      if (!found.length) toast.info("没有读取到本机字体");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-4">
      <span className="text-sm">译文字体</span>
      <Select
        value={family}
        onValueChange={(value) =>
          value && setTheme({ translationFontFamily: value as string })
        }
      >
        <SelectTrigger
          size="sm"
          className="w-full min-w-0"
          aria-label="译文字体"
        >
          <SelectValue>
            <span
              className="truncate"
              style={{ fontFamily: translationFont(family) }}
            >
              {translationFontLabel(family)}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-72">
          <SelectItem value="sans-serif">黑体 / 无衬线</SelectItem>
          <SelectItem
            value="serif"
            style={{ fontFamily: translationFont("serif") }}
          >
            宋体 / 衬线
          </SelectItem>
          {fonts.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>本机字体</SelectLabel>
                {fonts.map((name) => (
                  <SelectItem
                    key={name}
                    value={name}
                    style={{ fontFamily: translationFont(name) }}
                  >
                    {name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>
      <div className="col-start-2 flex justify-end gap-2">
        {canQueryLocalFonts() && !installed.length && (
          <Button
            size="sm"
            variant="outline"
            className="min-w-0 flex-1"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading && <Loader2 className="animate-spin" />}
            读取本机字体
          </Button>
        )}
        <Toggle
          size="sm"
          variant="outline"
          className="shrink-0"
          aria-label="译文加粗"
          pressed={
            (theme.translationFontWeight ??
              defaultTheme.translationFontWeight) === "bold"
          }
          onPressedChange={(pressed) =>
            setTheme({ translationFontWeight: pressed ? "bold" : "normal" })
          }
        >
          <Bold />
          加粗
        </Toggle>
      </div>
    </div>
  );
}
