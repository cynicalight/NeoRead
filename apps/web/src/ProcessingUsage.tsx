import { useEffect, useState } from "react";
import type {
  Document,
  Processing,
  ProcessingUsage,
  TokenCounts,
} from "@neoread/core";
import { api } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@neoread/ui/components/dialog";

export const usageStageLabels: Record<string, string> = {
  chat: "聊天",
  overview: "概要生成",
  settling: "沉淀／图片解析",
  translating: "正文翻译",
};
const providers: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  kimi: "Kimi Code",
  api: "API",
  "text-api": "文字 API",
  "image-api": "图片 API",
};
const count = (value: number) => value.toLocaleString("zh-CN");
export function usageDuration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function sumOptional(a: number | null, b: number | null) {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}
function detail(value: number | null) {
  return value === null ? "未返回" : count(value);
}
function add(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedInputTokens: sumOptional(a.cachedInputTokens, b.cachedInputTokens),
    cacheWriteInputTokens: sumOptional(
      a.cacheWriteInputTokens,
      b.cacheWriteInputTokens,
    ),
    reasoningOutputTokens: sumOptional(
      a.reasoningOutputTokens,
      b.reasoningOutputTokens,
    ),
  };
}
const zero: TokenCounts = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  reasoningOutputTokens: null,
};
export function combineUsageReports(
  processing: ProcessingUsage,
  chat: ProcessingUsage,
): ProcessingUsage {
  return {
    historyComplete: processing.historyComplete && chat.historyComplete,
    total: add(processing.total, chat.total),
    calls: [...processing.calls, ...chat.calls],
    groups: [...processing.groups, ...chat.groups],
    stages: [...processing.stages, ...chat.stages],
    unknownCalls: processing.unknownCalls + chat.unknownCalls,
    failedCalls: processing.failedCalls + chat.failedCalls,
    partialCalls: processing.partialCalls + chat.partialCalls,
    elapsedMs:
      processing.stages.reduce((sum, stage) => sum + stage.durationMs, 0) +
      chat.elapsedMs,
  };
}
export function UsageDetails({ report }: { report: ProcessingUsage }) {
  const known = report.calls.some((call) =>
    call.models.some((model) => model.tokens !== null),
  );
  return (
    <div className="processing-usage">
      <dl className="usage-totals">
        <div>
          <dt>已记录总量</dt>
          <dd>
            {known
              ? `${count(report.total.totalTokens)} tokens`
              : report.calls.length
                ? "用量未知"
                : "暂无记录"}
          </dd>
        </div>
        <div>
          <dt>输入</dt>
          <dd>{known ? count(report.total.inputTokens) : "—"}</dd>
        </div>
        <div>
          <dt>输出</dt>
          <dd>{known ? count(report.total.outputTokens) : "—"}</dd>
        </div>
        <div>
          <dt>累计执行耗时</dt>
          <dd>
            {report.elapsedMs ? usageDuration(report.elapsedMs) : "未记录"}
          </dd>
        </div>
      </dl>
      {!report.historyComplete && (
        <p className="usage-note">历史用量未记录；仅统计启用功能后的调用。</p>
      )}
      {!!report.unknownCalls && (
        <p className="usage-note">
          {report.unknownCalls} 次调用未返回用量，总量可能不完整。
        </p>
      )}
      {!!report.partialCalls && (
        <p className="usage-note">
          {report.partialCalls}{" "}
          次未完成调用返回了部分用量，已计入；实际消耗可能更高。
        </p>
      )}
      <div className="usage-table-scroll">
        <table className="usage-table">
          <caption className="sr-only">各阶段与模型的 token 用量</caption>
          <thead>
            <tr>
              <th>阶段</th>
              <th>输入</th>
              <th>输出</th>
              <th>总量</th>
            </tr>
          </thead>
          <tbody>
            {["settling", "translating", "overview", "chat"]
              // Image consolidation was removed; keep its row only for past usage.
              .filter(
                (stage) =>
                  stage !== "settling" ||
                  report.calls.some((call) => call.stage === "settling"),
              )
              .map((stage) => {
                const groups = report.groups.filter(
                  (group) => group.stage === stage,
                );
                const tokens = groups.reduce(
                  (sum, group) => add(sum, group.tokens),
                  zero,
                );
                const known = report.calls.some(
                  (call) =>
                    call.stage === stage &&
                    call.models.some((model) => model.tokens !== null),
                );
                return (
                  <StageRows
                    key={stage}
                    stage={stage}
                    duration={
                      report.stages.find((item) => item.stage === stage)
                        ?.durationMs ?? 0
                    }
                    tokens={tokens}
                    groups={groups}
                    known={known}
                    calls={report.calls.filter((call) => call.stage === stage)}
                  />
                );
              })}
          </tbody>
        </table>
      </div>
      <p className="usage-note">
        调用 {report.calls.length} 次 · 未成功 {report.failedCalls}{" "}
        次。总量包含失败、重试及备用连接调用。
      </p>
      <p className="usage-note">
        缓存与推理是输入或输出的细分项，不重复计入总量。
      </p>
    </div>
  );
}
function StageRows({
  stage,
  duration,
  tokens,
  groups,
  known,
  calls,
}: {
  stage: string;
  duration: number;
  tokens: TokenCounts;
  groups: ProcessingUsage["groups"];
  known: boolean;
  calls: ProcessingUsage["calls"];
}) {
  return (
    <>
      <tr className="usage-stage">
        <td colSpan={4}>
          <details className="usage-models">
            <summary aria-label={`${usageStageLabels[stage]}模型调用详情`}>
              <span className="usage-stage-name">
                {usageStageLabels[stage]}
                <small>
                  {usageDuration(duration)} ·{" "}
                  {stage === "chat" &&
                    `${new Set(calls.map((call) => call.target)).size} 次提问 · `}
                  {calls.length} 次调用
                </small>
              </span>
              <span>{known ? count(tokens.inputTokens) : "—"}</span>
              <span>{known ? count(tokens.outputTokens) : "—"}</span>
              <span>
                {known
                  ? count(tokens.totalTokens)
                  : calls.length
                    ? "未知"
                    : "未记录"}
              </span>
            </summary>
            {groups.length === 0 ? (
              <p className="usage-note">暂无模型调用记录。</p>
            ) : (
              groups.map((group) => {
                const linked = calls.filter(
                  (call) =>
                    call.provider === group.provider &&
                    call.models.some((model) => model.model === group.model),
                );
                const complete = linked.filter(
                  (call) => call.status === "complete",
                ).length;
                const running = linked.filter(
                  (call) => call.status === "running",
                ).length;
                const failed = linked.length - complete - running;
                const finished = linked.filter((call) => !!call.finishedAt);
                const duration = finished.reduce(
                  (sum, call) =>
                    sum +
                    Math.max(
                      0,
                      new Date(call.finishedAt!).getTime() -
                        new Date(call.startedAt).getTime(),
                    ),
                  0,
                );
                const partial = linked.filter(
                  (call) =>
                    call.status !== "complete" &&
                    call.models.some(
                      (model) =>
                        model.model === group.model && model.tokens !== null,
                    ),
                ).length;
                const known = group.calls > group.unknownCalls;
                return (
                  <section
                    className="usage-model"
                    key={`${group.provider}:${group.model}`}
                    aria-label={`${group.model || "模型未返回"} 调用统计`}
                  >
                    <div className="usage-model-heading">
                      <strong>{group.model || "模型未返回"}</strong>
                      <span>{providers[group.provider] || group.provider}</span>
                    </div>
                    <dl className="usage-model-metrics">
                      <div>
                        <dt>调用次数</dt>
                        <dd>{group.calls}</dd>
                      </div>
                      <div>
                        <dt>成功</dt>
                        <dd>{complete}</dd>
                      </div>
                      <div>
                        <dt>未成功</dt>
                        <dd>{failed}</dd>
                      </div>
                      <div>
                        <dt>进行中</dt>
                        <dd>{running}</dd>
                      </div>
                      <div>
                        <dt>输入 token</dt>
                        <dd>
                          {known ? count(group.tokens.inputTokens) : "未知"}
                        </dd>
                      </div>
                      <div>
                        <dt>输出 token</dt>
                        <dd>
                          {known ? count(group.tokens.outputTokens) : "未知"}
                        </dd>
                      </div>
                      <div>
                        <dt>总 token</dt>
                        <dd>
                          {known ? count(group.tokens.totalTokens) : "未知"}
                        </dd>
                      </div>
                      <div>
                        <dt>关联调用累计耗时</dt>
                        <dd>
                          {finished.length ? usageDuration(duration) : "未记录"}
                        </dd>
                      </div>
                      <div>
                        <dt>缓存读取 token</dt>
                        <dd>{detail(group.tokens.cachedInputTokens)}</dd>
                      </div>
                      <div>
                        <dt>缓存写入 token</dt>
                        <dd>{detail(group.tokens.cacheWriteInputTokens)}</dd>
                      </div>
                      <div>
                        <dt>推理 token</dt>
                        <dd>{detail(group.tokens.reasoningOutputTokens)}</dd>
                      </div>
                      <div>
                        <dt>用量未知</dt>
                        <dd>{group.unknownCalls} 次</dd>
                      </div>
                    </dl>
                    {!!partial && (
                      <p className="usage-note">
                        {partial} 次调用的用量可能不完整。
                      </p>
                    )}
                    {finished.length < linked.length && (
                      <p className="usage-note">
                        {linked.length - finished.length}{" "}
                        次调用未记录结束时间，累计耗时可能不完整。
                      </p>
                    )}
                  </section>
                );
              })
            )}
          </details>
        </td>
      </tr>
    </>
  );
}
export function ProcessingUsageDialog({
  document,
  job,
  onClose,
}: {
  document: Document | null;
  job?: Processing;
  onClose: () => void;
}) {
  const [report, setReport] = useState<ProcessingUsage | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const documentId = document?.id;
  useEffect(() => {
    setReport(null);
    setError("");
  }, [documentId]);
  useEffect(() => {
    if (!documentId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const [processing, chat] = await Promise.all([
          api.processingUsage(documentId),
          api.chatUsage(documentId),
        ]);
        const next = combineUsageReports(processing, chat);
        if (!stopped) {
          setReport(next);
          setError("");
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
      if (!stopped) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [documentId, job?.updatedAt, job?.status, retry]);
  return (
    <Dialog
      open={!!document}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="usage-dialog">
        <DialogHeader>
          <DialogTitle>用量统计</DialogTitle>
          <DialogDescription>{document?.title}</DialogDescription>
        </DialogHeader>
        {error && (
          <div role="alert">
            <p>{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRetry((value) => value + 1)}
            >
              重新加载
            </Button>
          </div>
        )}
        {report ? (
          <UsageDetails report={report} />
        ) : (
          !error && <p role="status">正在读取统计…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
