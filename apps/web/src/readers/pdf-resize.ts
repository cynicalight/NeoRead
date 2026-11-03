/** Coalesce reader layout changes until the window or panel gesture settles. */
export class PDFResizeObserver {
  private observer: ResizeObserver;
  private mutations: MutationObserver;
  private timer?: ReturnType<typeof setTimeout>;
  private frame = 0;
  private pending = false;
  private disposed = false;
  private pointer?: number;
  private pointerReleased = false;
  private keys = new Set<string>();
  private groups: Element[] = [];
  private document: Document;
  private window: Window;

  constructor(
    private host: HTMLElement,
    private commit: () => void,
    private interrupt: () => void,
  ) {
    this.document = host.ownerDocument;
    this.window = this.document.defaultView!;
    for (let node = host.parentElement; node; node = node.parentElement) {
      if (node.matches('[data-slot="resizable-panel-group"]'))
        this.groups.push(node);
    }
    this.observer = new ResizeObserver(() => {
      this.interrupt();
      this.pending = true;
      this.schedule(120);
    });
    this.observer.observe(host);
    this.mutations = new MutationObserver(() => this.schedule(0));
    for (const group of this.groups)
      this.mutations.observe(group, {
        attributes: true,
        attributeFilter: ["data-toggling", "data-separator"],
        subtree: true,
      });
    this.document.addEventListener("pointerdown", this.pointerDown, true);
    this.document.addEventListener("pointerup", this.pointerEnd, true);
    this.document.addEventListener("pointercancel", this.pointerEnd, true);
    this.document.addEventListener("keydown", this.keyDown, true);
    this.document.addEventListener("keyup", this.keyUp, true);
    this.window.addEventListener("blur", this.release);
  }

  private isHandle(target: EventTarget | null) {
    const handle = (target as Element | null)?.closest?.(
      '[data-slot="resizable-handle"]',
    );
    return (
      !!handle &&
      this.groups.includes(
        handle.closest('[data-slot="resizable-panel-group"]')!,
      )
    );
  }
  private blocked() {
    return (
      this.pointer !== undefined ||
      this.keys.size > 0 ||
      this.groups.some(
        (group) =>
          group.hasAttribute("data-toggling") ||
          (!this.pointerReleased &&
            group.querySelector('[data-separator="active"]') !== null),
      )
    );
  }
  private cancel() {
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
  }
  private schedule(delay: number) {
    this.cancel();
    if (this.disposed || !this.pending || this.blocked()) return;
    this.timer = setTimeout(() => {
      this.frame = requestAnimationFrame(() => {
        if (this.disposed || !this.pending || this.blocked()) return;
        this.pending = false;
        this.commit();
      });
    }, delay);
  }
  private pointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.pointerReleased = false;
    if (!this.isHandle(event.target)) return;
    this.pointer = event.pointerId;
    this.cancel();
    this.interrupt();
  };
  private pointerEnd = (event: PointerEvent) => {
    if (this.pointer !== undefined && this.pointer !== event.pointerId) return;
    this.pointer = undefined;
    // The panel library can retain its active attribute after cancellation.
    this.pointerReleased = true;
    this.schedule(0);
  };
  private keyDown = (event: KeyboardEvent) => {
    if (
      !this.isHandle(event.target) ||
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "Enter",
      ].includes(event.key)
    )
      return;
    this.keys.add(event.key);
    this.cancel();
    this.interrupt();
  };
  private keyUp = (event: KeyboardEvent) => {
    if (!this.keys.delete(event.key)) return;
    this.schedule(0);
  };
  private release = () => {
    this.pointer = undefined;
    this.pointerReleased = true;
    this.keys.clear();
    this.schedule(0);
  };
  disconnect() {
    this.disposed = true;
    this.cancel();
    this.observer.disconnect();
    this.mutations.disconnect();
    this.document.removeEventListener("pointerdown", this.pointerDown, true);
    this.document.removeEventListener("pointerup", this.pointerEnd, true);
    this.document.removeEventListener("pointercancel", this.pointerEnd, true);
    this.document.removeEventListener("keydown", this.keyDown, true);
    this.document.removeEventListener("keyup", this.keyUp, true);
    this.window.removeEventListener("blur", this.release);
  }
}
