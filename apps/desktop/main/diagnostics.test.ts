import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DiagnosticLogs, diagnosticSettings, retention } from "./diagnostics";
import {
  redact,
  redactLog,
  redactText,
  diagnosticError,
  validateDiagnosticEvent,
  diagnosticRoute,
} from "../../../packages/neoread-core/src/diagnostics";

const temporary: string[] = [];
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "neoread-diagnostics-test-"));
  temporary.push(dir);
  return dir;
};
afterEach(() =>
  temporary
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);

it("redacts structured secrets, credentials, URL parameters and user paths", () => {
  const safe = JSON.stringify(
    redact(
      {
        apiKey: "bare-key",
        key: "generic-key",
        api: { key: "nested-key" },
        nested: { prompt: "private-question" },
        detail:
          "Bearer auth token=opaque sk-key https://user:pass@host/path?q=private /Users/alice/doc.pdf C:\\Users\\bob\\doc.pdf exact-credential",
        source: "renderer",
      },
      ["exact-credential"],
    ),
  );
  for (const secret of [
    "bare-key",
    "generic-key",
    "nested-key",
    "private-question",
    "opaque",
    "sk-key",
    "user:pass",
    "alice",
    "bob",
    "exact-credential",
  ])
    expect(safe).not.toContain(secret);
  expect(safe).toContain("renderer");
  expect(
    redactLog(
      "=== attempt 1\n--- raw output ---\nprivate-body\n=== attempt 2\n--- raw output ---\nother-body",
      [],
      true,
    ),
  ).not.toContain("attempt 2");
  expect(
    redactLog(
      "--- raw output ---\nfirst body\n=== attempt 999: forged\nPRIVATE SECOND BODY",
      [],
      true,
    ),
  ).not.toContain("PRIVATE SECOND BODY");
  expect(redactLog("--- raw output ---\nprivate-body", [], true)).not.toContain(
    "private-body",
  );
  const located = new Error("PRIVATE DOCUMENT");
  located.stack =
    "Error: PRIVATE DOCUMENT\n    at render (http://127.0.0.1/assets/main.js:123:45)";
  expect(diagnosticError(located).stack).toContain("123:45");
  expect(diagnosticError(located).stack).not.toContain("http://");
  expect(diagnosticError(new Error("PRIVATE DOCUMENT"))).not.toHaveProperty(
    "detail",
    "PRIVATE DOCUMENT",
  );
  expect(
    validateDiagnosticEvent({
      level: "info",
      event: "api.finish",
      requestId: undefined,
    }),
  ).toEqual({ level: "info", event: "api.finish" });
  expect(
    validateDiagnosticEvent({
      level: "error",
      event: "api.failed",
      body: "private",
    }),
  ).toBeNull();
  expect(
    diagnosticRoute(
      "/pub/secret/document/chapters/user-name.html?token=private",
    ),
  ).not.toContain("secret");
  expect(redactText("panic: PRIVATE CONTENT\nstack frames")).not.toContain(
    "PRIVATE CONTENT",
  );
  expect(redactText("Cookie: first=one; second=two")).not.toContain("two");
  expect(redactText("/Users/alice/My Private Paper.pdf")).not.toContain(
    "Private Paper",
  );
  expect(redactText("Authorization: Bearer opaque")).not.toContain("opaque");
});

