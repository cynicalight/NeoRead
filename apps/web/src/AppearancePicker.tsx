import type { ReaderTheme } from "@neoread/core";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
import {
  appearanceChoice,
  appearanceChoices,
  chooseAppearance,
  type AppearanceChoice,
} from "./appearance";

/** Shared shadcn tabs for settings and reader popovers. */
function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as T);
      }}
    >
      <TabsList className="w-full" aria-label={label}>
        {options.map(([option, text]) => (
          <TabsTrigger key={option} value={option}>
            {text}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** The five appearances; following the system asks which light and dark palettes to use. */
export function AppearancePicker({
  theme,
  setTheme,
  layout = "compact",
}: {
  theme: ReaderTheme;
  layout?: "compact" | "settings";
  setTheme: (patch: Partial<ReaderTheme>) => void;
}) {
  const choice = appearanceChoice(theme);
  return (
    <div className="space-y-3">
      <div
        className={
          layout === "settings"
            ? "grid grid-cols-2 items-center gap-3"
            : undefined
        }
      >
        {layout === "settings" && (
          <h3 className="shrink-0 text-sm font-medium">界面主题</h3>
        )}
        <div className={layout === "settings" ? "min-w-0" : undefined}>
          <Choices<AppearanceChoice>
            label="配色"
            value={choice}
            options={appearanceChoices}
            onChange={(value) => setTheme(chooseAppearance(value))}
          />
        </div>
      </div>
      {choice === "system" && (
        <div
          className={
            layout === "settings" ? "grid grid-cols-2 gap-3" : "space-y-2"
          }
        >
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">系统浅色时</span>
            <Choices
              label="系统浅色时的配色"
              value={theme.systemLightMode ?? "light"}
              options={[
                ["light", "浅色"],
                ["sepia", "纸张"],
              ]}
              onChange={(systemLightMode) => setTheme({ systemLightMode })}
            />
          </div>
          <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">系统深色时</span>
            <Choices
              label="系统深色时的配色"
              value={theme.systemDarkContrast ?? "soft"}
              options={[
                ["soft", "石墨"],
                ["high", "纯黑"],
              ]}
              onChange={(systemDarkContrast) =>
                setTheme({ systemDarkContrast })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
