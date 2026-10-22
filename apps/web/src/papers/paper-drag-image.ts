/** Use a small independent surface: native snapshots of a row can include its composited ancestors. */
export function setPaperDragImage(
  transfer: DataTransfer,
  title: string,
  count: number,
) {
  const preview = document.createElement("div");
  preview.className = "paper-drag-preview";
  preview.setAttribute("aria-hidden", "true");
  preview.inert = true;
  const label = document.createElement("span");
  label.className = "paper-drag-title";
  label.textContent = title;
  preview.append(label);
  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "paper-drag-count";
    badge.textContent = `${count} 篇论文`;
    preview.append(badge);
  }
  document.body.append(preview);
  transfer.setDragImage(preview, 20, 20);
  // The native snapshot is captured after dragstart, before the next paint.
  const frame = requestAnimationFrame(() => preview.remove());
  return () => {
    cancelAnimationFrame(frame);
    preview.remove();
  };
}
