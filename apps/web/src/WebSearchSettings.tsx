import { useEffect, useId, useRef, useState } from "react";
import type { WebSearchConfig } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";

const defaultURL = "https://api.deepseek.com";
const keenableURL = "https://api.keenable.ai";
const defaults: WebSearchConfig = {
  provider: "",
  url: defaultURL,
  hasKey: false,
};
const normalizeURL = (url: string) =>
  url.trim().replace(/\/+$/, "") || defaultURL;
// Keenable has a fixed address. A saved key stays with its address, so switching
// between services never sends one service's key to the other.
const providerURL = (provider: WebSearchConfig["provider"], url: string) =>
  provider === "keenable"
    ? keenableURL
    : provider === "deepseek" && normalizeURL(url) === keenableURL
      ? defaultURL
      : url;

export function WebSearchSettings({
  value,
  disabled,
  onSave,
}: {
  value?: WebSearchConfig;
  disabled: boolean;
  onSave: (value: WebSearchConfig) => Promise<boolean>;
}) {
  const id = useId();
  const saved = useRef(value ?? defaults);
  const queue = useRef(Promise.resolve());
  const providerPending = useRef(0);
  const [provider, setProvider] = useState(value?.provider ?? "");
  const [url, setURL] = useState(value?.url || defaultURL);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(0);
  const previousURL = useRef(value?.url || defaultURL);
  useEffect(() => {
    saved.current = value ?? defaults;
  }, [value]);
  useEffect(() => {
    if (!providerPending.current) setProvider(value?.provider ?? "");
  }, [value?.provider]);
  useEffect(() => {
    const next = value?.url || defaultURL,
      previous = previousURL.current;
    setURL((draft) =>
      normalizeURL(draft) === normalizeURL(previous) ? next : draft,
    );
    previousURL.current = next;
  }, [value?.url]);

  // Serialize patches against the last accepted configuration, so a blur save
  // and a switch click cannot overwrite one another or reuse a stale key.
  const persist = (change: (latest: WebSearchConfig) => WebSearchConfig) => {
    setPending((n) => n + 1);
    const task = queue.current.then(async () => {
      const next = change(saved.current);
      let ok = false;
      try {
        ok = await onSave(next);
      } catch {
        /* The parent normally reports details. */
      }
      if (ok) {
        saved.current = {
          ...next,
          key: undefined,
          hasKey: !!next.key || next.hasKey,
        };
        setError("");
      } else setError("联网设置保存失败，请重试。");
      setPending((n) => n - 1);
      return ok;
    });
    queue.current = task.then(() => {});
    return task;
  };
  const saveProvider = (next: WebSearchConfig["provider"]) => {
    setProvider(next);
    // Queued key saves read this draft; never leave the other service's address.
    setURL((current) => providerURL(next, current));
    providerPending.current++;
    void persist((latest) => {
      const url = providerURL(next, latest.url);
      return {
        ...latest,
        provider: next,
        url,
        hasKey: latest.hasKey && normalizeURL(latest.url) === normalizeURL(url),
      };
    }).then(() => {
      if (!--providerPending.current) setProvider(saved.current.provider);
    });
  };
  const addressChanged =
    normalizeURL(url) !== normalizeURL(value?.url || defaultURL);
  const needsNewKey = !!value?.hasKey && addressChanged && !key.trim();
  const saveAPI = () => {
    const endpoint = normalizeURL(url),
      secret = key.trim();
    if (needsNewKey || (!addressChanged && !secret)) return;
    void persist((latest) => ({
      ...latest,
      url: endpoint,
      key: secret || undefined,
      hasKey: !secret && latest.hasKey && normalizeURL(latest.url) === endpoint,
    })).then((ok) => {
      if (ok) {
        setKey((current) => (current.trim() === secret ? "" : current));
        setURL((current) =>
          normalizeURL(current) === endpoint ? endpoint : current,
        );
      }
    });
  };
  return (
    <section aria-labelledby={`${id}-title`} aria-busy={pending > 0}>
      <h3 id={`${id}-title`} className="mb-3 text-sm font-medium">
        联网搜索
      </h3>
      <div className="space-y-3">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
          <label id={`${id}-provider`} className="text-sm">
            搜索 API
          </label>
          <Tabs
            value={provider || "off"}
            className="ml-auto w-1/2 min-w-fit"
            onValueChange={(next) => {
              if (next === "off" || next === "deepseek" || next === "keenable")
                saveProvider(next === "off" ? "" : next);
            }}
          >
            <TabsList aria-labelledby={`${id}-provider`} className="w-full">
              <TabsTrigger value="off" disabled={disabled}>
                关闭
              </TabsTrigger>
              <TabsTrigger value="deepseek" disabled={disabled}>
                DeepSeek
              </TabsTrigger>
              <TabsTrigger value="keenable" disabled={disabled}>
                Keenable
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {provider === "deepseek" && (
            <>
              <label htmlFor={`${id}-url`} className="text-sm">
                API 地址
              </label>
              <Input
                id={`${id}-url`}
                value={url}
                disabled={disabled}
                onChange={(event) => setURL(event.target.value)}
                onBlur={saveAPI}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                autoComplete="off"
                spellCheck={false}
                placeholder={defaultURL}
              />
            </>
          )}
          {provider && (
            <>
              <label htmlFor={`${id}-key`} className="text-sm">
                API Key
              </label>
              <Input
                id={`${id}-key`}
                type="password"
                value={key}
                disabled={disabled}
                onChange={(event) => setKey(event.target.value)}
                onBlur={saveAPI}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                autoComplete="off"
                placeholder={
                  value?.hasKey && !addressChanged
                    ? "已保存，留空保持不变"
                    : provider === "keenable"
                      ? "可选，用于提高限额"
                      : "填写此搜索服务的 API Key"
                }
              />
            </>
          )}
        </div>
        {provider && (
          <p className="text-xs leading-5 text-muted-foreground">
            {provider === "keenable"
              ? "Keenable 无需 API Key 即可搜索和读取网页，Key 仅用于提高限额。"
              : needsNewKey
                ? "地址已更改，填写此服务的 API Key 后自动保存。"
                : !value?.hasKey && !key
                  ? "填写搜索 API Key 后自动启用。"
                  : "支持 DeepSeek Search / Fetch 协议，聊天模型与搜索服务分别配置。"}
          </p>
        )}
        {value?.hasKey && (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="destructive-ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                // Keenable works without a key, so removing its optional key
                // keeps search on through the keyless endpoints.
                const next = provider === "keenable" ? "keenable" : "";
                setKey("");
                setProvider(next);
                providerPending.current++;
                void persist((latest) => ({
                  ...latest,
                  provider: next,
                  url: providerURL(next, latest.url),
                  key: undefined,
                  hasKey: false,
                })).then(() => {
                  if (!--providerPending.current)
                    setProvider(saved.current.provider);
                });
              }}
            >
              移除搜索密钥
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
