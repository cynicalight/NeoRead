export type DocumentTabCommand =
  | { type: "close" | "next" | "previous" | "reopen" }
  | { type: "select"; index: number };
export function documentTabCommand(input: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}): DocumentTabCommand | null {
  if (input.altKey || input.isComposing) return null;
  if (input.ctrlKey && !input.metaKey && input.key === "Tab")
    return { type: input.shiftKey ? "previous" : "next" };
  if (!(input.ctrlKey || input.metaKey)) return null;
  if (input.shiftKey && input.key.toLowerCase() === "t")
    return { type: "reopen" };
  if (!input.shiftKey && input.key.toLowerCase() === "w")
    return { type: "close" };
  if (!input.shiftKey && /^[1-9]$/.test(input.key))
    return {
      type: "select",
      index: input.key === "9" ? -1 : Number(input.key) - 1,
    };
  return null;
}
