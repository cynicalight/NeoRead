import { useEffect, useRef, useState } from "react";
import type {
  ProxySettings as Configuration,
  ProxySettingsState,
  ProxyCheckResult,
} from "@neoread/core";
import { LoaderCircle, CircleCheck, TriangleAlert } from "lucide-react";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";

const labels = { system: "跟随系统", manual: "手动 HTTP 代理", direct: "直连" };

export function ProxySettings({ open }: { open: boolean }) {
  const desktop = window.neoreadDesktop;
  const [state, setState] = useState<ProxySettingsState>();
  const [mode, setMode] = useState<Configuration["mode"]>("system");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("7890");
  const [result, setResult] = useState<ProxyCheckResult>();
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<"load" | "save" | "check" | null>(
    null,
  );
  const pending = operation !== null;
  const revision = useRef(0);
  const applyState = (next: ProxySettingsState) => {
    setState(next);
    setMode(next.settings.mode);
    if (next.settings.mode === "manual") {
      setHost(next.settings.host);
      setPort(String(next.settings.port));
    }
  };
  useEffect(() => {
    if (!open || !desktop?.proxySettings) return;
    const current = ++revision.current;
    setOperation("load");
    setState(undefined);
    setError("");
    setResult(undefined);
    void desktop
      .proxySettings()
      .then((next) => {
        if (current === revision.current) applyState(next);
      })
      .catch((cause: Error) => {
        if (current === revision.current) setError(cause.message);
      })
      .finally(() => {
        if (current === revision.current) setOperation(null);
      });
    return () => {
      revision.current++;
    };
  }, [open, desktop]);
  if (
    !desktop?.proxySettings ||
    !desktop.saveProxySettings ||
    !desktop.checkProxy
  )
    return null;
  const draft: Configuration =
    mode === "manual"
      ? { mode, host: host.trim(), port: Number(port) }
      : { mode };
  const changed =
    !!state && JSON.stringify(draft) !== JSON.stringify(state.settings);
  const edited = () => {
    revision.current++;
    setResult(undefined);
    setError("");
  };
  const perform = async (action: "save" | "check") => {
    const current = revision.current;
    setOperation(action);
    setError("");
    try {
      if (mode === "manual" && !/^\d+$/.test(port.trim()))
        throw new Error("代理端口应为 1–65535 的整数。");
      if (action === "save") {
        const next = await desktop.saveProxySettings!(draft);
        if (current === revision.current) {
          applyState(next);
        }
      } else {
        setResult(undefined);
        const next = await desktop.checkProxy!(draft);
        if (current === revision.current) {
          setResult(next);
        }
      }
    } catch (cause) {
      if (current === revision.current) setError((cause as Error).message);
    } finally {
      if (current === revision.current) setOperation(null);
    }
  };
  return (
    <>
      <section>
        <div className="flex items-center gap-3">
          <h3 id="proxy-mode-label" className="shrink-0 text-sm font-medium">
            代理
          </h3>
          <Tabs
            className="min-w-0 flex-1"
            value={mode}
            onValueChange={(value) => {
              if (
                value === "manual" ||
                value === "system" ||
                value === "direct"
              ) {
                edited();
                setMode(value);
              }
            }}
          >
            <TabsList aria-labelledby="proxy-mode-label" className="w-full">
              {Object.entries(labels).map(([value, label]) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  disabled={pending || !state}
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button
            variant="outline"
            className="shrink-0"
            disabled={pending || !changed}
            onClick={() => void perform("save")}
          >
            {operation === "save" && <LoaderCircle className="animate-spin" />}
            保存
          </Button>
        </div>
        {mode === "manual" && (
          <div className="mt-3 flex gap-3">
            <label className="min-w-0 flex-1 text-xs text-muted-foreground">
              地址
              <Input
                aria-label="代理地址"
                className="mt-1"
                value={host}
                placeholder="127.0.0.1"
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
                onChange={(event) => {
                  edited();
                  setHost(event.target.value);
                }}
              />
            </label>
            <label className="w-28 shrink-0 text-xs text-muted-foreground">
              端口
              <Input
                aria-label="代理端口"
                className="mt-1"
                value={port}
                placeholder="7890"
                inputMode="numeric"
                autoComplete="off"
                disabled={pending}
                onChange={(event) => {
                  edited();
                  setPort(event.target.value);
                }}
              />
            </label>
          </div>
        )}
        {mode === "manual" && (
          <p className="mt-2 text-xs text-muted-foreground">
            填写 Clash 的 HTTP 或 Mixed 端口。
          </p>
        )}

        <p className="mt-2 text-xs text-muted-foreground">
          {state?.restartRequired ? (
            "代理配置已变化，重启 NeoRead 后生效。"
          ) : mode === "system" ? (
            <strong className="font-semibold">
              切换系统代理后，请重启 NeoRead 再检测。
            </strong>
          ) : (
            "修改后需保存并重启 NeoRead。"
          )}
        </p>
        {state?.warning && (
          <p className="mt-2 text-xs text-muted-foreground">{state.warning}</p>
        )}
      </section>
      <section>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium">连接检测</h3>
            <span className="text-xs text-muted-foreground">
              chatgpt.com/robots.txt
            </span>
          </div>
          <Button
            className="shrink-0"
            size="sm"
            variant="outline"
            disabled={pending || !state}
            onClick={() => void perform("check")}
          >
            {operation === "check" && <LoaderCircle className="animate-spin" />}
            检测
          </Button>
        </div>
        {!(
          mode === "system" &&
          state?.settings.mode === "system" &&
          !state.restartRequired
        ) && (
          <p className="mt-2 text-xs text-muted-foreground">
            检测上方配置；修改后保存并重启生效。
          </p>
        )}
        {result && (
          <div
            className="mt-3 flex items-start gap-2 text-sm"
            role="status"
            aria-live="polite"
          >
            {result.connected && result.status && result.status < 400 ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0" />
            ) : (
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            )}
            <div>
              <p>
                {result.connected
                  ? `已收到响应 · HTTP ${result.status}`
                  : result.message || "连接失败。"}
                {` · ${result.elapsedMs} ms · ${{ proxy: "经代理", direct: "直连", unknown: "路由未知" }[result.route]}`}
              </p>
              {result.connected && result.status && result.status >= 400 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  网络可达，目标网站拒绝或未能处理请求；此结果不代表 ChatGPT
                  登录或模型调用可用。
                </p>
              )}
              {result.warning && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {result.warning}
                </p>
              )}
            </div>
          </div>
        )}
        {error && (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </section>
    </>
  );
}
