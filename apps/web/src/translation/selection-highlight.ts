import { markFormulas } from "./formula-highlight";
// Keep the browser's selection for dragging, keyboard selection and copying.
// A custom highlight paints text-sized backgrounds without selection line fill.
export function installTranslationSelectionHighlight(host: HTMLElement) {
  const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  if (!registry || typeof Highlight === "undefined") return;
  const document = host.ownerDocument;
  const name = "neoread-translation-selection";
  let highlight: Highlight | undefined;
  const clear = () => {
    if (highlight && registry.get(name) === highlight) registry.delete(name);
    highlight = undefined;
    markFormulas(host, name, []);
    host.removeAttribute("data-compact-selection");
  };
  const update = () => {
    const selection = document.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    if (
      !range ||
      selection?.isCollapsed ||
      !selection?.toString().trim() ||
      !host.contains(range.startContainer) ||
      !host.contains(range.endContainer)
    ) {
      clear();
      return;
    }
    highlight = new Highlight(range.cloneRange());
    // Active selection remains visible over saved annotation backgrounds.
    highlight.priority = 1;
    registry.set(name, highlight);
    // A selection touching a formula selects it whole.
    markFormulas(host, name, [range]);
    host.setAttribute("data-compact-selection", "");
  };
  document.addEventListener("selectionchange", update);
  const observer = new MutationObserver(update);
  observer.observe(host, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  update();
  return () => {
    document.removeEventListener("selectionchange", update);
    observer.disconnect();
    clear();
  };
}
