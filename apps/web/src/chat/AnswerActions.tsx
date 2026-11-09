import { useEffect, useRef, useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import { copyText } from "./clipboard";

const messageTimeFormat = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
export const COPIED_HOLD_MS = 3000;

/** Copy, optional regenerate and time row under an answer. After a copy it stays up for 3s, then hides until the pointer leaves the answer. */
export function AnswerActions({
  content,
  timestamp,
  onRegenerate,
  regenerateDisabled = false,
  status,
}: {
  content: string;
  timestamp?: Date;
  onRegenerate?: () => void;
  regenerateDisabled?: boolean;
  /** Failure or recovery text shown after the buttons; keeps the row visible. */
  status?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Counts copies so a repeated click restarts the hold and replays the check animation.
  const [copied, setCopied] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(0);
      setDismissed(true);
    }, COPIED_HOLD_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    const message = dismissed && ref.current?.closest(".chat-message");
    if (!message) return;
    const reset = () => setDismissed(false);
    message.addEventListener("pointerleave", reset);
    return () => message.removeEventListener("pointerleave", reset);
  }, [dismissed]);
  return (
    <div
      ref={ref}
      className="chat-message-actions"
      data-copied={copied ? "" : undefined}
      data-dismissed={dismissed ? "" : undefined}
      data-status={status ? "" : undefined}
    >
      {content && (
        <Button
          size="icon-xs"
          variant="ghost"
          className="chat-copy-button"
          aria-label={copied ? "已复制" : "复制回答"}
          title={copied ? "已复制" : "复制回答"}
          onClick={async () => {
            if (!(await copyText(content))) return;
            setDismissed(false);
            setCopied((count) => count + 1);
          }}
        >
          {copied ? (
            <Check
              key={copied}
              aria-hidden="true"
              className="chat-copy-check text-emerald-600 dark:text-emerald-400"
            />
          ) : (
            <Copy aria-hidden="true" />
          )}
        </Button>
      )}
      {onRegenerate && (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="重新生成"
          title="重新生成"
          disabled={regenerateDisabled}
          onClick={onRegenerate}
        >
          <RotateCcw aria-hidden="true" />
        </Button>
      )}
      {status && (
        <span role="status" className="chat-action-status">
          {status}
        </span>
      )}
      {timestamp && !Number.isNaN(timestamp.getTime()) && (
        <time
          dateTime={timestamp.toISOString()}
          title={timestamp.toLocaleString()}
        >
          {messageTimeFormat.format(timestamp)}
        </time>
      )}
    </div>
  );
}
