import { useEffect, useState, type ReactNode } from "react";
import { Bold } from "lucide-react";
import { defaultTheme, type ReaderTheme } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@neoread/ui/components/select";
import { Separator } from "@neoread/ui/components/separator";
import { Slider } from "@neoread/ui/components/slider";
import { Toggle } from "@neoread/ui/components/toggle";
import { toast } from "sonner";
import {
  epubFontSize,
  epubSizePercent,
  READING_MARGIN,
  sourceFont,
  translationFont,
  translationFontLabel,
} from "./appearance";
import {
  canQueryLocalFonts,
  loadedLocalFontFamilies,
  localFontFamilies,
  savedLocalFontFamilies,
} from "./local-fonts";
import type { ReadingMode } from "./translation/reading-mode";

type SetTheme = (patch: Partial<ReaderTheme>) => void;

const LOAD_FONTS = "\u0000load-local-fonts";

/** Source and translation text settings, laid out as matching sections. */
export function ReadingTextControls({
  theme,
  setTheme,
  docType,
  readingMode,
}: {
  theme: ReaderTheme;
  setTheme: SetTheme;
  docType: "pdf" | "epub";
  readingMode: ReadingMode;
}) {
  const [installed, setInstalled] = useState(loadedLocalFontFamilies);
  // Show the list read on an earlier launch without querying the system again.
  useEffect(() => {
    if (installed.length) return;
    let current = true;
    void savedLocalFontFamilies().then(
      (list) => current && list.length > 0 && setInstalled(list),
    );
    return () => {
      current = false;
    };
  }, [installed.length]);
  const [loading, setLoading] = useState(false);
  const loadFonts = async () => {
    setLoading(true);
    try {
      const found = await localFontFamilies();
      setInstalled(found);
      if (!found.length) toast.info("没有读取到本机字体");
      return found.length > 0;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setLoading(false);
    }
  };
  const fonts = { installed, loading, loadFonts };
  const zoom = typeof theme.zoom === "number" ? theme.zoom : undefined;
  const translationSize = theme.translationFontSize ?? 1;
  const assistantSize = theme.assistantFontScale ?? 1;
  // Reflowed PDF text renders its source like EPUB text, so it takes the same
  // source font settings.
  const reflowed = docType === "epub" || theme.textReflow === true;
  // PDF source mode shows only the page canvas, which has no text layout.
  const showLayout = docType === "epub" || readingMode !== "source";
  return (
    <div className="space-y-4">
      <Section title="原文">
        {reflowed ? (
          <>
            <FontRow
              label="原文"
              family={theme.fontFamily}
              preview={sourceFont}
              onFamily={(fontFamily) => setTheme({ fontFamily })}
              bold={theme.fontWeight === "bold"}
              onBold={(bold) =>
                setTheme({ fontWeight: bold ? "bold" : "normal" })
              }
              fonts={fonts}
            />
            <SizeRow
              label="原文字号"
              min={70}
              max={200}
              value={epubSizePercent(theme.fontSize)}
              onValue={(value) => setTheme({ fontSize: epubFontSize(value) })}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setTheme({ fontSize: defaultTheme.fontSize })}
                >
                  恢复
                </Button>
              }
            />
          </>
        ) : (
          <SizeRow
            label="原文缩放"
            title="缩放"
            min={50}
            max={300}
            value={zoom === undefined ? 100 : Math.round(zoom * 100)}
            display={zoom === undefined ? "自动" : undefined}
            onValue={(value) => setTheme({ zoom: value / 100 })}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTheme({ zoom: "width" })}
              >
                适宽
              </Button>
            }
          />
        )}
      </Section>
      <Separator />
      <Section title="译文">
        <FontRow
          label="译文"
          family={
            theme.translationFontFamily ??
            defaultTheme.translationFontFamily ??
            "serif"
          }
          preview={translationFont}
          onFamily={(translationFontFamily) =>
            setTheme({ translationFontFamily })
          }
          bold={
            (theme.translationFontWeight ??
              defaultTheme.translationFontWeight) === "bold"
          }
          onBold={(bold) =>
            setTheme({ translationFontWeight: bold ? "bold" : "normal" })
          }
          fonts={fonts}
        />
        <SizeRow
          label="译文字号"
          min={80}
          max={160}
          value={Math.round(translationSize * 100)}
          onValue={(value) => setTheme({ translationFontSize: value / 100 })}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTheme({ translationFontSize: 1 })}
            >
              恢复
            </Button>
          }
        />
      </Section>
      <Separator />
      <Section title="Agent">
        <FontRow
          label="Agent "
          family={theme.assistantFontFamily ?? "sans-serif"}
          preview={translationFont}
          onFamily={(assistantFontFamily) => setTheme({ assistantFontFamily })}
          bold={theme.assistantFontWeight === "bold"}
          onBold={(bold) =>
            setTheme({ assistantFontWeight: bold ? "bold" : "normal" })
          }
          fonts={fonts}
        />
        <SizeRow
          label="Agent 字号"
          min={80}
          max={160}
          value={Math.round(assistantSize * 100)}
          onValue={(value) => setTheme({ assistantFontScale: value / 100 })}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTheme({ assistantFontScale: 1 })}
            >
              恢复
            </Button>
          }
        />
      </Section>
      {showLayout && (
        <>
          <Separator />
          <Section title="版面">
            <SizeRow
              label="边距"
              title="边距"
              min={READING_MARGIN.min}
              max={READING_MARGIN.max}
              step={READING_MARGIN.step}
              value={theme.readingMargin}
              display={`${theme.readingMargin}`}
              onValue={(readingMargin) => setTheme({ readingMargin })}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setTheme({ readingMargin: defaultTheme.readingMargin })
                  }
                >
                  恢复
                </Button>
              }
            />
            <SizeRow
              label="行距"
              title="行距"
              min={1.4}
              max={2.2}
              step={0.1}
              value={theme.lineHeight}
              display={theme.lineHeight.toFixed(1)}
              onValue={(value) =>
                setTheme({ lineHeight: Math.round(value * 10) / 10 })
              }
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setTheme({ lineHeight: defaultTheme.lineHeight })
                  }
                >
                  恢复
                </Button>
              }
            />
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
        {children}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="text-sm">{label}</span>
      {children}
    </>
  );
}

