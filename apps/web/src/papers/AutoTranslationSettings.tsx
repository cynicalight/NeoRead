import type { ReaderTheme } from "@reader/core";
import { Slider } from "@reader/ui/components/slider";

export function AutoTranslationSettings({
  theme,
  setTheme,
}: {
  theme: ReaderTheme;
  setTheme: (patch: Partial<ReaderTheme>) => void;
}) {
  const limit =
    theme.autoTranslateMaxPages ?? (theme.autoTranslatePDF === false ? 0 : 50);
  return (
    <div className="mt-5 space-y-3 text-sm">
      <h4 className="font-medium">自动翻译</h4>
      <p>
        {limit === 0 ? (
          "所有论文全部手动翻译"
        ) : (
          <>
            论文超过{" "}
            <span className="rounded bg-muted px-2 py-0.5 tabular-nums">
              {limit}
            </span>{" "}
            页则取消自动翻译。
          </>
        )}
      </p>
      <Slider
        thumbLabel="自动翻译页数上限"
        // Position directly from the value before the settings panel has measurable dimensions.
        thumbAlignment="center"
        min={0}
        max={150}
        step={10}
        value={[limit]}
        getAriaValueText={(_, value) =>
          value === 0 ? "所有论文全部手动翻译" : `超过 ${value} 页则手动翻译`
        }
        onValueChange={(value) =>
          setTheme({
            autoTranslateMaxPages: Array.isArray(value) ? value[0] : value,
          })
        }
      />
    </div>
  );
}
