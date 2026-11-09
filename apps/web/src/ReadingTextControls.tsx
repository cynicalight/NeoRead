import { useEffect, useState, type ReactNode } from "react";
import { Bold, Minus, Plus } from "lucide-react";
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

type SetTheme = (patch: Partial<ReaderTheme>) => void;

const LOAD_FONTS = "\u0000load-local-fonts";

/** Source and translation text settings, laid out as matching sections. */
export function ReadingTextControls({
  theme,
  setTheme,
  docType,
}: {
  theme: ReaderTheme;
  setTheme: SetTheme;
  docType: "pdf" | "epub";
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
  // source font settings and one margin for the whole column.
  const reflowed = docType === "epub" || theme.textReflow === true;
  const margin =
    docType === "epub"
      ? theme.margin
      : (theme.pdfTranslationMargin ?? READING_MARGIN.default);
  // EPUB margins frame the whole page; PDF margins only shape the translation.
  const marginRow = (
    <StepRow
      label="边距"
      title={reflowed ? "边距" : "译文边距"}
      value={margin}
      display={`${margin}`}
      min={READING_MARGIN.min}
      max={READING_MARGIN.max}
      step={READING_MARGIN.step}
      onValue={(value) =>
        setTheme(
          docType === "epub"
            ? { margin: value }
            : { pdfTranslationMargin: value },
        )
      }
      reset={READING_MARGIN.default}
    />
  );
  return (
    <div className="space-y-4">
      {reflowed && (
        <>
          <Section title="版面">{marginRow}</Section>
          <Separator />
        </>
      )}
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
            <StepRow
              label="行距"
              value={theme.lineHeight}
              display={theme.lineHeight.toFixed(1)}
              min={1.4}
              max={2.2}
              step={0.2}
              onValue={(lineHeight) => setTheme({ lineHeight })}
              reset={defaultTheme.lineHeight}
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
        {!reflowed && marginRow}
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
  value,
  display,
  onValue,
  action,
}: {
  label: string;
  title?: string;
  min: number;
  max: number;
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
          step={5}
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

/** A value stepped within a range, with the same layout as SizeRow. */
function StepRow({
  label,
  title = label,
  value,
  display,
  min,
  max,
  step,
  onValue,
  reset,
}: {
  label: string;
  title?: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onValue: (value: number) => void;
  reset: number;
}) {
  // Step onto the grid, so off-grid saved values (40) reach 32 or 48.
  const move = (direction: number) => {
    const units = value / step;
    const next =
      (direction > 0
        ? Math.floor(units + 1e-6) + 1
        : Math.ceil(units - 1e-6) - 1) * step;
    onValue(Math.round(Math.min(max, Math.max(min, next)) * 100) / 100);
  };
  return (
    <Row label={label}>
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`减小${title}`}
            disabled={value <= min}
            onClick={() => move(-1)}
          >
            <Minus />
          </Button>
          <span
            className="min-w-0 truncate text-center text-xs tabular-nums"
            aria-label={title}
          >
            {display}
          </span>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label={`增大${title}`}
            disabled={value >= max}
            onClick={() => move(1)}
          >
            <Plus />
          </Button>
        </div>
        <Button size="sm" variant="outline" onClick={() => onValue(reset)}>
          恢复
        </Button>
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
