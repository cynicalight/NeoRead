import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, normalize } from "node:path";

export const endnoteSearchTimeout = 10_000;
export interface EndNoteCandidate {
  path: string;
  name: string;
}
export interface EndNoteSearchResult {
  candidates: EndNoteCandidate[];
  timedOut: boolean;
}

// Bounded, asynchronous discovery: never walk entire drives, follow symlinks,
// or keep scheduling filesystem work after the deadline/cancellation.
export async function discoverEndNote(
  roots: string[],
  platform: string,
  signal: AbortSignal,
): Promise<EndNoteSearchResult> {
  const candidates = new Map<string, EndNoteCandidate>();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, endnoteSearchTimeout);
  const stopped = controller.signal;
  let foundTimer: ReturnType<typeof setTimeout> | undefined;
  let foundResolve: (() => void) | undefined;
  const found = new Promise<void>((resolve) => {
    foundResolve = resolve;
  });
  const add = (path: string) => {
    if (stopped.aborted || candidates.size >= 100) return;
    const key =
      platform === "win32" ? normalize(path).toLowerCase() : normalize(path);
    candidates.set(key, { path, name: basename(path) });
    foundTimer ??= setTimeout(() => foundResolve?.(), 100);
  };
  const skipped = new Set([
    "node_modules",
    "Library",
    "AppData",
    "Windows",
    "Program Files",
    "$RECYCLE.BIN",
  ]);
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (stopped.aborted || depth > 6 || visited++ >= 15_000) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stopped.aborted) return;
      if (
        entry.isSymbolicLink() ||
        entry.name.startsWith(".") ||
        skipped.has(entry.name)
      )
        continue;
      const path = join(directory, entry.name);
      const extension = extname(entry.name).toLowerCase();
      if (entry.isFile() && extension === ".enl") add(path);
      else if (entry.isDirectory() && extension === ".enlp") add(path);
      else if (entry.isDirectory() && ![".data", ".app"].includes(extension))
        await walk(path, depth + 1);
    }
  };
  const spotlight = async () => {
    if (platform !== "darwin" || stopped.aborted) return;
    await new Promise<void>((resolve) => {
      const child = spawn(
        "/usr/bin/mdfind",
        ["-0", 'kMDItemFSName == "*.enl"cd || kMDItemFSName == "*.enlp"cd'],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let pending = "";
      const checks: Promise<void>[] = [];
      const kill = () => child.kill();
      stopped.addEventListener("abort", kill, { once: true });
      if (stopped.aborted) kill();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        pending += chunk;
        if (pending.length > 1_000_000) {
          kill();
          return;
        }
        const parts = pending.split("\0");
        pending = parts.pop() || "";
        for (const path of parts) {
          // Spotlight may contain stale records. Do not show missing files.
          checks.push(
            stat(path).then(
              (info) => {
                if (
                  (info.isFile() && extname(path).toLowerCase() === ".enl") ||
                  (info.isDirectory() &&
                    extname(path).toLowerCase() === ".enlp")
                )
                  add(path);
              },
              () => {},
            ),
          );
        }
      });
      const done = () => {
        stopped.removeEventListener("abort", kill);
        void Promise.all(checks).then(() => resolve());
      };
      child.once("error", done);
      child.once("close", done);
    });
  };
  let release: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    release = resolve;
    stopped.addEventListener("abort", resolve as () => void, { once: true });
    if (stopped.aborted) resolve();
  });
  try {
    await Promise.race([
      Promise.all([
        spotlight(),
        ...[...new Set(roots)].map((root) => walk(root, 0)),
      ]),
      aborted,
      found,
    ]);
    return {
      candidates: [...candidates.values()].sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(foundTimer);
    signal.removeEventListener("abort", cancel);
    if (release) stopped.removeEventListener("abort", release);
    controller.abort();
  }
}
