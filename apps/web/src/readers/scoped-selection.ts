const scopes = ".translation-document, .neoread-engine, .chat-scroll";
const controls =
  'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"]';

export function focusSelectionScope(event: PointerEvent) {
  if (
    event.button !== 0 ||
    !(event.target instanceof Element) ||
    event.target.closest(controls)
  )
    return;
  const scope = event.target.closest<HTMLElement>(scopes);
  if (!scope || scope.closest("[inert]")) return;
  if (!scope.hasAttribute("tabindex")) scope.tabIndex = -1;
  scope.focus({ preventScroll: true });
}

export function selectAllInScope(event: KeyboardEvent) {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.shiftKey ||
    !(event.metaKey || event.ctrlKey) ||
    event.key.toLowerCase() !== "a" ||
    !(event.target instanceof Element) ||
    event.target.closest(controls)
  )
    return;
  const scope = event.target.closest<HTMLElement>(scopes);
  if (!scope || scope.closest("[inert]")) return;
  const selection = scope.ownerDocument.getSelection();
  if (!selection) return;
  const range = scope.ownerDocument.createRange();
  range.selectNodeContents(scope);
  selection.removeAllRanges();
  selection.addRange(range);
  event.preventDefault();
}
