import { useEffect, useId, useState } from "react";
import { Button } from "@reader/ui/components/button";
import { Textarea } from "@reader/ui/components/textarea";

export function TranslationPromptSettings({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="mt-4 space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        翻译提示词
      </label>
      <Textarea
        id={id}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={disabled}
        maxLength={6000}
        rows={4}
        placeholder="例如：用自然流畅的中文翻译，保留关键英文术语。"
        aria-describedby={`${id}-help`}
      />
      <p id={`${id}-help`} className="text-xs leading-5 text-muted-foreground">
        补充翻译风格和术语要求。留空使用默认规则；已完成的译文需重新翻译才会应用。
      </p>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || !value}
          onClick={async () => {
            if (await onSave("")) setDraft("");
          }}
        >
          恢复默认
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || draft.trim() === value}
          onClick={() => void onSave(draft.trim())}
        >
          保存提示词
        </Button>
      </div>
    </div>
  );
}
