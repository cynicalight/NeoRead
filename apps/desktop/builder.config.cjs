// Prefer Apple Developer ID signing when a Developer ID certificate is
// available (NEOREAD_APPLE_P12): enable Hardened Runtime + entitlements so the
// release can be notarized. Without it, keep the previous behavior (fixed
// self-signed certificate, or ad-hoc for local / preview builds).
const appleSigning = Boolean(process.env.NEOREAD_APPLE_P12);

module.exports = {
  appId: "io.github.cynicalight.neoread",
  productName: "NeoRead",
  directories: { output: "../../release" },
  files: ["dist/**/*", "package.json"],
  extraResources: [{ from: "staging", to: ".", filter: ["**/*"] }],
  asar: true,
  // Electron UI translations only; document languages and fonts are unaffected.
  electronLanguages: ["en", "zh-CN", "zh-TW"],
  // Keep maximum compression for Windows NSIS.
  compression: "maximum",
  npmRebuild: false,
  publish: null,
  protocols: [{ name: "NeoRead", schemes: ["neoread"] }],
  mac: {
    compression: "normal",
    // The zip is the Squirrel.Mac in-place update payload.
    target: ["dmg", "zip"],
    category: "public.app-category.books",
    // Lists NeoRead under Open With without claiming PDF or EPUB by default.
    extendInfo: {
      CFBundleDocumentTypes: [
        ["PDF Document", "com.adobe.pdf"],
        ["EPUB Book", "org.idpf.epub-container"],
      ].map(([name, type]) => ({
        CFBundleTypeName: name,
        CFBundleTypeRole: "Viewer",
        LSHandlerRank: "Alternate",
        LSItemContentTypes: [type],
      })),
    },
    icon: "../../assets/icons/macos/icon.icns",
    identity: "-",
    // Replaces the ad-hoc identity with the fixed release certificate when available.
    sign: (options) => require("./mac-sign.cjs")(options),
    // Hardened Runtime is mandatory for Apple notarization. It is only enabled
    // with a Developer ID certificate; the self-signed fallback does not need it
    // and would add untested constraints for local builds.
    hardenedRuntime: appleSigning,
    entitlements: appleSigning ? "entitlements.mac.plist" : undefined,
    entitlementsInherit: appleSigning ? "entitlements.mac.plist" : undefined,
    // Built-in notarization stays off on purpose: scripts/package.mjs
    // recompresses the DMG (ULMO) after electron-builder, so notarization must
    // run afterwards in scripts/notarize-mac.mjs on the final artifacts.
    notarize: false,
    artifactName:
      process.arch === "x64"
        ? "NeoRead-${version}-mac-intel-x64.${ext}"
        : "NeoRead-${version}-mac-${arch}.${ext}",
  },
  dmg: {
    sign: false,
    // scripts/package.mjs recompresses this uncompressed image to ULMO (LZMA),
    // which the builder schema does not accept. The blockmap would be stale.
    format: "UDRO",
    writeUpdateInfo: false,
  },
  win: {
    target: ["nsis"],
    icon: "../../assets/icons/windows/icon.ico",
    // Skip only code signing; resource editing still embeds the icon and version info.
    signExecutable: false,
    artifactName: "NeoRead-${version}-win-${arch}.${ext}",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    // build/installer.nsh lists NeoRead under Open With for PDF and EPUB.
    include: "installer.nsh",
  },
};
