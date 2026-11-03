import { useLayoutEffect, useState, type RefObject } from "react";
import { Send } from "lucide-react";
import { Button } from "@neoread/ui/components/button";

/** Even the first character only changes this control, not the reader tree. */
export function ComposerSendButton({
  prompt,
  changed,
  available,
  hasImages,
  onSend,
}: {
  prompt: RefObject<string>;
  changed: RefObject<((hasText: boolean) => void) | undefined>;
  available: boolean;
  hasImages: boolean;
  onSend: () => void;
}) {
  const [hasText, setHasText] = useState(() => !!prompt.current.trim());
  useLayoutEffect(() => {
    changed.current = setHasText;
    return () => {
      changed.current = undefined;
    };
  }, [changed]);
  return (
    <Button
      size="icon-sm"
      aria-label="发送问题"
      disabled={!available || (!hasText && !hasImages)}
      onClick={onSend}
    >
      <Send className="size-3.5" />
    </Button>
  );
}
