type Render = (
  blockId: string,
  signal: AbortSignal,
  width: number,
) => Promise<Blob>;

/** Share nearby PDF crops across panes; retire them after the last visible user. */
export function blockImageCache(render: Render) {
  const controller = new AbortController();
  type Entry = {
    width: number;
    url: Promise<string>;
    cancel: () => void;
    owners: Set<string>;
    previous?: Entry;
  };
  const entries = new Map<string, Entry>();
  const urls = new Set<string>();
  const queued: {
    run: () => Promise<void>;
    reject: (reason: unknown) => void;
  }[] = [];
  let running = 0;
  const next = () => {
    while (running < 2 && queued.length && !controller.signal.aborted) {
      const job = queued.shift()!;
      running++;
      void job.run().finally(() => {
        running--;
        next();
      });
    }
  };
  const renderImage = (blockId: string, width: number) => {
    const abort = new AbortController();
    let job: (typeof queued)[number];
    const promise = new Promise<Blob>((resolve, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason);
        return;
      }
      job = {
        reject,
        run: async () => {
          try {
            resolve(
              await render(
                blockId,
                AbortSignal.any([controller.signal, abort.signal]),
                width,
              ),
            );
          } catch (error) {
            reject(error);
          }
        },
      };
      queued.push(job);
      next();
    });
    return {
      promise,
      cancel: () => {
        abort.abort();
        const index = queued.indexOf(job);
        if (index >= 0) {
          queued.splice(index, 1);
          job.reject(abort.signal.reason);
        }
      },
    };
  };
  return {
    url(blockId: string, width: number, owner = "default") {
      // Coarse steps keep pane resizes from re-rendering every figure.
      width = Math.ceil(width / 256) * 256;
      const entry = entries.get(blockId);
      const owners = entry?.owners ?? new Set<string>();
      owners.add(owner);
      if (entry && entry.width >= width) return entry.url;
      entry?.cancel();
      const job = renderImage(blockId, width);
      const url = job.promise.then((blob) => {
        const url = URL.createObjectURL(blob);
        if (controller.signal.aborted) URL.revokeObjectURL(url);
        else {
          urls.add(url);
          // Replaced images already have a decoded bitmap. Release the old
          // backing blob rather than retaining every zoom level until tab close.
          void entry?.url
            .then((previous) => {
              if (urls.delete(previous)) URL.revokeObjectURL(previous);
            })
            .catch(() => {});
        }
        return url;
      });
      url.catch(() => {
        if (entries.get(blockId)?.url === url) entries.delete(blockId);
      });
      entries.set(blockId, {
        width,
        url,
        cancel: job.cancel,
        owners,
        previous: entry,
      });
      return url;
    },
    release(blockId: string, owner = "default") {
      const entry = entries.get(blockId);
      if (!entry) return;
      entry.owners.delete(owner);
      if (entry.owners.size) return;
      entries.delete(blockId);
      // A fast zoom can leave an older size in flight too.
      for (
        let resource: Entry | undefined = entry;
        resource;
        resource = resource.previous
      ) {
        resource.cancel();
        void resource.url
          .then((url) => {
            if (urls.delete(url)) URL.revokeObjectURL(url);
          })
          .catch(() => {});
      }
    },
    dispose() {
      controller.abort();
      for (const job of queued.splice(0)) job.reject(controller.signal.reason);
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
      entries.clear();
    },
  };
}
