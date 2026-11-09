// electron-builder `mac.sign` hook. electron-builder still prepares the
// @electron/osx-sign options (ad-hoc identity "-"); with a fixed certificate
// available, only the identity and keychain are replaced.
//
// Two signing modes:
//   1. Apple Developer ID (preferred; required for notarization):
//        NEOREAD_APPLE_P12            base64 .p12 export of a Developer ID
//                                     Application certificate (with private key)
//        NEOREAD_APPLE_P12_PASSWORD   its password
//      Files are timestamped with Apple's timestamp service and the app is
//      built with Hardened Runtime (see builder.config.cjs). The release is
//      then notarized and stapled by scripts/notarize-mac.mjs.
//   2. Fixed self-signed certificate (fallback for local / preview builds):
//        NEOREAD_MAC_SIGN_P12           base64 .p12 with the certificate and key
//        NEOREAD_MAC_SIGN_P12_PASSWORD  its password
//
// Squirrel.Mac installs an update only when it is signed by the same
// certificate as the running app, so every release must keep using the
// certificate users installed with; switching certificates requires one manual
// DMG install for existing users.
const { signAsync } = require("@electron/osx-sign");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

function security(args) {
  return execFileSync("/usr/bin/security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

// Import into a throwaway keychain; the login keychain and trust settings stay untouched.
async function withCertificate(p12, password, sign) {
  const directory = mkdtempSync(join(tmpdir(), "neoread-sign-"));
  const keychain = join(directory, "sign.keychain-db");
  const secret = randomBytes(24).toString("hex");
  const searchList = security(["list-keychains", "-d", "user"])
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  try {
    writeFileSync(join(directory, "cert.p12"), Buffer.from(p12, "base64"), {
      mode: 0o600,
    });
    security(["create-keychain", "-p", secret, keychain]);
    security(["set-keychain-settings", keychain]);
    security(["unlock-keychain", "-p", secret, keychain]);
    security(["list-keychains", "-d", "user", "-s", keychain, ...searchList]);
    security([
      "import",
      join(directory, "cert.p12"),
      "-k",
      keychain,
      "-P",
      password,
      "-T",
      "/usr/bin/codesign",
    ]);
    security([
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      secret,
      keychain,
    ]);
    // Without -v: a self-signed certificate is not trusted, but codesign can still use it.
    const identities = [
      ...security(["find-identity", "-p", "codesigning", keychain]).matchAll(
        /^\s*\d+\) ([0-9A-F]{40}) "/gm,
      ),
    ].map((match) => match[1]);
    if (identities.length !== 1)
      throw new Error(
        `Expected one signing identity in the certificate, found ${identities.length}`,
      );
    return await sign(identities[0], keychain);
  } finally {
    try {
      security(["list-keychains", "-d", "user", "-s", ...searchList]);
    } catch {}
    try {
      security(["delete-keychain", keychain]);
    } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = async function sign(options) {
  const appleP12 = process.env.NEOREAD_APPLE_P12;
  const fallbackP12 = process.env.NEOREAD_MAC_SIGN_P12;
  if (!appleP12 && !fallbackP12) {
    if (process.env.RELEASE_TAG)
      throw new Error(
        "Release builds must be signed (NEOREAD_APPLE_P12 for Apple Developer ID, or NEOREAD_MAC_SIGN_P12 for the fixed self-signed certificate).",
      );
    return signAsync(options);
  }
  if (appleP12) {
    const password = process.env.NEOREAD_APPLE_P12_PASSWORD;
    if (!password) throw new Error("NEOREAD_APPLE_P12_PASSWORD is not set.");
    return withCertificate(appleP12, password, (identity, keychain) =>
      signAsync({
        ...options,
        identity,
        keychain,
        // Apple's timestamp service: required for notarization.
        optionsForFile: (file) => ({
          ...options.optionsForFile?.(file),
          timestamp: true,
        }),
      }),
    );
  }
  const password = process.env.NEOREAD_MAC_SIGN_P12_PASSWORD;
  if (!password) throw new Error("NEOREAD_MAC_SIGN_P12_PASSWORD is not set.");
  return withCertificate(fallbackP12, password, (identity, keychain) =>
    signAsync({
      ...options,
      identity,
      keychain,
      // Apple's timestamp service adds a network round trip per file and
      // nothing verifies it: neither Gatekeeper nor Squirrel trusts this certificate.
      // osx-sign does not await this callback, so it must stay synchronous.
      optionsForFile: (file) => ({
        ...options.optionsForFile?.(file),
        timestamp: "none",
      }),
    }),
  );
};
