import type { Annotation, ReaderAnnotationTarget } from "@neoread/core";

// Observe the text layer without intercepting text selection or PDF links.
export class PDFAnnotationLayer {
  private annotations: Annotation[] = [];
  private pressed?: { x: number; y: number };
  private geometryStyles = new WeakMap<
    HTMLElement,
    { input: string; cssText: string }
  >();
  constructor(
    private host: HTMLElement,
    private activate: (target: ReaderAnnotationTarget) => void,
  ) {
    host.addEventListener("pointermove", this.move);
    host.addEventListener("pointerleave", this.clear);
    host.addEventListener("pointerdown", this.press);
    host.addEventListener("click", this.click, true);
    host.addEventListener("scroll", this.clear, { passive: true });
  }
  setAnnotations(annotations: Annotation[]) {
    this.annotations = annotations;
    this.paint();
  }
  paint = () => {
    const byPage = new Map<number, Annotation[]>();
    for (const annotation of this.annotations) {
      if (annotation.location.type !== "pdf" || annotation.kind === "bookmark")
        continue;
      const annotations = byPage.get(annotation.location.page) ?? [];
      annotations.push(annotation);
      byPage.set(annotation.location.page, annotations);
    }

    // Reconcile against the current page DOM, so page resets/replacements need
    // no cache invalidation and detached pages are never retained by the layer.
    for (const page of this.host.querySelectorAll<HTMLElement>(
      ".page[data-page-number]",
    )) {
      const remaining = new Map<string, HTMLElement>();
      for (const child of Array.from(page.children)) {
        if (
          child instanceof HTMLElement &&
          child.classList.contains("neoread-annotation")
        ) {
          remaining.set(child.dataset.annotationId!, child);
        }
      }
      const ordered: HTMLElement[] = [];
      for (const annotation of byPage.get(Number(page.dataset.pageNumber)) ??
        []) {
        if (annotation.location.type !== "pdf") continue;
        const rects = annotation.location.rects ?? [];
        if (!rects.length) continue;
        let group = remaining.get(annotation.id);
        remaining.delete(annotation.id);
        if (!group) {
          group = document.createElement("div");
          group.className = "neoread-annotation";
          group.dataset.annotationId = annotation.id;
        }
        const color = annotation.color || "#facc15";
        if (group.style.getPropertyValue("--annotation-color") !== color)
          group.style.setProperty("--annotation-color", color);
        // Composite the entire annotation once, including overlapping rects.
        // Keep unchanged children and their hover state across repaints.
        rects.forEach((rect, index) => {
          let el = group.children[index] as HTMLElement | undefined;
          if (!el) {
            el = document.createElement("div");
            el.className = "neoread-highlight";
            group.append(el);
          }
          if (el.dataset.annotationId !== annotation.id)
            el.dataset.annotationId = annotation.id;
          if (el.dataset.kind !== annotation.kind)
            el.dataset.kind = annotation.kind;
          const geometry = {
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
          };
          // CSSOM may round percentages on readback. Compare the last input
          // and its serialized result to avoid repeatedly invoking setters.
          // Weak keys allow removed rectangles to be garbage-collected.
          const input = [rect.x, rect.y, rect.width, rect.height].join(",");
          const previous = this.geometryStyles.get(el);
          if (
            previous?.input === input &&
            previous.cssText === el.style.cssText
          )
            return;
          for (const property of ["left", "top", "width", "height"] as const) {
            const value = `${geometry[property] * 100}%`;
            if (el.style[property] !== value) el.style[property] = value;
          }
          this.geometryStyles.set(el, { input, cssText: el.style.cssText });
        });
        while (group.children.length > rects.length)
          group.lastElementChild!.remove();
        ordered.push(group);
      }
      for (const group of remaining.values()) group.remove();
      this.placeNotes(page, byPage.get(Number(page.dataset.pageNumber)) ?? []);
      let next = page.querySelector<HTMLElement>(
        ":scope > .neoread-annotation",
      );
      for (const group of ordered) {
        if (group !== next) {
          // Avoid disconnecting existing groups (and restarting transitions)
          // where state-preserving moves are supported.
          if (
            group.parentElement === page &&
            "moveBefore" in page &&
            typeof page.moveBefore === "function"
          )
            page.moveBefore(group, next);
          else page.insertBefore(group, next);
        }
        next = group.nextElementSibling as HTMLElement | null;
        while (next && !next.classList.contains("neoread-annotation"))
          next = next.nextElementSibling as HTMLElement | null;
      }
    }
  };
  /** Marks the end of each annotation that has a note. */
  private placeNotes(page: HTMLElement, annotations: Annotation[]) {
    const stale = new Map<string, HTMLElement>();
    for (const marker of page.querySelectorAll<HTMLElement>(
      ":scope > .neoread-note-marker",
    ))
      stale.set(marker.dataset.annotationId!, marker);
    for (const annotation of annotations) {
      if (annotation.location.type !== "pdf" || !annotation.note?.trim())
        continue;
      const rect = annotation.location.rects?.at(-1);
      if (!rect) continue;
      let marker = stale.get(annotation.id);
      stale.delete(annotation.id);
      if (!marker) {
        marker = document.createElement("span");
        marker.className = "neoread-note-marker";
        marker.dataset.annotationId = annotation.id;
        marker.setAttribute("aria-hidden", "true");
        page.append(marker);
      }
      const left = `${(rect.x + rect.width) * 100}%`,
        top = `${rect.y * 100}%`,
        color = annotation.color || "#facc15";
      if (marker.style.left !== left) marker.style.left = left;
      if (marker.style.top !== top) marker.style.top = top;
      if (marker.style.getPropertyValue("--annotation-color") !== color)
        marker.style.setProperty("--annotation-color", color);
    }
    for (const marker of stale.values()) marker.remove();
  }
  clear = () => {
    this.pressed = undefined;
    this.host
      .querySelectorAll(".neoread-highlight[data-hovered]")
      .forEach((el) => el.removeAttribute("data-hovered"));
  };
  private find(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a, button, input, textarea, [data-block-action]"))
      return;
    const page = target?.closest<HTMLElement>(".page[data-page-number]");
    if (!page || !this.host.contains(page)) return;
    const bounds = page.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    const ids: string[] = [];
    let hit;
    for (const annotation of this.annotations) {
      if (
        annotation.kind === "bookmark" ||
        annotation.location.type !== "pdf" ||
        annotation.location.page !== Number(page.dataset.pageNumber)
      )
        continue;
      const rect = annotation.location.rects?.find(
        (r) =>
          x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height,
      );
      if (rect) {
        ids.push(annotation.id);
        hit = rect;
      }
    }
    if (!hit) return;
    return {
      ids,
      anchor: {
        x: event.clientX,
        top: bounds.top + hit.y * bounds.height,
        bottom: bounds.top + (hit.y + hit.height) * bounds.height,
      },
    };
  }
  private move = (event: PointerEvent) => {
    const hit =
      !event.buttons && !window.getSelection()?.toString().trim()
        ? this.find(event)
        : undefined;
    this.host
      .querySelectorAll<HTMLElement>(".neoread-highlight")
      .forEach((el) =>
        el.toggleAttribute(
          "data-hovered",
          !!hit?.ids.includes(el.dataset.annotationId!),
        ),
      );
  };
  private press = (event: PointerEvent) => {
    this.clear();
    if (event.button === 0 && this.find(event))
      this.pressed = { x: event.clientX, y: event.clientY };
  };
  private click = (event: MouseEvent) => {
    const pressed = this.pressed;
    this.pressed = undefined;
    if (
      !pressed ||
      event.button !== 0 ||
      Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 5 ||
      window.getSelection()?.toString().trim()
    )
      return;
    const hit = this.find(event);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    this.activate(hit);
  };
  destroy() {
    this.clear();
    this.host.removeEventListener("pointermove", this.move);
    this.host.removeEventListener("pointerleave", this.clear);
    this.host.removeEventListener("pointerdown", this.press);
    this.host.removeEventListener("click", this.click, true);
    this.host.removeEventListener("scroll", this.clear);
    this.host
      .querySelectorAll(".neoread-annotation")
      .forEach((el) => el.remove());
  }
}
