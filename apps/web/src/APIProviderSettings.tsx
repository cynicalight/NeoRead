import { useEffect, useState } from "react";
import type { APIProvider } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Input } from "@reader/ui/components/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@reader/ui/components/select";
export function APIProviderSettings({
  providers,
  selected,
  disabled,
  onSelect,
  onAdd,
  onRename,
  onDelete,
}: {
  providers: APIProvider[];
  selected: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const provider = providers.find((p) => p.id === selected);
  const [name, setName] = useState(provider?.name ?? "");
  useEffect(
    () => setName(provider?.name ?? ""),
    [provider?.id, provider?.name],
  );
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Select
          value={selected}
          disabled={disabled}
          onValueChange={(value) => value && onSelect(value)}
        >
          <SelectTrigger aria-label="API 提供商">
            <SelectValue>{provider?.name ?? "请选择提供商"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          aria-label="添加 API 提供商"
          disabled={disabled}
          onClick={onAdd}
        >
          添加提供商
        </Button>
      </div>
      {provider && (
        <div className="flex gap-2">
          <Input
            aria-label="提供商名称"
            value={name}
            disabled={disabled}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            variant="outline"
            aria-label="保存提供商名称"
            disabled={disabled || !name.trim() || name === provider.name}
            onClick={() => onRename(name.trim())}
          >
            重命名
          </Button>
          <Button
            variant="ghost"
            aria-label="删除 API 提供商"
            disabled={disabled}
            onClick={onDelete}
          >
            删除
          </Button>
        </div>
      )}
    </div>
  );
}
export function splitModelRef(ref: string): [string, string] {
  const index = ref.indexOf("::");
  return index < 0
    ? ["default", ref]
    : [ref.slice(0, index), ref.slice(index + 2)];
}
export function modelRef(provider: string, model: string) {
  return provider === "default" && !model.includes("::")
    ? model
    : `${provider}::${model}`;
}
