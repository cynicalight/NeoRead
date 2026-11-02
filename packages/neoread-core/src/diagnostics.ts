/** Shared wire format; never attach request bodies, document text or credentials. */
export type DiagnosticEvent = {
  level: "info" | "warn" | "error";
  event: string;
  detail?: string;
  stack?: string;
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
};

const privateKey =
  /^(?:authorization|cookie|set-cookie|key|.*(?:token|password|secret|api.?key|credential).*|userMessage|prompt|context|content|sourceText|original|translated|translation|text|quote|note|attachments|references|body)$/i;
export function redactText(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    result = result.split(secret).join("[REDACTED]");
  return result
    .replace(
      /["']?userMessage["']?\s*[:=]\s*[^\r\n]*/gi,
      "[USER MESSAGE REMOVED]",
    )
    .replace(
      /^(?:panic:|http: panic serving)[^\n]*/gm,
      "panic: [MESSAGE REMOVED]",
    )
    .replace(
      /(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi,
      "[AUTH HEADER]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, "[AUTH]")
    .replace(
      /(["']?(?:api[ _-]?key|key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[TOKEN]")
    .replace(/(?:https?|file):\/\/[^\s"'<>]+/gi, "[URL]")
    .replace(
      /\/(?:Users|home|private|tmp|var|Volumes|Applications)\/[^\r\n"'<>]+/g,
      "[PATH]",
    )
    .replace(/[A-Za-z]:[\\/][^\r\n"'<>]+|\\\\[^\r\n"'<>]+/g, "[PATH]");
}

export function redact(
  value: unknown,
  secrets: string[] = [],
  depth = 0,
): unknown {
  if (depth > 12) return "[DEPTH LIMIT]";
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value))
    return value.map((v) => redact(v, secrets, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        privateKey.test(key) ? "[REDACTED]" : redact(v, secrets, depth + 1),
      ]),
    );
  return value;
}

/** Keep exception frames, not the first line which can contain arbitrary content. */
export function diagnosticError(
  error: unknown,
): Pick<DiagnosticEvent, "detail" | "stack"> {
  if (!(error instanceof Error)) return { detail: "NonError rejection" };
  return {
    detail:
      /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|URIError|DOMException|AbortError)$/.test(
        error.name,
      )
        ? error.name
        : "Error",
    stack: (error.stack || "")
      .split("\n")
      .filter((line) => /^\s*at\s/.test(line))
      .slice(0, 30)
      .map((line) => {
        const position = line.match(/:(\d+):(\d+)\)?$/);
        return (
          redactText(line) +
          (position ? ` [${position[1]}:${position[2]}]` : "")
        );
      })
      .join("\n")
      .slice(0, 8000),
  };
}

/** Renderer events are untrusted IPC/API input. Reject unknown fields and bound strings. */
export function validateDiagnosticEvent(
  value: unknown,
): DiagnosticEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.level !== "string" ||
    !["info", "warn", "error"].includes(v.level) ||
    typeof v.event !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,79}$/.test(v.event)
  )
    return null;
  const result: Record<string, unknown> = { level: v.level, event: v.event };
  for (const key of ["detail", "stack", "requestId", "route", "method"]) {
    if (v[key] === undefined) continue;
    if (
      typeof v[key] !== "string" ||
      v[key].length > (key === "stack" ? 8000 : 512)
    )
      return null;
    result[key] = v[key];
  }
  for (const key of ["status", "durationMs"]) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== "number" || !Number.isFinite(v[key]) || v[key] < 0)
      return null;
    result[key] = v[key];
  }
  const allowed = new Set([
    "level",
    "event",
    "detail",
    "stack",
    "requestId",
    "route",
    "method",
    "status",
    "durationMs",
  ]);
  if (Object.keys(v).some((key) => !allowed.has(key))) return null;
  return result as DiagnosticEvent;
}

/** Hide query strings, resource capabilities and user-supplied path segments. */
export function diagnosticRoute(path: string): string {
  const parts = path.split(/[?#]/, 1)[0].split("/");
  const known = new Set([
    "",
    "api",
    "documents",
    "annotations",
    "migrate-legacy",
    "chat",
    "messages",
    "settings",
    "processing",
    "reparse",
    "providers",
    "translations",
    "stream",
    "ai",
    "config",
    "models",
    "test",
    "preferences",
    "libraries",
    "books",
    "papers",
    "tags",
    "folders",
    "import",
    "zotero",
    "scan",
    "connector",
    "status",
    "revision",
    "diagnostics",
    "paper-refresh",
    "events",
    "export",
    "tag-boards",
    "trash",
    "restore",
    "merge",
    "metadata",
    "lookup",
    "blocks",
    "epub-blocks",
    "epub-chapters",
    "epub-chapter",
    "assistance",
    "range",
    "chapter",
    "processing-usage",
    "chat-usage",
    "classification",
    "related",
    "note",
    "search",
    "undo",
    "snapshot",
    "resolve",
    "health",
    "codex",
    "claude",
    "kimi",
    "pub",
    "assets",
  ]);
  return parts.map((part) => (known.has(part) ? part : ":id")).join("/");
}

/** Legacy translation files contain model text between these delimiters. */
export function redactLog(
  text: string,
  secrets: string[] = [],
  legacy = false,
): string {
  const safe = legacy
    ? text.replace(
        /--- raw output ---[\s\S]*$/g,
        "--- raw output ---\n[DOCUMENT AND MODEL OUTPUT REMOVED]\n",
      )
    : text;
  return safe
    .split("\n")
    .map((line) => {
      try {
        return JSON.stringify(redact(JSON.parse(line), secrets));
      } catch {
        return redactText(line, secrets);
      }
    })
    .join("\n");
}
