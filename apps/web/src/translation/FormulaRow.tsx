import type { ReactNode } from "react";

export function FormulaRow({
  children,
  number,
}: {
  children: ReactNode;
  number?: string;
}) {
  return (
    <div className="translation-formula-row">
      <div className="translation-formula-content">{children}</div>
      {number && (
        <span className="translation-formula-number" data-copy-ignore="">
          {number}
        </span>
      )}
    </div>
  );
}
