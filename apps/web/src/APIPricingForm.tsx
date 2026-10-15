import { useEffect, useState } from "react";
import type { APIPricing } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Input } from "@reader/ui/components/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@reader/ui/components/select";
const fields = [
  ["input", "输入"],
  ["output", "输出"],
  ["cacheRead", "缓存读取"],
  ["cacheWrite", "缓存写入"],
] as const;
export function APIPricingForm({
  value,
  inherited,
  model,
  disabled,
  onSave,
}: {
  value?: APIPricing;
  inherited?: APIPricing;
  model?: string;
  disabled: boolean;
  onSave: (value: APIPricing) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<APIPricing>(
    value ?? (model ? {} : { currency: "CNY" }),
  );
  useEffect(
    () => setDraft(value ?? (model ? {} : { currency: "CNY" })),
    [value, model],
  );
  const currency = draft.currency ?? inherited?.currency;
  const compatible = inherited?.currency === currency;
  const valid = fields.every(
    ([field]) =>
      draft[field] === undefined ||
      (Number.isFinite(draft[field]) && draft[field]! >= 0),
  );
  const prefix = model ?? "提供商";
  return (
    <details className="w-full text-xs text-muted-foreground motion-safe:animate-in motion-safe:fade-in">
      <summary className="cursor-pointer py-2">
        {model ? "模型价格覆盖" : "提供商默认价格"}
      </summary>
      <form
        className="space-y-2 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid)
            void onSave({
              ...draft,
              currency:
                draft.currency ??
                (fields.some(([field]) => draft[field] !== undefined)
                  ? inherited?.currency
                  : undefined),
            });
        }}
      >
        <Select
          value={draft.currency ?? "inherit"}
          disabled={disabled}
          onValueChange={(value) => {
            // A currency switch clears this form's amounts rather than relabeling them.
            setDraft(
              value === "inherit" ? {} : { currency: value as "CNY" | "USD" },
            );
          }}
        >
          <SelectTrigger aria-label={`${prefix} 价格币种`}>
            <SelectValue>{currency ?? "继承提供商币种"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {model && <SelectItem value="inherit">继承提供商币种</SelectItem>}
            <SelectItem value="CNY">CNY</SelectItem>
            <SelectItem value="USD">USD</SelectItem>
          </SelectContent>
        </Select>
        <div className="grid grid-cols-2 gap-2">
          {fields.map(([field, label]) => (
            <label key={field} className="space-y-1">
              {label}价格
              <Input
                aria-label={`${prefix} ${label}价格`}
                type="number"
                min={0}
                step="any"
                disabled={disabled}
                value={draft[field] ?? ""}
                placeholder={
                  model && compatible && inherited?.[field] !== undefined
                    ? `继承 ${inherited[field]}`
                    : "未知"
                }
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    [field]:
                      event.target.value === ""
                        ? undefined
                        : Number(event.target.value),
                  })
                }
              />
              <span>
                {draft[field] !== undefined
                  ? model
                    ? "模型覆盖"
                    : "提供商默认"
                  : model && compatible && inherited?.[field] !== undefined
                    ? `继承提供商 ${inherited[field]}`
                    : "价格未知"}
              </span>
            </label>
          ))}
        </div>
        <p>
          每 100 万 token · 留空{model ? "继承同币种默认值" : "表示未知"} · 0
          表示免费
        </p>
        <p>
          切换币种会清空当前价格，不继承其他币种的金额
          已保存的模型金额保留原币种
        </p>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={disabled || !valid}
        >
          保存{model ? "模型价格" : "默认价格"}
        </Button>
      </form>
    </details>
  );
}
