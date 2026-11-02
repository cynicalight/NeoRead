import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishR2, replaceDownloadSection } from "./release-r2.mjs";

const temporary = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture({
  version = "0.9.4",
  macOnly = false,
  prerelease = false,
  latest = `v${version}`,
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "neoread-r2-test-"));
  temporary.push(cwd);
  await mkdir(join(cwd, "apps/desktop"), { recursive: true });
  await mkdir(join(cwd, "release"));
  await writeFile(
    join(cwd, "apps/desktop/package.json"),
    JSON.stringify({ version }),
  );
  for (const target of [
    "mac-arm64.dmg",
    "mac-arm64.zip",
    ...(macOnly ? [] : ["win-x64.exe"]),
  ]) {
    const bytes = Buffer.alloc(1024 * 1024 + 512);
    if (target.endsWith("dmg")) bytes.write("koly", bytes.length - 512);
    else if (target.endsWith("zip")) bytes.write("PK\u0003\u0004", 0);
    else bytes.write("MZ", 0);
    await writeFile(join(cwd, `release/NeoRead-${version}-${target}`), bytes);
  }
  const env = {
    R2_BUCKET: "neoread",
    R2_ENDPOINT_URL: "https://example.r2.cloudflarestorage.com",
    R2_PUBLIC_BASE_URL: "https://downloads.example.com",
    AWS_ACCESS_KEY_ID: "test-access",
    AWS_SECRET_ACCESS_KEY: "test-secret",
    GH_REPO: "owner/NeoRead",
    GH_TOKEN: "test-github",
    RELEASE_TAG: `v${version}`,
    MAC_ONLY: String(macOnly),
    GITHUB_STEP_SUMMARY: join(cwd, "summary.md"),
  };
  // Only external AWS CLI / GitHub / HTTP are replaced. Local validation and
  // hashing execute the actual release-assets script on installer fixtures.
  const objects = new Map();
  const operations = [];
  const events = [];
  let body = "用户编写的更新说明\n<!-- neoread:mac-only -->";
  const state = { failUpload: "", corruptKey: "", failHTTP: 0 };
  async function run(command, args) {
    if (command === "aws") {
      expect(args.slice(0, 2)).toEqual(["s3", "cp"]);
      const key = args[3].replace("s3://neoread/", "");
      operations.push(`upload:${key}`);
      if (key === state.failUpload) throw new Error("simulated upload failure");
      objects.set(key, {
        bytes: await readFile(args[2]),
        disposition: args[args.indexOf("--content-disposition") + 1],
        cache: args[args.indexOf("--cache-control") + 1],
      });
      return "";
    }
    expect(command).toBe("gh");
    if (args[0] === "api") return JSON.stringify({ tag_name: latest });
    if (args[1] === "view")
      return JSON.stringify({
        body,
        isDraft: false,
        isPrerelease: prerelease,
        tagName: `v${version}`,
      });
    expect(args.slice(0, 2)).toEqual(["release", "edit"]);
    body = await readFile(args[args.indexOf("--notes-file") + 1], "utf8");
    operations.push("edit-release");
    return "";
  }
  async function request(url, options) {
    expect(options.headers["User-Agent"]).toMatch(/^NeoRead\//);
    expect(options.redirect).toBe("error");
    const key = new URL(url).pathname.slice(1);
    operations.push(`verify:${key}`);
    if (state.failHTTP-- > 0)
      return new Response("unavailable", { status: 503 });
    const object = objects.get(key);
    if (!object) return new Response("missing", { status: 404 });
    const bytes = Buffer.from(object.bytes);
    if (key === state.corruptKey) bytes[20] ^= 1;
    return new Response(bytes, {
      headers: { "Content-Disposition": object.disposition },
    });
  }
  const options = {
    cwd,
    env,
    run,
    request,
    sleep: async () => {},
    log: (event) => events.push(event),
  };
  return {
    options,
    env,
    cwd,
    objects,
    operations,
    events,
    state,
    getBody: () => body,
  };
}

test("publishes versioned assets before checksums and stable aliases with real download filenames", async () => {
  const f = await fixture();
  await publishR2(f.options);
  expect([...f.objects.keys()]).toEqual([
    "neoread/releases/v0.9.4/NeoRead-0.9.4-mac-arm64.dmg",
    "neoread/releases/v0.9.4/NeoRead-0.9.4-mac-arm64.zip",
    "neoread/releases/v0.9.4/NeoRead-0.9.4-win-x64.exe",
    "neoread/releases/v0.9.4/SHA256SUMS.txt",
    "neoread/install/mac",
    "neoread/install/win",
  ]);
  const win = f.objects.get("neoread/install/win");
  expect(win.disposition).toBe(
    'attachment; filename="NeoRead-0.9.4-win-x64.exe"',
  );
  expect(win.cache).toBe("no-cache");
  expect(
    f.operations.indexOf("verify:neoread/releases/v0.9.4/SHA256SUMS.txt"),
  ).toBeLessThan(f.operations.indexOf("upload:neoread/install/win"));
  expect(f.getBody()).toContain(
    "用户编写的更新说明\n<!-- neoread:mac-only -->",
  );
  expect(f.getBody()).toContain(
    "https://downloads.example.com/neoread/releases/v0.9.4/NeoRead-0.9.4-win-x64.exe",
  );
  expect(await readFile(f.env.GITHUB_STEP_SUMMARY, "utf8")).toContain(
    "https://downloads.example.com/neoread/install/win",
  );
  await publishR2(f.options);
  expect(
    f.getBody().match(/<!-- neoread:r2-downloads:start -->/g),
  ).toHaveLength(1);
});

