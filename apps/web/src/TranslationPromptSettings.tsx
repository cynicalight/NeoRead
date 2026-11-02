import { useEffect, useId, useState } from "react";
import { Button } from "@neoread/ui/components/button";
import { Textarea } from "@neoread/ui/components/textarea";

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
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id={`${id}-title`} className="min-w-0 text-sm font-medium">
          翻译提示词
        </h3>
        <div className="flex shrink-0 gap-2">
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
      <Textarea
        aria-labelledby={`${id}-title`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={disabled}
        maxLength={6000}
        rows={4}
        placeholder="例如：用自然流畅的中文翻译，保留关键英文术语。"
      />
    </section>
  );
}
