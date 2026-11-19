import { useRef, type ComponentProps, type Ref } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { cn } from "@neoread/ui/lib/utils";

type SearchInputProps = Omit<ComponentProps<typeof Input>, "value" | "ref"> & {
  value: string;
  /** Empties the query; the field keeps focus so the next search can be typed. */
  onClear: () => void;
  ref?: Ref<HTMLInputElement>;
  wrapperClassName?: string;
  /** Sidebar style: a leading search icon and compact text. */
  icon?: boolean;
};

/**
 * A search field with a floating clear button. Focusing it, including when its
 * panel or dialog reopens, selects the previous query so typing replaces it.
 */
export function SearchInput({
  value,
  onClear,
  ref,
  className,
  wrapperClassName,
  icon = false,
  onFocus,
  onMouseDown,
  onMouseUp,
  disabled,
  ...props
}: SearchInputProps) {
  const input = useRef<HTMLInputElement | null>(null);
  // A click that focuses the field would collapse the selection on mouseup.
  const focusingClick = useRef(false);
  return (
    <div
      className={cn("search-input relative min-w-0", wrapperClassName)}
      data-icon={icon ? "" : undefined}
    >
      {icon && <Search aria-hidden="true" />}
      <Input
        {...props}
        ref={(node) => {
          input.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        value={value}
        disabled={disabled}
        className={cn(value && "pr-7", className)}
        onMouseDown={(event) => {
          focusingClick.current =
            document.activeElement !== event.currentTarget;
          onMouseDown?.(event);
        }}
        onMouseUp={(event) => {
          if (focusingClick.current) event.preventDefault();
          focusingClick.current = false;
          onMouseUp?.(event);
        }}
        onFocus={(event) => {
          event.currentTarget.select();
          onFocus?.(event);
        }}
      />
      {value && !disabled && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="清空搜索"
          className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
          // Keep focus in the field instead of moving it to the button.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onClear();
            input.current?.focus();
          }}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
