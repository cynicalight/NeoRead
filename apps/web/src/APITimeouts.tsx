import type { APIModelOverride, APIConnection } from "@reader/core";
import { Input } from "@reader/ui/components/input";
export const runtimeTimeoutFields = [
  ["firstOutputTimeoutSeconds", "首个输出时限（秒）", 3600],
  ["idleTimeoutSeconds", "空闲时限（秒）", 3600],
  ["totalTimeoutSeconds", "总时限（秒）", 7200],
] as const;
export const modelTimeoutFields = [
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
  fields: readonly (readonly [
    keyof Omit<APIModelOverride, "pricing">,
    string,
    number,
  ])[];
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
  onChange,
}: {
  model: string;
  value?: APIModelOverride;
  inherited: APIConnection;
  disabled: boolean;
  onChange: (value: APIModelOverride) => void;
}) {
  const draft = value ?? {};
  return (
    <details className="w-full text-xs text-muted-foreground">
      <summary className="cursor-pointer py-1">检测与生成时限</summary>
      <div className="space-y-2 pb-2">
        <TimeoutFields
          fields={modelTimeoutFields}
          value={draft}
          onChange={onChange}
          disabled={disabled}
          inherited={inherited}
          prefix={`${model} `}
        />
        <p>留空或 0 继承提供商设置</p>
      </div>
    </details>
  );
}
