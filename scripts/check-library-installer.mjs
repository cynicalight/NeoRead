// Requires makensis (NSIS) and, on Windows, the newly built server executable.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const electronBuilder = createRequire(
  require.resolve("electron-builder/package.json", {
    paths: [resolve("apps/desktop")],
  }),
);
const builder = resolve(
  electronBuilder.resolve("app-builder-lib/package.json"),
  "..",
);
const templates = join(builder, "templates/nsis");
const installer = readFileSync(join(templates, "installer.nsi"), "utf8");
assert(installer.includes("!insertmacro customHeader"));
assert(installer.includes('Section "install"'));
assert(
  installer.indexOf("!insertmacro customHeader") <
    installer.indexOf('Section "install"'),
);
const installSection = readFileSync(
  join(templates, "installSection.nsh"),
  "utf8",
);
assert(installSection.includes("!insertmacro uninstallOldVersion"));
const utilities = readFileSync(
  join(templates, "include/installUtil.nsh"),
  "utf8",
).replaceAll("\r\n", "\n");
// Use the exact builder helper functions called by the guard.
const helper = (name) => {
  const start = utilities.indexOf(`Function ${name}\n`);
  assert(start >= 0);
  return utilities.slice(
    start,
    utilities.indexOf("FunctionEnd", start) + "FunctionEnd".length,
  );
};
const directory = mkdtempSync(join(tmpdir(), "neoread-installer-check-"));
try {
  const windows = process.platform === "win32";
  const migrationExe = windows
    ? resolve(
        process.env.NEOREAD_TEST_MIGRATION_EXE ??
          "apps/desktop/bin/neoread-server.exe",
      )
    : join(directory, "compile-only.exe");
  if (!windows) writeFileSync(migrationExe, "compile-only payload");
  assert(
    existsSync(migrationExe),
    `Missing ${migrationExe}; run pnpm build:server or set NEOREAD_TEST_MIGRATION_EXE`,
  );
  const testKey = `Software\\NeoReadGuardTest-${randomUUID()}`;
  const uninstallKey = `${testKey}\\Uninstall`;
  const installerInclude = resolve("apps/desktop/build/installer.nsh");
  const compile = (name, { uninstaller = false, scripted = false } = {}) => {
    const source = join(directory, `${name}.nsi`);
    const executable = join(directory, `${name}.exe`);
    writeFileSync(
      source,
      `Unicode true
!include LogicLib.nsh
Name "NeoRead guard regression"
OutFile "${executable}"
InstallDir "$TEMP\\NeoReadGuardTest"
RequestExecutionLevel user
AutoCloseWindow true
Page instfiles
!define INSTALL_REGISTRY_KEY "${testKey}"
!define UNINSTALL_REGISTRY_KEY "${uninstallKey}"
!define NEOREAD_INSTALL_MIGRATION_EXE "${migrationExe}"
${uninstaller ? "!define BUILD_UNINSTALLER" : ""}
${
  scripted
    ? `Var neoreadTestUserData
Var neoreadTestPickedParent
!define NEOREAD_INSTALL_USER_DATA "$neoreadTestUserData"
!macro neoreadLibraryPrompt PURPOSE TEXT FLAGS
  !if "\${PURPOSE}" == "RETRY"
    StrCpy $1 "\${TEXT}"
    ReadEnvStr $2 "NEOREAD_TEST_RETRY_MESSAGE"
    \${If} $1 S!= $2
      SetErrorLevel 39 ; unexpected retry message
      Quit
    \${EndIf}
  !endif
  ReadEnvStr $0 "NEOREAD_TEST_\${PURPOSE}"
!macroend
!macro neoreadLibraryPickParent
  \${If} $neoreadTestPickedParent == ""
    ReadEnvStr $0 "NEOREAD_TEST_PARENT"
    StrCpy $neoreadTestPickedParent "1"
  \${Else}
    ReadEnvStr $0 "NEOREAD_TEST_RETRY_PARENT"
  \${EndIf}
!macroend
Function .onInit
  ReadEnvStr $INSTDIR "NEOREAD_TEST_INSTALLATION"
  ReadEnvStr $neoreadTestUserData "NEOREAD_TEST_USER_DATA"
  ; Test-specific registry roots are populated only in this NSIS fixture.
  DeleteRegKey HKCU "\${INSTALL_REGISTRY_KEY}"
  ReadEnvStr $0 "NEOREAD_TEST_OLD_ROOT"
  \${If} $0 != ""
    WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" InstallLocation $0
  \${EndIf}
  ReadEnvStr $0 "NEOREAD_TEST_UNINSTALL_ROOT"
  \${If} $0 != ""
    WriteRegStr HKCU "\${UNINSTALL_REGISTRY_KEY}" UninstallString '"$0\\Uninstall NeoRead.exe" /S'
  \${EndIf}
FunctionEnd`
    : ""
}
!include "${installerInclude}"
!insertmacro customHeader
${uninstaller ? "" : helper("GetInQuotes") + "\n" + helper("GetFileParent")}
Section "Install sentinel"
; This section does not actually uninstall or install anything.
${
  uninstaller
    ? "SetErrorLevel 0"
    : `\${If} $neoreadUnsafeLibrary == ""
  SetErrorLevel 37
\${Else}
  SetErrorLevel 38
\${EndIf}`
}
SectionEnd
`,
    );
    execFileSync("makensis", ["-V2", source], { stdio: "inherit" });
    return executable;
  };
  compile("installer-native");
  compile("uninstaller", { uninstaller: true });
  const executable = compile("installer-regression", { scripted: true });
  console.log(
    "Library guard compiles for both build passes and precedes old uninstall.",
  );

  if (windows) {
    const { DatabaseSync } = await import("node:sqlite");
    const fixtures = join(directory, "fixtures");
    const folder = (name) => {
      const path = join(fixtures, name);
      mkdirSync(path, { recursive: true });
      return path;
    };
    const marker = (name, file = "neoread.sqlite") => {
      const path = folder(name);
      writeFileSync(join(path, file), "test database marker");
      return path;
    };
    const contents = {
      "papers/original.pdf": "%PDF-1.7\nOriginal paper fixture",
      "books/original.epub": "Original EPUB fixture",
      "attachments/supplement": "Research attachment",
    };
    const source = folder("old NeoRead/app/resources/旧书库");
    const database = new DatabaseSync(join(source, "neoread.sqlite"));
    try {
      database.exec(`
        CREATE TABLE documents (id TEXT PRIMARY KEY, type TEXT);
        INSERT INTO documents VALUES ('paper', 'pdf');
        CREATE TABLE document_notes (document_id TEXT PRIMARY KEY, body TEXT);
        INSERT INTO document_notes VALUES ('paper', 'Keep my notes');
      `);
    } finally {
      database.close();
    }
    for (const [path, data] of Object.entries(contents)) {
      const file = join(source, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, data);
    }

    const assertLibrary = (path) => {
      const database = new DatabaseSync(join(path, "neoread.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(
          database.prepare("SELECT body FROM document_notes").get().body,
          "Keep my notes",
        );
      } finally {
        database.close();
      }
      for (const [file, data] of Object.entries(contents)) {
        assert.equal(readFileSync(join(path, file), "utf8"), data);
      }
    };
    const assertMigrated = (userData, parent) => {
      const destination = join(parent, "NeoRead Library");
      const location = JSON.parse(
        readFileSync(join(userData, "library-location.json"), "utf8"),
      );
      const active = statSync(location.directory, { bigint: true });
      const expected = statSync(destination, { bigint: true });
      assert(active.isDirectory() && expected.isDirectory());
      // Junctions and DOS 8.3 names can spell the same NTFS directory
      // differently. Compare the volume and file identity, not path text.
      assert.notEqual(expected.ino, 0n);
      assert.equal(active.dev, expected.dev);
      assert.equal(active.ino, expected.ino);
      assertLibrary(destination);
      assertLibrary(source);
    };
    const assertNotActivated = (userData) => {
      assert(!existsSync(join(userData, "library-location.json")));
      assertLibrary(source);
    };
    const assertMigrationResults = (userData, expected) => {
      const logs = join(userData, "logs");
      const finish = readdirSync(logs)
        .filter((name) => /^server-.*\.jsonl$/.test(name))
        .flatMap((name) =>
          readFileSync(join(logs, name), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        )
        .filter(({ event }) => event === "library.install_migration.finish");
      for (const { sessionId, durationMs, timestamp } of finish) {
        assert.equal(typeof sessionId, "string");
        assert(sessionId.length > 0);
        assert(Number.isFinite(durationMs) && durationMs >= 0);
        assert(Number.isFinite(Date.parse(timestamp)));
      }
      finish.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      assert.deepEqual(
        finish.map(({ status, stage, reasonCode }) => [
          status,
          stage,
          reasonCode ?? "",
        ]),
        expected,
      );
      assert.equal(
        new Set(finish.map(({ sessionId }) => sessionId)).size,
        finish.length,
      );
    };

    // Only dialog replies and the installer profile/registry are isolated.
    // The exit sentinel confirms whether the real NSIS guard permitted the
    // next section; any migration uses the actual extracted Windows helper.
    let caseNumber = 0;
    const run = (name, installation, expected, options = {}) => {
      const userData = join(directory, `profile-${++caseNumber}`);
      const result = spawnSync(
        executable,
        options.args ?? ["--updated", "/S", "--force-run"],
        {
          windowsHide: true,
          timeout: 60_000,
          env: {
            ...process.env,
            NEOREAD_TEST_INSTALLATION: installation,
            NEOREAD_TEST_USER_DATA: userData,
            NEOREAD_TEST_OLD_ROOT: options.oldRoot ?? "",
            NEOREAD_TEST_UNINSTALL_ROOT: options.uninstallRoot ?? "",
            NEOREAD_TEST_CHOICE: options.choice ?? "2",
            NEOREAD_TEST_RISK: options.risk ?? "7",
            NEOREAD_TEST_PARENT: options.parent ?? "",
            NEOREAD_TEST_RETRY: options.retryParent ? "4" : "2",
            NEOREAD_TEST_RETRY_MESSAGE: options.retryTip
              ? `安装尚未继续。\r\n\r\n${options.retryTip}`
              : "",
            NEOREAD_TEST_RETRY_PARENT: options.retryParent ?? "",
            NEOREAD_TEST_AMBIGUOUS: "1",
          },
        },
      );
      if (result.error) throw result.error;
      assert.equal(result.status, expected, name);
      console.log(`Windows library guard regression passed: ${name}`);
      return userData;
    };

    const siblingApp = folder("siblings/app");
    marker("siblings/library");
    const parentApp = folder("parent/app");
    marker("parent");
    const nestedApp = folder("nested/app");
    marker("nested/app/library");
    const scannedAfterSibling = folder("traversal/app");
    folder("traversal/app/locales");
    marker("traversal/app/resources/library");
    const linkApp = folder("links/app");
    const externalLinkRoot = folder("links/external");
    marker("links/external/deep");
    symlinkSync(externalLinkRoot, join(linkApp, "assets"), "junction");
    const linkedLibraryApp = folder("linked-library/app");
    symlinkSync(
      marker("linked-library/external"),
      join(linkedLibraryApp, "library"),
      "junction",
    );
    const oldRoot = join(fixtures, "old NeoRead/app");
    const newRoot = folder("new NeoRead");
    const fallbackRoot = folder("uninstall location");
    const external = folder("external 书库 # &");
    const unsafeLocationTip =
      "所选位置不安全。请选择安装目录和旧书库之外的文件夹后重试。";
    try {
      for (const [name, path, status] of [
        ["missing installation", join(fixtures, "missing"), 37],
        ["empty installation", folder("empty"), 37],
        ["external sibling library", siblingApp, 37],
        ["library in parent directory", parentApp, 37],
        ["database at installation root", marker("root"), 1],
        ["nested library", nestedApp, 1],
        ["library after completed sibling scan", scannedAfterSibling, 1],
        ["legacy database", marker("legacy", "reader.sqlite"), 1],
        ["no recursion through a directory junction", linkApp, 37],
        ["database at junction root", linkedLibraryApp, 1],
      ]) {
        run(name, path, status);
      }
      run("plain unattended /S keeps warning-only behaviour", oldRoot, 38, {
        args: ["/S"],
      });
      run("explicit risk confirmation permits proceeding", oldRoot, 38, {
        choice: "7",
        risk: "6",
      });
      assertNotActivated(
        run("declining risk confirmation stops installation", oldRoot, 1, {
          choice: "7",
        }),
      );
      assertNotActivated(
        run("cancelling directory selection stops installation", oldRoot, 1, {
          choice: "6",
        }),
      );

      assertNotActivated(
        run("an uninstaller fallback root is protected", oldRoot, 2, {
          choice: "6",
          uninstallRoot: fallbackRoot,
          parent: fallbackRoot,
          retryTip: unsafeLocationTip,
        }),
      );
      assert(!existsSync(join(fallbackRoot, "NeoRead Library")));
      assertNotActivated(
        run("multiple distinct libraries block migration", nestedApp, 1, {
          choice: "6",
          oldRoot,
          parent: external,
        }),
      );
      assert(!existsSync(join(external, "NeoRead Library")));

      assertMigrated(
        run(
          "interactive migration from a different old install root",
          newRoot,
          38,
          {
            args: [],
            choice: "6",
            oldRoot,
            // This registry fallback is another spelling of the same location.
            uninstallRoot: oldRoot,
            parent: external,
          },
        ),
        external,
      );
      const retryParent = folder("external retry");
      const retriedUserData = run(
        "updater retries an unsafe selection before proceeding",
        oldRoot,
        38,
        {
          choice: "6",
          parent: oldRoot,
          retryParent,
          retryTip: unsafeLocationTip,
        },
      );
      assertMigrated(retriedUserData, retryParent);
      assertMigrationResults(retriedUserData, [
        ["failed", "preflight", "unsafe_location"],
        ["success", "activate", ""],
      ]);
      assert(!existsSync(join(oldRoot, "NeoRead Library")));
      const blocked = folder("external existing/NeoRead Library");
      writeFileSync(join(blocked, "untouched"), "existing contents");
      const blockedUserData = run(
        "an existing destination is never overwritten",
        oldRoot,
        2,
        {
          choice: "6",
          parent: dirname(blocked),
          retryTip:
            "所选位置已有 NeoRead Library。请保留现有书库，选择其他文件夹后重试。",
        },
      );
      assertNotActivated(blockedUserData);
      assertMigrationResults(blockedUserData, [
        ["failed", "destination_create", "destination_exists"],
      ]);
      assert.equal(
        readFileSync(join(blocked, "untouched"), "utf8"),
        "existing contents",
      );
    } finally {
      spawnSync("reg.exe", ["delete", `HKCU\\${testKey}`, "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
