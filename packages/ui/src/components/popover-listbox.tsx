import type { ComponentProps } from "react";
import { cn } from "@neoread/ui/lib/utils";
import { PopoverContent } from "@neoread/ui/components/popover";

/** A non-focus-stealing popup for a text field that owns listbox navigation. */
export function PopoverListbox({
  className,
  ...props
}: Omit<ComponentProps<typeof PopoverContent>, "role" | "initialFocus" | "finalFocus">) {
  return (
    <PopoverContent
      {...props}
      role="listbox"
      initialFocus={false}
      finalFocus={false}
      className={cn(
        "block max-h-[min(16rem,var(--available-height))] w-(--anchor-width) max-w-(--available-width) overflow-y-auto overscroll-contain p-1 [scrollbar-width:none] data-open:animate-none data-closed:animate-none",
        className,
      )}
    />
  );
}
