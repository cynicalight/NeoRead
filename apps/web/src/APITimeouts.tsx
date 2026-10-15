import { useEffect, useState } from "react";
import type { APIModelOverride, APIConnection } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Input } from "@reader/ui/components/input";
export const runtimeTimeoutFields = [
  ["firstOutputTimeoutSeconds", "首个输出时限（秒）", 3600],
  ["idleTimeoutSeconds", "空闲时限（秒）", 3600],
  ["totalTimeoutSeconds", "总时限（秒）", 7200],
] as const;
const modelTimeoutFields = [
  ["textProbeTimeoutSeconds", "文本检测时限（秒）", 600],
  ["visionProbeTimeoutSeconds", "图片检测时限（秒）", 600],
  ...runtimeTimeoutFields,
] as const;
export function TimeoutFields({
  fields,
  value,
  onChange,
  disabled,
  inherited,
  prefix = "",
}: {
  fields: readonly (readonly [keyof APIModelOverride, string, number])[];
  value: APIModelOverride;
  onChange: (value: APIModelOverride) => void;
  disabled: boolean;
  inherited?: APIConnection;
  prefix?: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {fields.map(([field, label, max]) => (
        <label key={field} className="space-y-1 text-xs text-muted-foreground">
          {label}
          <Input
            aria-label={`${prefix}${label}`}
            type="number"
            min={0}
            max={max}
            step={1}
            disabled={disabled}
            value={value[field] || ""}
            placeholder={String(
              inherited?.[field] ||
                (field === "textProbeTimeoutSeconds"
                  ? 45
                  : field === "visionProbeTimeoutSeconds"
                    ? 90
                    : field === "totalTimeoutSeconds"
                      ? "180 / 600"
                      : "不限"),
            )}
            onChange={(event) =>
              onChange({
                ...value,
                [field]:
                  event.target.value === ""
                    ? undefined
                    : Number(event.target.value),
              })
            }
          />
          {inherited && (
            <span>
              继承{" "}
              {inherited[field] ||
                (field === "textProbeTimeoutSeconds"
                  ? 45
                  : field === "visionProbeTimeoutSeconds"
                    ? 90
                    : field === "totalTimeoutSeconds"
                      ? "180 / 600"
                      : "不限")}
            </span>
          )}
        </label>
      ))}
    </div>
  );
}
export function ModelTimeoutForm({
  model,
  value,
  inherited,
  disabled,
  onSave,
}: {
  model: string;
  value?: APIModelOverride;
  inherited: APIConnection;
  disabled: boolean;
  onSave: (value: APIModelOverride) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<APIModelOverride>(value ?? {});
  useEffect(() => setDraft(value ?? {}), [value]);
  const valid = modelTimeoutFields.every(
    ([field, , max]) =>
      Number.isInteger(draft[field] || 0) &&
      (draft[field] || 0) >= 0 &&
      (draft[field] || 0) <= max,
  );
  return (
    <details className="w-full text-xs text-muted-foreground">
      <summary className="cursor-pointer py-1">模型时限覆盖</summary>
      <form
        className="space-y-2 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void onSave(draft);
        }}
      >
        <TimeoutFields
          fields={modelTimeoutFields}
          value={draft}
          onChange={setDraft}
          disabled={disabled}
          inherited={inherited}
          prefix={`${model} `}
        />
        <p>留空或 0 继承提供商设置</p>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={disabled || !valid}
        >
          保存模型时限
        </Button>
      </form>
    </details>
  );
}
