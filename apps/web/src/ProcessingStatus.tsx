import { useEffect, useRef, useState } from "react";
import { Check, ScanLine, RefreshCw, Languages } from "lucide-react";
import type { Processing } from "@neoread/core";
import { api } from "@neoread/api";
import { Progress } from "@neoread/ui/components/progress";
import { Button } from "@neoread/ui/components/button";
import { toast } from "sonner";

export function useProcessing() {
  const [jobs, setJobs] = useState<Processing[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.processing();
        if (!stopped) {
          setJobs(next);
          setError("");
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) timer = setTimeout(poll, 1200);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return { jobs, error };
}
export function processingStages(job: Processing) {
  const learned = job.phase !== "learning";
  const translated = job.translating
    ? job.translating.status === "complete"
    : job.phase === "ready";
  return [
    {
      key: "learning",
      label: learned
        ? job.incomplete
          ? "学习部分完成"
          : "学习完成"
        : "学习中",
      icon: ScanLine,
      done: learned,
      active: !learned && job.status === "running",
      value: learned
        ? 100
        : job.pagesTotal
          ? Math.min(100, (job.pagesDone / job.pagesTotal) * 100)
          : null,
      count: job.pagesTotal
        ? `${job.pagesDone} / ${job.pagesTotal} 页`
        : "解析正文与版面",
    },
    {
      key: "translating",
      label: translated ? "翻译完成" : "翻译中",
      icon: Languages,
      done: translated,
      active: job.translating
        ? job.translating.status === "running"
        : job.phase === "translating" && job.status === "running",
      value: translated
        ? 100
        : job.translationsTotal
          ? Math.min(100, (job.translationsDone / job.translationsTotal) * 100)
          : 0,
      count: learned
        ? `${job.translationsDone} / ${job.translationsTotal} 段`
        : "等待解析完成",
    },
  ];
}
// Learning advances to a compact translation row; hide it once translation finishes.
function coverPhase(job: Processing) {
  return job.phase === "learning"
    ? "learning"
    : job.phase === "ready"
      ? "ready"
      : "processing";
}
function stageLabel(
  label: string,
  status: Processing["status"],
  learningName: string,
) {
  const name = label.startsWith("翻译") ? "翻译" : learningName;
  if (status === "queued") return `等待${name}`;
  if (status === "waiting") return `${name}待配置`;
  if (status === "failed") return name === "翻译" ? "翻译中断" : `${name}失败`;
  return label;
}
export function CoverProcessing({
  job,
  onSettings,
  unavailable = false,
  learningName = "学习",
}: {
  job: Processing;
  onSettings: () => void;
  unavailable?: boolean;
  learningName?: "学习" | "解析";
}) {
  const nextPhase = coverPhase(job);
  const [phase, setPhase] = useState(nextPhase);
  const [retrying, setRetrying] = useState(false);
  const retryLock = useRef(false);
  useEffect(() => {
    retryLock.current = false;
    setRetrying(false);
  }, [job.updatedAt]);
  const leaving = phase !== nextPhase;
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setPhase(nextPhase), 750);
    return () => clearTimeout(timer);
  }, [leaving, nextPhase]);
  if (job.status === "paused")
    return job.bookLayout ? <CoverBookLayout layout={job.bookLayout} /> : null;
  if (phase === "ready")
    return job.bookLayout ? (
      <CoverBookLayout layout={job.bookLayout} />
    ) : job.incomplete ? (
      <span className="cover-incomplete" title={job.warning || job.detail}>
        正文不完整
      </span>
    ) : null;
  const stages = processingStages(job).filter((stage) => {
    if (phase === "learning") return stage.key === "learning";
    if (stage.key === "learning") return false;
    return !(stage.done && job.translationsTotal === 0);
  });
  const status = (key: string, done: boolean): Processing["status"] => {
    if (done) return "complete";
    if (key === "translating" && job.translating) return job.translating.status;
    return key === job.phase ? job.status : "queued";
  };
  const retry = async () => {
    if (retryLock.current) return;
    retryLock.current = true;
    setRetrying(true);
    try {
      await api.process(job.documentId);
    } catch (e) {
      retryLock.current = false;
      setRetrying(false);
      toast.error((e as Error).message);
    }
  };
  return (
    <div
      className="cover-processing"
      key={phase}
      data-compact={phase !== "learning"}
      data-leaving={leaving}
      title={
        unavailable
          ? "暂时无法同步进度"
          : [
              job.detail,
              job.warning,
              job.translating?.detail,
              job.translating?.warning,
            ]
              .filter(Boolean)
              .join("\n")
      }
    >
      {stages.map((stage) => {
        const state = status(stage.key, stage.done);
        const label = stageLabel(
          stage.label.replace("学习", learningName),
          state,
          learningName,
        );
        const count =
          stage.key === "learning"
            ? stage.value === null
              ? ""
              : `${Math.floor(stage.value)}%`
            : `${job.translationsDone}/${job.translationsTotal}`;
        return (
          <div
            key={stage.key}
            className="processing-step"
            data-stage={stage.key}
            data-active={!unavailable && !leaving && stage.active}
            data-done={stage.done || undefined}
            title={
              stage.key === "translating" ? job.translating?.detail : job.detail
            }
          >
            <div className="processing-step-heading" role="status">
              {stage.done && (
                <Check className="size-3 processing-complete-icon" />
              )}
              {phase !== "learning" && stage.active && !stage.done && (
                <span
                  className="processing-activity-dot"
                  data-active={!unavailable && !leaving}
                  aria-hidden="true"
                />
              )}
              {phase !== "learning" &&
              !leaving &&
              (state === "waiting" || state === "failed") ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="cover-processing-action"
                  aria-label={state === "waiting" ? "等待 AI 配置" : "重试翻译"}
                  disabled={state === "failed" && (retrying || unavailable)}
                  onClick={state === "waiting" ? onSettings : retry}
                >
                  {state === "failed" && <RefreshCw className="size-3" />}
                  <span className="processing-label">{label}</span>
                </Button>
              ) : (
                <span className="processing-label">{label}</span>
              )}
              <span className="processing-count">
                <span
                  className="processing-count-value"
                  key={`${unavailable}:${count}`}
                >
                  {unavailable ? "离线" : count}
                </span>
              </span>
              {phase === "learning" && !leaving && state === "failed" && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="cover-processing-action cover-processing-retry"
                  aria-label={`重试${learningName}`}
                  disabled={retrying || unavailable}
                  onClick={retry}
                >
                  <RefreshCw className="size-3" />
                </Button>
              )}
            </div>
            {phase === "learning" && (
              <Progress
                aria-label={label}
                value={stage.value ?? (stage.active && !unavailable ? null : 0)}
                className="processing-progress"
              />
            )}
            {phase === "learning" && !leaving && state === "waiting" && (
              <Button
                size="xs"
                variant="ghost"
                className="cover-processing-action"
                onClick={onSettings}
              >
                等待 AI 配置
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
const bookLayoutLabels = {
  queued: "等待解析",
  running: "解析中",
  failed: "解析失败",
  complete: "解析完成",
};
// Book PDFs parse their layout in the background; fade out once every page is parsed.
function CoverBookLayout({
  layout,
}: {
  layout: NonNullable<Processing["bookLayout"]>;
}) {
  const active = layout.status !== "complete";
  const [visible, setVisible] = useState(active);
  useEffect(() => {
    if (active) {
      setVisible(true);
      return;
    }
    const timer = setTimeout(() => setVisible(false), 750);
    return () => clearTimeout(timer);
  }, [active]);
  if (!visible) return null;
  const label = bookLayoutLabels[layout.status];
  const value = layout.pagesTotal
    ? Math.min(100, (layout.pagesDone / layout.pagesTotal) * 100)
    : null;
  return (
    <div
      className="cover-processing"
      data-compact={false}
      data-leaving={!active}
      title={
        layout.status === "failed"
          ? "打开图书或重启应用后会重新解析"
          : undefined
      }
    >
      <div
        className="processing-step"
        data-active={layout.status === "running"}
        data-done={!active || undefined}
      >
        <div className="processing-step-heading" role="status">
          {!active && <Check className="size-3 processing-complete-icon" />}
          <span className="processing-label">{label}</span>
          {layout.pagesTotal > 0 && (
            <span className="processing-count">
              <span className="processing-count-value" key={layout.pagesDone}>
                {layout.pagesDone} / {layout.pagesTotal} 页
              </span>
            </span>
          )}
        </div>
        <Progress
          aria-label={label}
          value={value ?? (layout.status === "running" ? null : 0)}
          className="processing-progress"
        />
      </div>
    </div>
  );
}