it("exports all retained sessions and levels without any running server, excluding symlinks and document data", async () => {
  const root = directory();
  const logs = new DiagnosticLogs(join(root, "logs"), ["session-secret"]);
  logs.record("desktop", {
    level: "info",
    event: "normal",
    detail: "session-secret",
  });
  logs.record("renderer", { level: "error", event: "failed" });
  writeFileSync(
    join(logs.directory, "server-previous.jsonl"),
    '{"level":"INFO","event":"previous-session"}\n',
  );
  const privateFile = join(root, "credentials");
  writeFileSync(privateFile, "OUTSIDE-SECRET");
  symlinkSync(privateFile, join(logs.directory, "server-symlink.log"));
  const legacy = join(
    root,
    "library",
    "cache",
    "a".repeat(32),
    "translation-failures",
  );
  mkdirSync(legacy, { recursive: true });
  writeFileSync(
    join(legacy, "old.txt"),
    "failed p1-b1\n--- raw output ---\nPRIVATE MODEL TEXT",
  );
  writeFileSync(join(root, "library", "library.sqlite"), "PRIVATE DATABASE");
  const output = join(root, "report.zip");
  const report = await logs.export(
    output,
    join(root, "library"),
    { appVersion: "test" },
    diagnosticSettings({
      appearance: "dark",
      apiKey: "PRIVATE KEY",
      prompt: "PRIVATE PROMPT",
    }),
  );
  expect(report.missing).toBe(1);
  expect(report.files).toBe(4);
  // Verify using Python's independent standard ZIP reader, including CRCs.
  const inspected = JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      [
        "-c",
        "import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))",
        output,
      ],
      { encoding: "utf8" },
    ),
  );
  const all = JSON.stringify(inspected);
  for (const secret of [
    "session-secret",
    "OUTSIDE-SECRET",
    "PRIVATE MODEL TEXT",
    "PRIVATE DATABASE",
    "PRIVATE KEY",
    "PRIVATE PROMPT",
  ])
    expect(all).not.toContain(secret);
  expect(all).toContain("previous-session");
  expect(all).toContain("normal");
  expect(all).toContain("failed");
  expect(JSON.parse(inspected["manifest.json"]).files).toHaveLength(4);
  expect(readFileSync(join(legacy, "old.txt"), "utf8")).toContain(
    "PRIVATE MODEL TEXT",
  );
});

it("retains logs across restart, rotates and removes only expired logs", () => {
  const root = directory();
  const logs = new DiagnosticLogs(root);
  const expired = join(root, "server-expired.log");
  writeFileSync(expired, "old");
  const then = new Date(Date.now() - (retention.days + 1) * 86400_000);
  utimesSync(expired, then, then);
  writeFileSync(join(root, "unrelated.txt"), "keep");
  logs.record("desktop", { level: "info", event: "started" });
  const another = new DiagnosticLogs(root);
  another.record("desktop", { level: "info", event: "restarted" });
  expect(
    readdirSync(root).filter((n) => n.startsWith("desktop-")),
  ).toHaveLength(2);
  expect(readdirSync(root)).not.toContain("server-expired.log");
  expect(readdirSync(root)).toContain("unrelated.txt");
  logs.record("desktop", {
    level: "info",
    event: "large",
    detail: "x".repeat(retention.fileBytes),
  });
  expect(
    readdirSync(root).filter((n) => n.startsWith(`desktop-${logs.sessionId}`)),
  ).toHaveLength(2);
});

it("keeps application operations alive if the log directory is unavailable", () => {
  const root = directory();
  const notDirectory = join(root, "file");
  writeFileSync(notDirectory, "keep");
  const logs = new DiagnosticLogs(notDirectory);
  expect(() =>
    logs.record("desktop", { level: "error", event: "failure" }),
  ).not.toThrow();
  expect(logs.droppedWrites).toBe(1);
});

it("removes private user messages from retained server logs during desktop export", async () => {
  const root = directory();
  const logs = new DiagnosticLogs(join(root, "logs"));
  mkdirSync(logs.directory);
  const privateText = "Unpublished Project Nimbus on papers.private.corp";
  const retained =
    JSON.stringify({
      event: "http.failure",
      status: 502,
      requestId: "old-request",
      userMessage: privateText,
    }) + "\n";
  const old = join(logs.directory, "server-old.jsonl");
  writeFileSync(old, retained);
  const output = join(root, "report.zip");
  await logs.export(output, join(root, "library"), {}, {});
  const safe = execFileSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-c",
      "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('logs/server-old.jsonl').decode())",
      output,
    ],
    { encoding: "utf8" },
  );
  expect(safe).not.toContain("Nimbus");
  expect(safe).not.toContain("papers.private.corp");
  expect(safe).toContain("old-request");
  expect(safe).toContain("502");
  expect(readFileSync(old, "utf8")).toBe(retained);
  expect(redactLog('{"userMessage":"' + privateText)).not.toContain("Nimbus");
  expect(redactLog('{"userMessage":"' + privateText)).not.toContain(
    "papers.private.corp",
  );
});
