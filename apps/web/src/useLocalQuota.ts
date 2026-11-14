import { useEffect, useState } from "react";
import { api } from "@neoread/api";

export interface LocalQuota {
  remaining?: number;
  resetsAt?: string;
  error?: string;
}

const providers = ["codex", "claude"] as const;
type QuotaProvider = (typeof providers)[number];
type Entry = LocalQuota & { nonce: number };

/** Query current NeoRead connections, hiding old-account results on refresh. */
export function useLocalQuota(open: boolean, nonce: number) {
  const [quotas, setQuotas] = useState<Partial<Record<QuotaProvider, Entry>>>(
    {},
  );
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const settle = (provider: QuotaProvider, next: LocalQuota) => {
      if (controller.signal.aborted) return;
      setQuotas((current) => {
        const previous = current[provider];
        const kept =
          next.error && previous?.nonce === nonce
            ? { ...previous, ...next }
            : next;
        return { ...current, [provider]: { ...kept, nonce } };
      });
    };
    for (const provider of providers)
      api.agentQuota(provider, controller.signal).then(
        (next) => settle(provider, next),
        () => settle(provider, { error: "额度查询失败，请重试" }),
      );
    return () => controller.abort();
  }, [open, nonce]);
  const current = (provider: QuotaProvider) => {
    const entry = quotas[provider];
    return entry?.nonce === nonce ? entry : undefined;
  };
  return { codex: current("codex"), claude: current("claude") };
}
