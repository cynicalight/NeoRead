import { connectionRuntime, type PiConnection } from "./connections";

export interface AgentQuota {
  remaining?: number;
  resetsAt?: string;
  error?: string;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function resetTime(value: unknown): string | undefined {
  const millis =
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value * 1000
      : typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            value,
          )
        ? Date.parse(value)
        : NaN;
  if (!Number.isFinite(millis)) return undefined;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() <= 9999
    ? date.toISOString()
    : undefined;
}

function weeklyQuota(
  window: JsonObject | undefined,
  usedField: string,
  resetField: string,
): AgentQuota {
  if (!window) return { error: "当前连接未提供周额度窗口" };
  const used = window[usedField];
  if (
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    used < 0 ||
    used > 100
  )
    return { error: "上游返回的周额度使用率无效" };
  const resetsAt = resetTime(window[resetField]);
  return { remaining: 100 - used, ...(resetsAt ? { resetsAt } : {}) };
}

export async function connectionQuota(
  connection: PiConnection,
  signal: AbortSignal,
): Promise<AgentQuota> {
  try {
    signal.throwIfAborted();
    // Token-sharing app limits are not account-wide Codex WHAM limits.
    if (connection.provider === "openai")
      return {
        error:
          "OpenAI 暂未提供本应用剩余额度的查询接口，请在 ChatGPT 用量设置中查看",
      };
    if (connection.provider !== "anthropic")
      return { error: "当前连接不支持额度查询" };
    const { runtime, provider } = await connectionRuntime(connection, signal);
    const result = await runtime.getAuth(provider.id, { signal });
    signal.throwIfAborted();
    if (!result?.auth.apiKey) throw new Error("当前连接缺少认证");
    const headers = new Headers({
      Authorization: `Bearer ${result.auth.apiKey}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
    });
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers,
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("周额度请求失败");
    const data = object(await response.json());
    signal.throwIfAborted();
    return weeklyQuota(object(data?.seven_day), "utilization", "resets_at");
  } catch {
    // SDK refresh errors can include response bodies. Never propagate them to the worker protocol.
    throw new Error(
      signal.aborted ? "额度查询已取消" : "无法读取当前连接的周额度",
    );
  }
}
