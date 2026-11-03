/** Canvas bytes retained by background readers; the active PDF uses PDF.js's buffer. */
export class PDFTabCache {
  private entries = new Map<object, { bytes: number; evict: () => void }>();
  private bytes = 0;
  private pending = false;
  constructor(private limit: number) {}

  retain(owner: object, bytes: number, evict: () => void) {
    this.bytes += bytes - (this.entries.get(owner)?.bytes ?? 0);
    this.entries.set(owner, { bytes, evict });
    if (this.pending) return;
    this.pending = true;
    // React can hide the outgoing tab before showing the incoming tab. Account
    // for the entire visibility change before choosing an inactive eviction.
    queueMicrotask(() => {
      this.pending = false;
      while (this.bytes > this.limit) {
        const [owner, entry] = this.entries.entries().next().value!;
        this.forget(owner);
        entry.evict();
      }
    });
  }

  forget(owner: object) {
    const entry = this.entries.get(owner);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(owner);
  }
}

export const backgroundPDFCache = new PDFTabCache(256 * 1024 * 1024);
