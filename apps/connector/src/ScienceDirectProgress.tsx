/// <reference types="chrome" />
import { useEffect, useState } from "react";
import type { ScienceDirectPending } from "./scienceDirectResume";

export function ScienceDirectProgress({ tabId, initial }: {
  tabId: number;
  initial: ScienceDirectPending;
}) {
  const [pending, setPending] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (busy || (pending.status !== "waiting" && pending.status !== "saving")) return;
    let active = true;
    let timer: number;
    async function refresh() {
      try {
        const result = await chrome.runtime.sendMessage({ type: "sciencedirect-status", tabId });
        if (!active) return;
        if (!result?.pending) throw Error(result?.error || "收录任务已结束，请重新打开插件。");
        setError("");
        setPending(result.pending);
        if (result.pending.status === "waiting" || result.pending.status === "saving") {
          timer = window.setTimeout(refresh, 1200);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "无法读取收录状态");
      }
    }
    timer = window.setTimeout(refresh, 1200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [tabId, pending.status, busy]);

  async function act(action: "resume" | "dismiss", library?: "papers" | "books") {
    setBusy(true);
    setError("");
    try {
      const result = await chrome.runtime.sendMessage({
        type: `sciencedirect-${action}`, tabId, ...(library && { library, allowLarge: true }),
      });
      if (action === "dismiss") {
        if (result?.ok === false) throw Error(result.error || "无法取消收录");
        window.close();
        return;
      }
      const updated = await chrome.runtime.sendMessage({ type: "sciencedirect-status", tabId });
      if (updated?.pending) setPending(updated.pending);
      if (result?.error && !updated?.pending?.error) setError(result.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法继续收录");
    } finally { setBusy(false); }
  }

  const { status } = pending;
  const text = {
    waiting: "请在此标签页完成网站验证或打开本篇 PDF。识别到 PDF 后会继续收录。",
    saving: "正在收录 PDF…",
    done: "已收录到 NeoRead。",
    error: pending.error || "未能取得 PDF，请确认当前标签页已打开本篇全文。",
    "large-paper": `这份 PDF ${pending.pages ? `共 ${pending.pages} 页，` : ""}超过常规论文页数，请选择收录位置。`,
  }[status];
  return (
    <main>
      <h1>{pending.title}</h1>
      <p role="status">{text}</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row">
        {status === "large-paper" && <>
          <button disabled={busy} onClick={() => void act("resume", "books")}>导入图书库</button>
          <button className="primary" disabled={busy} onClick={() => void act("resume", "papers")}>导入论文库</button>
        </>}
        {(status === "waiting" || status === "error") && (
          <button className="primary" disabled={busy} onClick={() => void act("resume")}>继续收录</button>
        )}
        {status !== "saving" && (
          <button disabled={busy} onClick={() => void act("dismiss")}>
            {status === "done" ? "完成" : "取消收录"}
          </button>
        )}
      </div>
    </main>
  );
}