function SizeRow({
  label,
  title = "字号",
  min,
  max,
  step = 5,
  value,
  display,
  onValue,
  action,
}: {
  label: string;
  title?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  display?: string;
  onValue: (value: number) => void;
  action: ReactNode;
}) {
  return (
    <Row label={title}>
      <div className="flex min-w-0 items-center gap-2">
        <Slider
          className="reading-appearance-slider min-w-0 flex-1"
          thumbLabel={label}
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={(next) =>
            onValue(Array.isArray(next) ? next[0] : next)
          }
        />
        <span className="w-9 shrink-0 text-right text-xs tabular-nums">
          {display ?? `${value}%`}
        </span>
        {action}
      </div>
    </Row>
  );
}

/** Font family selector whose last option reads installed fonts, plus bold. */
function FontRow({
  label,
  family,
  preview,
  onFamily,
  bold,
  onBold,
  fonts: { installed, loading, loadFonts },
}: {
  label: string;
  family: string;
  preview: (family: string) => string;
  onFamily: (family: string) => void;
  bold: boolean;
  onBold: (bold: boolean) => void;
  fonts: {
    installed: string[];
    loading: boolean;
    loadFonts: () => Promise<boolean>;
  };
}) {
  const [open, setOpen] = useState(false);
  // A saved font stays selectable before the installed list is read.
  const list =
    family === "serif" || family === "sans-serif" || installed.includes(family)
      ? installed
      : [family, ...installed];
  const canLoad = canQueryLocalFonts();
  return (
    <Row label="字体">
      <div className="flex min-w-0 gap-2">
        <Select
          value={family}
          open={open}
          onOpenChange={setOpen}
          onValueChange={(value) => {
            if (value === LOAD_FONTS) {
              void loadFonts().then((found) => found && setOpen(true));
              return;
            }
            if (value) onFamily(value as string);
          }}
        >
          <SelectTrigger
            size="sm"
            className="min-w-0 flex-1"
            aria-label={`${label}字体`}
          >
            <SelectValue>
              <span
                className="truncate"
                style={{ fontFamily: preview(family) }}
              >
                {translationFontLabel(family)}
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem
              value="sans-serif"
              style={{ fontFamily: preview("sans-serif") }}
            >
              黑体 / 无衬线
            </SelectItem>
            <SelectItem value="serif" style={{ fontFamily: preview("serif") }}>
              宋体 / 衬线
            </SelectItem>
            {list.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>本机字体</SelectLabel>
                  {list.map((name) => (
                    <SelectItem
                      key={name}
                      value={name}
                      style={{ fontFamily: preview(name) }}
                    >
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}
            {canLoad && (
              <>
                <SelectSeparator />
                <SelectItem value={LOAD_FONTS} disabled={loading}>
                  {loading
                    ? "正在读取本机字体…"
                    : installed.length
                      ? "重新读取本机字体…"
                      : "读取本机字体…"}
                </SelectItem>
              </>
            )}
          </SelectContent>
        </Select>
        <Toggle
          size="sm"
          variant="outline"
          className="shrink-0"
          aria-label={`${label}加粗`}
          pressed={bold}
          onPressedChange={onBold}
        >
          <Bold />
        </Toggle>
      </div>
    </Row>
  );
}
