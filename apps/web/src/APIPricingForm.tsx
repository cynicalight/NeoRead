import type { APIPricing } from "@reader/core";
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
  model,
  disabled,
  onChange,
}: {
  value?: APIPricing;
  model: string;
  disabled: boolean;
  onChange: (value: APIPricing) => void;
}) {
  const draft = value ?? { currency: "CNY" };
  const setDraft = onChange;
  return (
    <section
      className="space-y-2 text-xs text-muted-foreground"
      aria-label={`${model} 价格`}
    >
      <h4 className="font-medium">模型价格</h4>
      <div className="space-y-2 pb-2">
        <Select
          value={draft.currency}
          disabled={disabled}
          onValueChange={(currency) => {
            if (currency === "CNY" || currency === "USD")
              setDraft({ currency });
          }}
        >
          <SelectTrigger aria-label={`${model} 价格币种`}>
            <SelectValue>{draft.currency || "选择币种"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="CNY">CNY</SelectItem>
            <SelectItem value="USD">USD</SelectItem>
          </SelectContent>
        </Select>
        <div className="grid grid-cols-2 gap-2">
          {fields.map(([field, label]) => (
            <label key={field} className="space-y-1">
              {label}价格
              <Input
                aria-label={`${model} ${label}价格`}
                type="number"
                min={0}
                step="any"
                disabled={disabled}
                value={draft[field] ?? ""}
                placeholder="未知"
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
            </label>
          ))}
        </div>
        <p>每 100 万 token · 留空表示未知 · 0 表示免费</p>
        <p>切换币种会清空此模型的价格</p>
      </div>
    </section>
  );
}
