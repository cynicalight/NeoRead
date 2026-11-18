import { Button } from "@neoread/ui/components/button";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { useCustomPrompts } from "./custom-prompts";
export function CustomPrompts({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (prompt: string) => void;
}) {
  const prompts = useCustomPrompts();
  return (
    <>
      {prompts.map((p) => (
        <Button
          key={p.id}
          variant="outline"
          className="suggestion"
          disabled={disabled}
          title={p.description}
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
