import { useEffect, useRef, useState } from "react";
import { api } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import { ChevronLeft } from "lucide-react";
import { providerLabel } from "./ProviderIdentity";
import { openExternalLink } from "./reading-links";

export function PiConnectionPanel({
  provider,
  authMethod,
  connected,
  onBack,
  onChange,
}: {
  provider: string;
  authMethod?: "oauth" | "api_key";
  connected: boolean;
  onBack: () => void;
  onChange: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authURL, setAuthURL] = useState("");
  const [deviceCode, setDeviceCode] = useState("");
  const [manualRun, setManualRun] = useState("");
  const [manualCode, setManualCode] = useState("");
  const active = useRef<AbortController>(null);
  useEffect(() => () => active.current?.abort(), []);
  const oauth = authMethod
    ? authMethod === "oauth"
    : ["codex", "claude", "kimi"].includes(provider);
  const keyLabel =
    provider === "kimi-code-key" ? "Kimi Code 套餐 API Key" : "API Key";

  const connect = async () => {
    const operation = new AbortController();
    active.current = operation;
    setBusy(true);
    setError("");
    setAuthURL("");
    setDeviceCode("");
    setManualRun("");
    setManualCode("");
    try {
      await api.connectPiProvider(
        provider,
        oauth ? "" : key.trim(),
        operation.signal,
        (event) => {
          if ("runId" in event) {
            setManualRun(event.runId);
          } else {
            setAuthURL(event.url);
            setDeviceCode(event.code ?? "");
            void openExternalLink(event.url);
          }
        },
      );
      if (!operation.signal.aborted) {
        setKey("");
        onChange();
      }
    } catch (e) {
      if (!operation.signal.aborted)
        setError(e instanceof Error ? e.message : "连接失败");
    } finally {
      setBusy(false);
      setAuthURL("");
      setDeviceCode("");
      setManualRun("");
      setManualCode("");
      active.current = null;
    }
  };
  const submitCode = async () => {
    try {
      await api.submitPiLoginInput(provider, manualRun, manualCode.trim());
      setManualRun("");
      setManualCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法提交授权码");
    }
  };
  const disconnect = async () => {
    setBusy(true);
    setError("");
    try {
      await api.disconnectPiProvider(provider);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "断开失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 p-5">
      <Button variant="ghost" onClick={onBack} aria-label="返回 Agent 设置">
        <ChevronLeft />
        {providerLabel(provider)}
      </Button>
      {connected && <p className="text-sm text-muted-foreground">已连接</p>}
      {!oauth && (
        <label className="block space-y-2 text-sm">
          <span>{keyLabel}</span>
          <Input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={busy}
          />
        </label>
      )}
      {deviceCode && (
        <p role="status" className="text-sm">
          设备验证码 <code className="select-all">{deviceCode}</code>
        </p>
      )}
      {manualRun && (
        <div className="flex items-end gap-2">
          <label className="block min-w-0 grow space-y-2 text-sm">
            <span>授权码或回调地址</span>
            <Input
              value={manualCode}
              type="password"
              autoComplete="off"
              onChange={(event) => setManualCode(event.target.value)}
            />
          </label>
          <Button
            variant="outline"
            disabled={!manualCode.trim()}
            onClick={() => void submitCode()}
          >
            提交
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || (!oauth && !key.trim())}
          onClick={() => void connect()}
        >
          {busy
            ? "正在连接"
            : oauth
              ? `使用 ${providerLabel(provider)} 账号登录`
              : "保存并连接"}
        </Button>
        {authURL && (
          <Button
            variant="outline"
            onClick={() => void openExternalLink(authURL)}
          >
            打开授权页面
          </Button>
        )}
        {busy && active.current && (
          <Button variant="ghost" onClick={() => active.current?.abort()}>
            取消
          </Button>
        )}
        {connected && !busy && (
          <Button variant="outline" onClick={() => void disconnect()}>
            断开连接
          </Button>
        )}
      </div>
    </div>
  );
}
