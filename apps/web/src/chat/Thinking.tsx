import { useState } from "react";
import { Brain } from "lucide-react";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@neoread/ui/components/trace";

export function Thinking({
  text,
  active,
  incomplete = false,
}: {
  text: string;
  active: boolean;
  incomplete?: boolean;
}) {
  const [open, setOpen] = useState<boolean>();
  return (
    <Trace className="mb-2">
      <TraceCollapsible open={open ?? active} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={active ? "running" : undefined}>
            <TraceIcon>
              <Brain />
            </TraceIcon>
            <TraceTitle>
              {active
                ? "正在思考…"
                : incomplete
                  ? "思考过程（未完成）"
                  : "思考过程"}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="max-h-80 overflow-y-auto text-sm whitespace-pre-wrap [overflow-wrap:anywhere] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {text}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
