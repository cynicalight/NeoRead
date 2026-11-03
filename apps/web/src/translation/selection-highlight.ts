// Keep the browser's selection for dragging, keyboard selection and copying.
// A custom highlight paints text-sized backgrounds without selection line fill.
export function installTranslationSelectionHighlight(host: HTMLElement) {
  const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  if (!registry || typeof Highlight === "undefined") return;
  const document = host.ownerDocument;
  const name = "neoread-translation-selection";
  let highlight: Highlight | undefined;
  let currentRange: Range | undefined;
  let frame = 0;
  const clear = () => {
    if (highlight && registry.get(name) === highlight) registry.delete(name);
    highlight = undefined;
    currentRange = undefined;
    host.removeAttribute("data-compact-selection");
  };
  const update = () => {
    frame = 0;
    const selection = document.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    if (
      !range ||
      selection?.isCollapsed ||
      !host.contains(range.startContainer) ||
      !host.contains(range.endContainer)
    ) {
      clear();
      return;
    }
    if (!highlight) {
      // Live native ranges track dragging without copying the selected text.
      highlight = new Highlight(range);
      highlight.priority = 1;
      registry.set(name, highlight);
      host.setAttribute("data-compact-selection", "");
    } else if (range !== currentRange) {
      highlight.clear();
      highlight.add(range);
    }
    currentRange = range;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  document.addEventListener("selectionchange", schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(host, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  update();
  return () => {
    document.removeEventListener("selectionchange", schedule);
    cancelAnimationFrame(frame);
    observer.disconnect();
    clear();
  };
}
