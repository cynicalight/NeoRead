import { Check } from "lucide-react";
import type { ReaderTheme } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@reader/ui/components/tabs";
import {
  appearanceChoice,
  appearanceChoices,
  chooseAppearance,
  type AppearanceChoice,
} from "./appearance";

/** Tabs in compact popovers; a button row where every panel stays mounted,
    since each tab indicator measures layout on render. */
function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
  buttons,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
  buttons: boolean;
}) {
  if (buttons)
    return (
      <div role="group" aria-label={label} className="flex flex-wrap gap-2">
        {options.map(([option, text]) => (
          <Button
            key={option}
            aria-pressed={value === option}
            variant={value === option ? "default" : "outline"}
            onClick={() => onChange(option)}
          >
            {text}
            {value === option && <Check className="size-3" />}
          </Button>
        ))}
      </div>
    );
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
  buttons = false,
}: {
  theme: ReaderTheme;
  setTheme: (patch: Partial<ReaderTheme>) => void;
  buttons?: boolean;
}) {
  const choice = appearanceChoice(theme);
  return (
    <div className="space-y-3">
      <Choices<AppearanceChoice>
        label="配色"
        value={choice}
        options={appearanceChoices}
        onChange={(value) => setTheme(chooseAppearance(value))}
        buttons={buttons}
      />
      {choice === "system" && (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <span className="text-sm text-muted-foreground">系统浅色时</span>
          <Choices
            label="系统浅色时的配色"
            value={theme.systemLightMode ?? "light"}
            options={[
              ["light", "浅色"],
              ["sepia", "纸张"],
            ]}
            onChange={(systemLightMode) => setTheme({ systemLightMode })}
            buttons={buttons}
          />
          <span className="text-sm text-muted-foreground">系统深色时</span>
          <Choices
            label="系统深色时的配色"
            value={theme.systemDarkContrast ?? "soft"}
            options={[
              ["soft", "石墨"],
              ["high", "纯黑"],
            ]}
            onChange={(systemDarkContrast) => setTheme({ systemDarkContrast })}
            buttons={buttons}
          />
        </div>
      )}
    </div>
  );
}
