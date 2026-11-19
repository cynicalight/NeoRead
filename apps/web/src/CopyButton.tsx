import {
  useEffect,
  useState,
  type ComponentProps,
  type MouseEvent,
} from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@neoread/ui/components/button";

const COPIED_MS = 1500;

/** Icon-only copy button; a successful copy briefly turns it into a green check. */
export function CopyButton({
  label = "复制",
  onCopy,
  size = "icon-xs",
  variant = "ghost",
  iconClassName,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick" | "children"> & {
  label?: string;
  /** Resolves false when the copy failed; the copy helper reports the error. */
  onCopy: (event: MouseEvent<HTMLButtonElement>) => boolean | Promise<boolean>;
  iconClassName?: string;
}) {
  // Counts copies so a repeated click restarts the hold and replays the check.
  const [copied, setCopied] = useState(0);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(0), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const current = copied ? "已复制" : label;
  return (
    <Button
      size={size}
      variant={variant}
      aria-label={current}
      title={current}
      {...props}
      onClick={async (event) => {
        if (await onCopy(event)) setCopied((count) => count + 1);
      }}
    >
      {copied ? (
        <Check
          key={copied}
          aria-hidden="true"
          className={`chat-copy-check text-emerald-600 dark:text-emerald-400 ${iconClassName ?? ""}`}
        />
      ) : (
        <Copy aria-hidden="true" className={iconClassName} />
      )}
    </Button>
  );
}
