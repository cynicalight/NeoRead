import { useEffect, useState } from "react";
import { BookOpen, RefreshCw, Square, ArrowUpRight } from "lucide-react";
import type {
  Document,
  DocumentLocation,
  DocumentOverview,
  OverviewJob,
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

const labels: Record<OverviewJob["status"], string> = {
  missing: "尚未生成概要",
  queued: "等待生成概要",
  running: "正在生成概要",
  waiting: "等待可用模型",
  complete: "概要已生成",
  partial: "概要覆盖部分原文",
  failed: "概要生成失败",
  canceled: "概要生成已取消",
  stale: "原文已更新，概要需要重新生成",
};
export function useOverviewJobs() {
  const [jobs, setJobs] = useState<OverviewJob[]>([]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.overviewJobs();
        if (!stopped) setJobs(next);
      } catch {
        /* The overview panel exposes actionable errors on demand. */
      } finally {
        if (!stopped) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return jobs;
}
export function CoverOverview({
  job,
  onOpen,
}: {
  job: OverviewJob;
  onOpen: () => void;
}) {
  const active = ["queued", "running", "waiting", "failed"].includes(
    job.status,
  );
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
  return (
    <Button
      variant="ghost"
      className="cover-processing"
      data-compact
      data-leaving={!active}
      data-document-action
      onClick={onOpen}
      title={job.error || labels[job.status]}
    >
      <span className="processing-step-heading" role="status">
        <BookOpen className="size-3.5" />
        <span>{labels[job.status]}</span>
        {job.totalPassages > 0 && (
          <small>
            {Math.floor((job.compiledPassages / job.totalPassages) * 100)}%
          </small>
        )}
      </span>
    </Button>
  );
}
export function DocumentOverviewDialog({
  document: doc,
  onClose,
  onNavigate,
}: {
  document: Document | null;
  onClose: () => void;
  onNavigate?: (location: DocumentLocation) => Promise<void>;
}) {
  const [data, setData] = useState<DocumentOverview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!doc) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api.documentOverview(doc.id);
        if (stopped) return;
        setData(value);
        setError("");
        if (["queued", "running", "waiting"].includes(value.status))
          timer = setTimeout(poll, 1500);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [doc?.id, data?.status]);
  const generate = async () => {
    if (!doc || busy) return;
    setBusy(true);
    setError("");
    try {
      setData(
        await api.generateOverview(
          doc.id,
          data?.status === "complete" ||
            (data?.status === "partial" && !!data.content) ||
            !!data?.stale,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!doc || busy) return;
    setBusy(true);
    try {
      await api.cancelOverview(doc.id);
      setData(await api.documentOverview(doc.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const navigate = async (location: DocumentLocation) => {
    if (!doc || !data || !onNavigate) return;
    try {
      const current = await api.documentOverview(doc.id);
      if (current.stale || current.corpusRevision !== data.corpusRevision) {
        setData(current);
        setError("原文已更新，请先重新生成概要。");
        return;
      }
      await onNavigate(location);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const running =
    !!data && ["queued", "running", "waiting"].includes(data.status);
  const content = data?.content;
  const points = (
    title: string,
    items: NonNullable<typeof content>["findings"],
  ) =>
    items.length > 0 && (
      <section className="space-y-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-7">
          {items.map((item, i) => (
            <li key={i}>
              {item.text}
              {onNavigate &&
                !data?.stale &&
                item.blockIds.map((block) => {
                  const source = data?.sources?.find(
                    (s) => s.blockId === block,
                  );
                  return (
                    source && (
                      <Button
                        key={block}
                        variant="ghost"
                        size="xs"
                        className="ml-1"
                        onClick={() => void navigate(source.location)}
                        aria-label={`查看${title}的原文`}
                      >
                        <BookOpen className="size-3" />
                        {source.location.type === "pdf"
                          ? `第 ${source.location.page} 页`
                          : source.label || "原文"}
                      </Button>
                    )
                  );
                })}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <Dialog
      open={!!doc}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] grid-cols-1 overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="size-5" />
            文档概要
          </DialogTitle>
          <DialogDescription className="truncate" title={doc?.title}>
            {doc?.title}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!data && !error && (
          <p className="text-sm text-muted-foreground">正在读取概要…</p>
        )}
        {data && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="status" className="text-xs text-muted-foreground">
                {data.stale
                  ? "原文已更新，旧概要仅供参考"
                  : labels[data.status]}
                {data.totalPassages > 0 &&
                  ` · 覆盖 ${data.compiledPassages}/${data.totalPassages} 段`}
              </p>
              {running ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  <Square />
                  取消
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void generate()}
                >
                  <RefreshCw />
                  {content ? "重新生成" : "生成概要"}
                </Button>
              )}
            </div>
            {data.error && (
              <p className="text-sm text-muted-foreground">{data.error}</p>
            )}
            {data.coverage.missingRanges?.length > 0 && (
              <p className="text-xs text-muted-foreground">
                存在未解析的原文范围，概要不代表完整文档。
              </p>
            )}
            {content && (
              <div className="space-y-5">
                <p className="whitespace-pre-wrap text-sm leading-7">
                  {content.summary}
                </p>
                {points("主要内容", content.findings)}
                {points("限制与适用条件", content.limitations)}
                {content.terms.length > 0 && (
                  <section>
                    <h3 className="mb-2 text-sm font-medium">原文术语</h3>
                    <p className="text-sm leading-7 text-muted-foreground">
                      {content.terms.join(" · ")}
                    </p>
                  </section>
                )}
              </div>
            )}
            {data.sections.length > 1 && (
              <section className="space-y-3 border-t pt-4">
                <h3 className="text-sm font-medium">分段提要</h3>
                {data.sections.map((section) => (
                  <details
                    key={section.key}
                    className="rounded-md border p-3 text-sm"
                  >
                    <summary className="cursor-pointer">
                      {section.title}
                    </summary>
                    <p className="mt-3 whitespace-pre-wrap leading-7">
                      {section.content.summary}
                    </p>
                    {onNavigate && !data.stale && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-2"
                        onClick={() => void navigate(section.location)}
                      >
                        <ArrowUpRight />
                        阅读原文
                      </Button>
                    )}
                  </details>
                ))}
              </section>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
