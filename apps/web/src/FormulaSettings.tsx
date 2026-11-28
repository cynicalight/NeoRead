import type { ReaderTheme } from "@neoread/core";
import { Slider } from "@neoread/ui/components/slider";

/** PDF formula-to-LaTeX workers in the reading settings; 0 turns conversion off. */
export function FormulaSettings({
  theme,
  setTheme,
}: {
  theme: ReaderTheme;
  setTheme: (patch: Partial<ReaderTheme>) => void;
}) {
  const workers = theme.formulaConcurrency ?? 3;
  const label = (value: number) =>
    value === 0 ? "不转换公式" : `同时转换 ${value} 个公式`;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-4 text-sm">
        <h3 className="font-medium">公式转换并发数</h3>
        <span className="rounded bg-muted px-2 py-0.5 tabular-nums">
          {workers === 0 ? "关闭" : workers}
        </span>
      </div>
      <Slider
        thumbLabel="公式转换并发数"
        thumbAlignment="center"
        min={0}
        max={5}
        step={1}
        value={[workers]}
        getAriaValueText={(_, value) => label(value)}
        onValueChange={(value) =>
          setTheme({
            formulaConcurrency: Array.isArray(value) ? value[0] : value,
          })
        }
      />
    </section>
  );
}
