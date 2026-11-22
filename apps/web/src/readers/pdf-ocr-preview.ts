import { api } from "@neoread/api";
import type { PDFOCRPreviewPage, Processing } from "@neoread/core";

const maxPagesPerRequest = 32;

interface Attempt {
  run: string;
  startingRevision?: string;
  controller: AbortController;
  loaded: number;
  done: number;
  fetching: boolean;
}

/** Owns the temporary text for one open PDF, independently of its saved layout. */
export class PDFOCRPreview {
  private attempt?: Attempt;

  constructor(
    private documentId: string,
    private apply: (pages: PDFOCRPreviewPage[] | null) => void,
  ) {}
  update(
    processing:
      | Pick<Processing, "reparseRun" | "pagesDone" | "layoutRevision">
      | undefined,
    blocksRevision?: string,
  ) {
    const run = processing?.reparseRun;
    const revision = processing?.layoutRevision;
    if (!processing || !run) {
      const attempt = this.attempt;
      if (!attempt) return;
      // Successful publication can be observed before the /blocks response.
      // Keep the displayed preview until those canonical blocks are applied.
      if (
        revision &&
        revision !== attempt.startingRevision &&
        revision !== blocksRevision
      ) {
        attempt.controller.abort();
        return;
      }
      this.close();
      return;
    }

    if (this.attempt?.run !== run) {
      this.close();
      this.attempt = {
        run,
        startingRevision: revision,
        controller: new AbortController(),
        loaded: 0,
        done: 0,
        fetching: false,
      };
    }
    const attempt = this.attempt;
    attempt.done = Math.max(attempt.done, processing.pagesDone);
    if (!attempt.fetching && attempt.loaded < attempt.done)
      void this.fetchCompleted(attempt);
  }

  close() {
    if (!this.attempt) return;
    this.attempt.controller.abort();
    this.attempt = undefined;
    this.apply(null);
  }

  private async fetchCompleted(attempt: Attempt) {
    const { signal } = attempt.controller;
    attempt.fetching = true;
    try {
      while (!signal.aborted && attempt.loaded < attempt.done) {
        const from = attempt.loaded + 1;
        const to = Math.min(attempt.done, from + maxPagesPerRequest - 1);
        // The API logs request failures. An attempt may finish before the next
        // processing poll; let that poll choose between clearing and handoff.
        const response = await api
          .ocrPreview(this.documentId, attempt.run, from, to, signal)
          .catch(() => undefined);
        const pages = response?.pages;
        // A completed range is all-or-nothing, including pages with no lines.
        if (
          signal.aborted ||
          !Array.isArray(pages) ||
          pages.length !== to - from + 1 ||
          pages.some(
            (page, i) => page?.page !== from + i || !Array.isArray(page.lines),
          )
        )
          return;
        this.apply(pages);
        attempt.loaded = to;
      }
    } finally {
      attempt.fetching = false;
    }
  }
}
