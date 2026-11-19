import type { ReactNode } from "react";
import { Expand, Sparkles } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import type { PDFBlockAction } from "@neoread/core";
import { CopyButton } from "./CopyButton";
// Shared by PDF layout blocks and EPUB paragraphs.
export function BlockActions<Block extends { image?: string }>({
  block,
  onAction,
}: {
  block: Block;
  onAction: (block: Block, action: PDFBlockAction) => void;
}) {
  const action = (name: PDFBlockAction, label: string, icon: ReactNode) => (
    <Button
      data-block-action={name}
      size="icon-xs"
      variant="secondary"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onAction(block, name);
      }}
    >
      {icon}
    </Button>
  );
  return (
    <div className="block-actions">
      {block.image && action("preview", "放大查看原图", <Expand />)}
      <CopyButton
        data-block-action="copy"
        variant="secondary"
        label={block.image ? "复制图片" : "复制此段"}
        onCopy={(event) => {
          event.stopPropagation();
          // The host copies asynchronously and reports failures itself.
          onAction(block, "copy");
          return true;
        }}
      />
      {action(
        "explain",
        block.image ? "AI 解释此图" : "询问 AI 此段",
        <Sparkles />,
      )}
    </div>
  );
}
