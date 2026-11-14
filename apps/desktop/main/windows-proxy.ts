import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { win32 } from "node:path";
import { promisify } from "node:util";

// Read the active user's connection settings rather than machine-wide netsh
// WinHTTP settings. Native API also handles per-connection settings/policies.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NeoReadProxy {
  [StructLayout(LayoutKind.Sequential)]
  public struct Config {
    [MarshalAs(UnmanagedType.Bool)] public bool AutoDetect;
    public IntPtr AutoConfigUrl, Proxy, Bypass;
  }
  [DllImport("winhttp.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool WinHttpGetIEProxyConfigForCurrentUser(out Config config);
  [DllImport("kernel32.dll")]
  public static extern IntPtr GlobalFree(IntPtr memory);
}
'@
$config = New-Object NeoReadProxy+Config
try {
  if (-not [NeoReadProxy]::WinHttpGetIEProxyConfigForCurrentUser([ref]$config)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -ne 2) { throw "Cannot read system proxy: $code" }
  }
  @{
    autoDetect = $config.AutoDetect
    autoConfigUrl = [Runtime.InteropServices.Marshal]::PtrToStringUni($config.AutoConfigUrl)
    proxy = [Runtime.InteropServices.Marshal]::PtrToStringUni($config.Proxy)
    bypass = [Runtime.InteropServices.Marshal]::PtrToStringUni($config.Bypass)
  } | ConvertTo-Json -Compress
} finally {
  foreach ($pointer in @($config.AutoConfigUrl, $config.Proxy, $config.Bypass)) {
    if ($pointer -ne [IntPtr]::Zero) { [void][NeoReadProxy]::GlobalFree($pointer) }
  }
}
`;

function bypassEntries(entry: string): string[] {
  if (entry.toLowerCase() === "<local>") {
    // NO_PROXY has no portable equivalent for all unqualified intranet names.
    // Keep this machine direct without turning <local> into a global wildcard.
    const host = hostname().toLowerCase();
    return ["localhost", host, host.split(".")[0]];
  }
  if (!entry.includes("*") || entry.startsWith("*.")) return [entry];
  const octets = entry.split(".");
  const prefix = octets.indexOf("*");
  if (
    prefix < 1 ||
    octets.length > 4 ||
    !octets.slice(prefix).every((part) => part === "*") ||
    !octets
      .slice(0, prefix)
      .every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
  )
    // Skip unsupported bypass rules instead of failing the entire proxy config
    return [];
  const network = octets.slice(0, prefix);
  const start = [...network, ...Array<string>(4 - prefix).fill("0")].join(".");
  const end = [...network, ...Array<string>(4 - prefix).fill("255")].join(".");
  // Go understands CIDRs; Node's HTTP agent understands IP address ranges.
  // Include both so inherited environments preserve the same IPv4 subnet.
  return [`${start}/${prefix * 8}`, `${start}-${end}`];
}

export function windowsProxySettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Windows 系统代理返回了无效配置");
  const raw = value as Record<string, unknown>;
  for (const key of ["proxy", "bypass", "autoConfigUrl"])
    if (raw[key] != null && typeof raw[key] !== "string")
      throw new Error("Windows 系统代理字段无效");
  if (raw.autoConfigUrl) throw new Error("暂不支持将 PAC 代理传递给 Pi worker");
  const proxy = (raw.proxy as string | null | undefined)?.trim();
  if (!proxy) {
    if (raw.autoDetect) throw new Error("暂不支持自动发现代理");
    return {};
  }
  // Use the configured manual proxy; WPAD discovery is not performed here.
  const settings: Record<string, unknown> = {};
  const entries = proxy.includes("=")
    ? proxy.split(";")
    : [`http=${proxy}`, `https=${proxy}`];
  for (const entry of entries) {
    if (!entry.trim()) continue;
    const match = /^(http|https|ftp|socks)\s*=\s*(.+)$/i.exec(entry.trim());
    if (!match) throw new Error("Windows 系统代理规则无效");
    const kind = match[1].toUpperCase();
    if (kind === "FTP") continue; // NeoRead never issues FTP requests.
    if (kind === "SOCKS") throw new Error("暂不支持 Windows SOCKS 代理规则");
    const address = match[2];
    const url = new URL(
      address.includes("://") ? address : `http://${address}`,
    );
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("Windows 系统代理地址无效");
    settings[`${kind}Enable`] = 1;
    settings[`${kind}Proxy`] = url.hostname;
    settings[`${kind}Port`] = Number(url.port || 80);
  }
  const bypass = ((raw.bypass as string | null | undefined) ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean)
    .flatMap(bypassEntries);
  settings.ExceptionsList = bypass;
  return settings;
}

export async function readWindowsProxySettings(env: NodeJS.ProcessEnv) {
  const systemRoot =
    Object.entries(env).find(
      ([key]) => key.toLowerCase() === "systemroot",
    )?.[1] || "C:\\Windows";
  const executable = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await promisify(execFile)(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { env, windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 },
  );
  return windowsProxySettings(JSON.parse(stdout.replace(/^\uFEFF/, "")));
}
