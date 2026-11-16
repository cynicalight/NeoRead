import { Check, CheckSquare } from "lucide-react";
import { Button } from "@neoread/ui/components/button";

/** Batch selection toggle floating at the bottom right of a library body. */
export function LibraryBatchButton({
  active,
  disabled,
  onToggle,
}: {
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      size="icon-lg"
      variant={active ? "default" : "outline"}
      className="library-batch-fab"
      aria-label={active ? "完成" : "批量"}
      title={active ? "完成" : "批量"}
      aria-pressed={active}
      disabled={disabled}
      onClick={onToggle}
    >
      {active ? <Check /> : <CheckSquare />}
    </Button>
  );
}
