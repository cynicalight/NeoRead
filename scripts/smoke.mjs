import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
const data = await mkdtemp(join(tmpdir(), "neoread-smoke-"));
const token = randomBytes(32).toString("hex");
const child = spawn(
  `./apps/desktop/bin/neoread-server${process.platform === "win32" ? ".exe" : ""}`,
  ["--port", "0", "--data", data, "--web", "apps/web/dist"],
  {
    env: { ...process.env, NEOREAD_TOKEN: token },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
try {
  const lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, "line");
  lines.close();
  const { url } = JSON.parse(line);
  const api = async (path, init = {}) => {
    const res = await fetch(url + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res;
  };
  for (const name of ["the-art-of-reading.epub", "reading-notes.pdf"]) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([await readFile("apps/web/public/samples/" + name)]),
      name,
    );
    const doc = await (
      await api("/api/documents", { method: "POST", body: form })
    ).json();
    console.log(`Imported ${doc.type}: ${doc.title}`);
  }
  const docs = await (await api("/api/documents")).json();
  if (docs.length !== 2) throw new Error("library mismatch");
  const providers = await (await api("/api/providers")).json();
  console.log(
    "Model connections:",
    providers.map(({ id, installed, authenticated }) => ({
      id,
      configured: installed,
      authenticated,
    })),
  );
  const root = await fetch(url);
  if (!root.ok || !(await root.text()).includes("root"))
    throw new Error("web entrypoint unavailable");
  console.log("HTTP smoke passed.");
} finally {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  await rm(data, { recursive: true, force: true });
  console.log("Sidecar stopped and temporary library removed.");
}
