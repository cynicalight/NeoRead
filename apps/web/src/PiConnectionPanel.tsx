import { useEffect, useRef, useState } from "react";
import { api } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import {
  ChevronLeft,
  CircleCheck,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { ProviderIcon, providerLabel } from "./ProviderIdentity";
import { openExternalLink } from "./reading-links";

type Phase =
  | "idle"
  | "starting"
  | "authorizing"
  | "exchanging"
  | "cancelled"
  | "disconnecting"
  | "disconnected"
  | "failed";

const progress = {
  starting: ["正在打开浏览器", "准备账号登录"],
  authorizing: [
    "请在浏览器中完成授权",
    "授权完成后会自动连接，无需回到这里操作",
  ],
  exchanging: ["正在完成连接", "已收到授权，正在保存登录状态"],
} as const;

/**
 * Account login for a built-in Pi provider. A disconnected provider starts
 * the browser login on entry; the SDK receives the authorization from the
 * browser itself, so the panel only reports progress and closes on success.
 */
export function PiConnectionPanel({
  provider,
  connected,
  autoConnect,
  onBack,
  onChange,
}: {
  provider: string;
  connected: boolean;
  /** Start the browser login once when the panel opens. */
  autoConnect: boolean;
  onBack: () => void;
  onChange: () => void;
}) {
  const label = providerLabel(provider);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [authURL, setAuthURL] = useState("");
  const [deviceCode, setDeviceCode] = useState("");
  const active = useRef<AbortController | null>(null);
  const autoStart = useRef(false);
  const latest = useRef({ onBack, onChange });
  latest.current = { onBack, onChange };

  const connect = async () => {
    active.current?.abort();
    const operation = new AbortController();
    active.current = operation;
    // Events from a cancelled, replaced or unmounted attempt are ignored.
    const current = () =>
      active.current === operation && !operation.signal.aborted;
    let opened = "";
    setPhase("starting");
    setError("");
    setAuthURL("");
    setDeviceCode("");
    try {
      await api.connectPiProvider(provider, operation.signal, (event) => {
        if (!current()) return;
        if (event.type === "progress") {
          setPhase(event.phase);
          return;
        }
        setAuthURL(event.url);
        setDeviceCode(event.code ?? "");
        setPhase((phase) => (phase === "starting" ? "authorizing" : phase));
        if (event.url !== opened) {
          opened = event.url;
          openExternalLink(event.url);
        }
      });
      if (!current()) return;
      active.current = null;
      // The deck re-checks the provider before it can be selected.
      latest.current.onChange();
      latest.current.onBack();
    } catch (e) {
      if (!current()) return;
      active.current = null;
      setAuthURL("");
      setDeviceCode("");
      setError(e instanceof Error ? e.message : "连接失败");
      setPhase("failed");
    }
  };

  const cancel = () => {
    const operation = active.current;
    active.current = null;
    operation?.abort();
    setAuthURL("");
    setDeviceCode("");
    setPhase("cancelled");
  };

  const disconnect = async () => {
    setPhase("disconnecting");
    setError("");
    try {
      await api.disconnectPiProvider(provider);
      setPhase("disconnected");
      latest.current.onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "断开失败");
      setPhase("idle");
    }
  };

  useEffect(() => {
    // Deferred so StrictMode's mount, unmount, mount starts a single login.
    const timer =
      autoConnect && !autoStart.current
        ? window.setTimeout(() => {
            autoStart.current = true;
            void connect();
          })
        : undefined;
    return () => window.clearTimeout(timer);
    // `key` remounts for another provider; late detection can enable login.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect]);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );

  const pending =
    phase === "starting" || phase === "authorizing" || phase === "exchanging";
  const linked =
    phase === "disconnecting" ||
    (connected && phase !== "disconnected" && !pending);

  return (
    <div>
      <div className="flex items-center gap-2 border-b px-3 py-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="返回 Agent 设置"
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <ProviderIcon provider={provider} size={24} />
        <h3 className="min-w-0 truncate text-sm font-medium">{label}</h3>
        <span className="ml-auto pr-2 text-xs text-muted-foreground">
          {linked ? "已连接" : "未连接"}
        </span>
      </div>
      <div className="space-y-4 p-5">
        {pending ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-start gap-3 rounded-xl bg-muted/50 p-4"
          >
            <LoaderCircle
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:[animation-duration:3s]"
            />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">{progress[phase][0]}</p>
              <p className="text-xs text-muted-foreground">
                {progress[phase][1]}
              </p>
              {deviceCode && phase === "authorizing" && (
                <p className="pt-1 text-sm">
                  设备验证码{" "}
                  <code className="rounded bg-background px-1.5 py-0.5 font-mono tracking-wider select-all">
                    {deviceCode}
                  </code>
                </p>
              )}
            </div>
          </div>
        ) : linked ? (
          <p className="flex items-center gap-2 text-sm">
            <CircleCheck className="size-4 text-muted-foreground" />
            已使用 {label} 账号登录
          </p>
        ) : phase === "failed" ? null : (
          <p className="text-sm text-muted-foreground">
            {phase === "cancelled"
              ? "已取消登录"
              : `使用 ${label} 账号登录后即可在 NeoRead 中使用`}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="flex items-start gap-2 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {pending ? (
            <>
              {authURL && phase === "authorizing" && (
                <Button
                  variant="outline"
                  onClick={() => openExternalLink(authURL)}
                >
                  重新打开授权页面
                </Button>
              )}
              <Button variant="ghost" onClick={cancel}>
                取消
              </Button>
            </>
          ) : linked ? (
            <>
              <Button
                variant="outline"
                disabled={phase === "disconnecting"}
                onClick={() => void connect()}
              >
                重新登录
              </Button>
              <Button
                variant="destructive-ghost"
                disabled={phase === "disconnecting"}
                onClick={() => void disconnect()}
              >
                {phase === "disconnecting" ? "正在断开" : "断开连接"}
              </Button>
            </>
          ) : (
            <Button onClick={() => void connect()}>
              {phase === "failed" || phase === "cancelled"
                ? "重新登录"
                : `使用 ${label} 账号登录`}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
