import { Button } from "@neoread/ui/components/button";
import { ArrowLeft, MessageSquare } from "lucide-react";
import {
  maxPromptBytes,
  promptBytes,
  useCustomPrompts,
} from "./custom-prompts";
export function CustomPrompts({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (prompt: string) => void;
}) {
  const { prompts, loading, saving } = useCustomPrompts();
  return (
    <>
      {prompts.map((p) => (
        <Button
          key={p.id}
          variant="outline"
          className="suggestion"
          disabled={
            disabled ||
            loading ||
            saving ||
            promptBytes(p.prompt) > maxPromptBytes
          }
          title={
            promptBytes(p.prompt) > maxPromptBytes
              ? "提示词超过 16,000 UTF-8 字节，请在设置中缩短后使用。"
              : p.description
          }
          onClick={() => onSend(p.prompt)}
        >
          <MessageSquare />
          <span className="min-w-0 truncate">{p.description}</span>
          <ArrowLeft className="ml-auto rotate-180" />
        </Button>
      ))}
    </>
  );
}