test.each([
  { version: "0.9.5-beta.1", prerelease: true },
  { prerelease: true },
  { latest: "v0.9.5" },
])(
  "prereleases and older reruns cannot overwrite stable download aliases: %j",
  async (config) => {
    const f = await fixture(config);
    await publishR2(f.options);
    expect(
      [...f.objects.keys()].some((key) => key.startsWith("neoread/install/")),
    ).toBe(false);
    expect(f.getBody()).toContain("neoread/releases/");
  },
);

test("Mac-only releases neither publish nor advertise Windows files", async () => {
  const f = await fixture({ macOnly: true });
  await publishR2(f.options);
  expect([...f.objects.keys()]).toHaveLength(4);
  expect(f.objects.has("neoread/install/mac")).toBe(true);
  expect(f.getBody()).not.toContain("win-x64");
});

test.each(["upload", "corrupt"])(
  "a failed versioned %s cannot advance aliases or publish links",
  async (failure) => {
    const f = await fixture();
    const key = "neoread/releases/v0.9.4/NeoRead-0.9.4-win-x64.exe";
    f.state[failure === "upload" ? "failUpload" : "corruptKey"] = key;
    await expect(publishR2(f.options)).rejects.toThrow();
    expect(f.objects.has("neoread/install/mac")).toBe(false);
    expect(f.objects.has("neoread/releases/v0.9.4/SHA256SUMS.txt")).toBe(false);
    expect(f.operations).not.toContain("edit-release");
    if (failure === "corrupt")
      expect(
        f.events.find(
          (event) => event.event === "release.r2_verification_failed",
        ).reason,
      ).toBe("sha256_mismatch");
  },
);

test("public verification retries transient failures with a bounded attempt count", async () => {
  const f = await fixture();
  f.state.failHTTP = 1;
  await publishR2(f.options);
  expect(
    f.operations.filter(
      (op) =>
        op === "verify:neoread/releases/v0.9.4/NeoRead-0.9.4-mac-arm64.dmg",
    ),
  ).toHaveLength(2);
  const failed = await fixture();
  failed.state.failHTTP = 100;
  await expect(publishR2(failed.options)).rejects.toThrow(/verification/i);
  expect(
    failed.operations.filter((op) => op.startsWith("verify:")),
  ).toHaveLength(3);
});

test("dry runs validate artifacts and preview links without credentials or network writes", async () => {
  const f = await fixture();
  delete f.env.AWS_ACCESS_KEY_ID;
  delete f.env.AWS_SECRET_ACCESS_KEY;
  delete f.env.GH_TOKEN;
  delete f.env.RELEASE_TAG;
  await publishR2({ ...f.options, dryRun: true });
  expect(f.operations).toEqual([]);
  expect(await readFile(f.env.GITHUB_STEP_SUMMARY, "utf8")).toContain("预览");
});

test.each([
  "AWS_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_ENDPOINT_URL",
  "R2_PUBLIC_BASE_URL",
])("missing %s fails before any remote call", async (name) => {
  const f = await fixture();
  delete f.env[name];
  await expect(publishR2(f.options)).rejects.toThrow(name);
  expect(f.operations).toEqual([]);
});

test("version mismatch and malformed installers fail before any remote call", async () => {
  const f = await fixture();
  f.env.RELEASE_TAG = "v0.9.5";
  await expect(publishR2(f.options)).rejects.toThrow(/tag/i);
  f.env.RELEASE_TAG = "v0.9.4";
  await writeFile(
    join(f.cwd, "release/NeoRead-0.9.4-win-x64.exe"),
    "not an installer",
  );
  await expect(publishR2(f.options)).rejects.toThrow();
  expect(f.operations).toEqual([]);
});

test("download section replacement preserves surrounding notes and refuses broken markers", () => {
  const start = "<!-- neoread:r2-downloads:start -->";
  const end = "<!-- neoread:r2-downloads:end -->";
  expect(
    replaceDownloadSection(`before\n${start}\nold\n${end}\nafter`, "new"),
  ).toBe(`before\n${start}\nnew\n${end}\nafter`);
  expect(() =>
    replaceDownloadSection(`notes\n${start}\nincomplete`, "new"),
  ).toThrow();
});
