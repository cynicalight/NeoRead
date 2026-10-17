import { describe, expect, it } from "vitest";
import { agentPath } from "./agent-path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("agent process PATH", () => {
  it("includes the shell's Node runtime and npm custom global prefix", async () => {
    const result = await agentPath(
      { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
      "/home/test",
      "darwin",
      async (file, args, env) => {
        if (file === "/bin/zsh")
          return "shell banner\n__READER_AGENT_PATH__/nvm/node/bin:/usr/bin\n";
        expect(args).toEqual(["prefix", "-g"]);
        expect(env.PATH).toContain("/nvm/node/bin");
        return "/custom/npm\n";
      },
    );
    expect(result.split(":")).toContain("/custom/npm/bin");
    expect(result.split(":")).toContain("/nvm/node/bin");
  });

  it("falls back when shell/npm fail, without adding current-directory search", async () => {
    const result = await agentPath(
      { PATH: ":relative:/usr/bin", NPM_CONFIG_PREFIX: "/custom" },
      "/home/test",
      "linux",
      async () => {
        throw Error("timeout");
      },
    );
    expect(result.split(":")).toContain("/home/test/.npm-global/bin");
    expect(result.split(":")).toContain("/custom/bin");
    expect(result.split(":")).not.toContain("");
    expect(result.split(":")).not.toContain("relative");
  });

  it("preserves Windows PATH and adds the npm global shim directory", async () => {
    const result = await agentPath(
      { Path: "C:\\Windows", APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
      "C:\\Users\\test",
      "win32",
      async () => {
        throw Error("must not run shell");
      },
    );
    expect(result.split(";")).toContain("C:\\Windows");
    expect(result.split(";")).toContain(
      "C:\\Users\\test\\AppData\\Roaming\\npm",
    );
  });

  it.skipIf(process.platform === "win32")(
    "launches an npm-style CLI and resolves its node interpreter",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "reader-agent-path-"));
      try {
        const nodeDir = join(root, "node", "bin");
        const npmPrefix = join(root, "global");
        mkdirSync(nodeDir, { recursive: true });
        mkdirSync(join(npmPrefix, "bin"), { recursive: true });
        writeFileSync(
          join(nodeDir, "node"),
          '#!/bin/sh\nprintf "runtime-found"\n',
          { mode: 0o755 },
        );
        writeFileSync(
          join(npmPrefix, "bin", "codex"),
          "#!/usr/bin/env node\n",
          { mode: 0o755 },
        );
        const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/sh" };
        expect(() => execFileSync("codex", [], { env })).toThrow();
        const PATH = await agentPath(env, root, "linux", async (file) =>
          file === "/bin/sh" ? `__READER_AGENT_PATH__${nodeDir}\n` : npmPrefix,
        );
        expect(
          execFileSync("codex", [], { env: { PATH }, encoding: "utf8" }),
        ).toBe("runtime-found");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
