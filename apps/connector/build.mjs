import { build } from "esbuild";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
const out = new URL("./dist/", import.meta.url);
const developmentKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwrWL9dQje+1GYqcoLTBtHlOL1iMHXibRVLZoH2gO9sLCGUfKVqTP/UXbJcWIf5PZN8C1N7VtXVKP7DwhdgKSjDkka6e47ClNy8I86eOvGSC+cLbVtbbk1jd2T4NWVzLACh4ghPMucXSBi0Qo4umoPy7lWkiYp1wCR9Ihdp3LtHjWR8ObGMRjCLZVMM2Otlkcqb0WHRsaUEfX/OayZbDawOmSi1MNns/aZOB83Qvqo+lJVYaFgfpLKzTNsf1MkXr14ELAZHJ/oXTuaET1W9Cb/ZN99oslGbhheUsIVZkRbKa9L7p9ziwy/BpzIaCFLzY/r6idu4Vhwtt42G0MOaaSAQIDAQAB";
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["src/popup.tsx"],
  outfile: "dist/popup.js",
  bundle: true,
  format: "iife",
  jsx: "automatic",
  platform: "browser",
  target: "chrome120",
  minify: true,
});
await build({
  entryPoints: ["src/worker.ts"],
  outfile: "dist/worker.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: true,
});
await copyFile(
  new URL("store/icon-128.png", import.meta.url),
  new URL("icon.png", out),
);
await copyFile(
  new URL("src/popup.html", import.meta.url),
  new URL("popup.html", out),
);
await copyFile(
  new URL("src/popup.css", import.meta.url),
  new URL("popup.css", out),
);
await writeFile(
  new URL("manifest.json", out),
  JSON.stringify(
    {
      manifest_version: 3,
      ...(process.env.NEOREAD_CONNECTOR_DEV_KEY === "1"
        ? { key: developmentKey }
        : {}),
      name: "NeoRead Connector",
      version: "0.1.5",
      description: "将网页中的 PDF 论文收录到本机 NeoRead",
      icons: { 128: "icon.png" },
      action: { default_popup: "popup.html", default_icon: "icon.png" },
      background: { service_worker: "worker.js" },
      permissions: [
        "activeTab",
        "scripting",
        "storage",
        "declarativeNetRequestWithHostAccess",
      ],
      host_permissions: ["http://127.0.0.1/*"],
      optional_host_permissions: ["https://*/*", "http://*/*"],
    },
    null,
    2,
  ),
);
