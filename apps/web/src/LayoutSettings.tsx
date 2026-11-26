import type { ReaderTheme } from "@neoread/core";
import { Slider } from "@neoread/ui/components/slider";

/** PDF layout parsing options in the reading settings; apply to later parses. */
export function LayoutSettings({
  theme,
  setTheme,
}: {
  theme: ReaderTheme;
  setTheme: (patch: Partial<ReaderTheme>) => void;
}) {
  const confidence = theme.layoutPanelConfidence ?? 0.35;
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">版面解析</h3>
        <p className="text-xs leading-5 text-muted-foreground">
          置信度降低可以识别到更多可能的子图
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 text-sm">
        <span>子图置信度</span>
        <span className="rounded bg-muted px-2 py-0.5 tabular-nums">
          {confidence.toFixed(2)}
        </span>
      </div>
      <Slider
        thumbLabel="子图置信度"
        thumbAlignment="center"
        min={0.2}
        max={0.5}
        step={0.05}
        value={[confidence]}
        onValueChange={(value) => {
          const next = Array.isArray(value) ? value[0] : value;
          // Avoid float steps such as 0.35000000000000003 reaching the setting.
          setTheme({ layoutPanelConfidence: Math.round(next * 100) / 100 });
        }}
      />
    </section>
  );
}
