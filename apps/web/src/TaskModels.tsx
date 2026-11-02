import { useEffect, useState } from "react";
import { api } from "@neoread/api";
import type {
  AIConfig,
  AgentModel,
  ModelTask,
  ReasoningEffort,
} from "@neoread/core";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@neoread/ui/components/select";
import { toast } from "sonner";
import {
  catalogRevision,
  effortLabel,
  usableModels,
  efforts,
  modelDisplayName,
  selectedAgentModel,
} from "./ModelSelector";
import { useReaderStore } from "./store";

const AUTO = "__auto__";
const tasks: [ModelTask, string][] = [
  ["chat", "问答"],
  ["translation", "翻译"],
];
// Only the API agent sends images to a separately chosen model.
const apiTasks: [ModelTask, string][] = [...tasks, ["vision", "图片"]];
const fields = {
  chat: { models: "models", efforts: "efforts" },
  translation: { models: "translationModels", efforts: "translationEfforts" },
  vision: { models: "visionModels", efforts: "visionEfforts" },
} as const;

export function taskChoice(config: AIConfig, task: ModelTask) {
  const provider = config.primary;
  const model = config[fields[task].models]?.[provider] ?? "";
  const effort = config[fields[task].efforts]?.[provider]?.[model] ?? "medium";
  return { model, effort };
}

export function TaskModels({ disabled }: { disabled: boolean }) {
  const {
    aiConfig: config,
    setAIConfig,
    aiModelSaving: saving,
    setAIModelSaving,
  } = useReaderStore();
  const provider = config?.primary ?? "";
  const revision = catalogRevision(config);
  const [catalog, setCatalog] = useState<{
    provider: string;
    models: AgentModel[];
  }>({ provider: "", models: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!provider) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api
      .agentModels(provider, controller.signal)
      .then((models) => {
        if (!controller.signal.aborted)
          setCatalog({
            provider,
            models: models.map((model) => ({
              ...model,
              name: modelDisplayName(model.id, model.name),
            })),
          });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [provider, revision]);
  if (!config || !provider) return null;
  const models = catalog.provider === provider ? catalog.models : [];

  const save = async (change: (latest: AIConfig) => AIConfig) => {
    if (useReaderStore.getState().aiModelSaving) return;
    setAIModelSaving(true);
    try {
      const latest = await api.aiConfig();
      if (latest.primary !== provider) {
        setAIConfig(latest);
        throw new Error("Agent SDK 已改变，请重新选择模型");
      }
      setAIConfig(await api.saveAIConfig(change(latest)));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setAIModelSaving(false);
    }
  };
  const chooseModel = (task: ModelTask, value: string) =>
    save((latest) => {
      const key = fields[task].models;
      return {
        ...latest,
        [key]: { ...latest[key], [provider]: value === AUTO ? "" : value },
      };
    });
  const chooseEffort = (
    task: ModelTask,
    model: string,
    value: ReasoningEffort,
  ) =>
    save((latest) => {
      if ((latest[fields[task].models]?.[provider] ?? "") !== model)
        throw new Error("模型已改变，请重新选择 Effort");
      const key = fields[task].efforts;
      return {
        ...latest,
        [key]: {
          ...latest[key],
          [provider]: { ...latest[key]?.[provider], [model]: value },
        },
      };
    });

  const untested = models.some((m) => !m.capability);
  const noVision =
    provider === "api" &&
    !loading &&
    !error &&
    models.length > 0 &&
    !untested &&
    usableModels(provider, models, "vision").length === 0;
  return (
    <div className="flex flex-col gap-2">
      {(provider === "api" ? apiTasks : tasks).map(([task, label]) => {
        const { model, effort } = taskChoice(config, task);
        const usable = usableModels(provider, models, task);
        const recommended = selectedAgentModel(usable, "", task);
        const current = model ? selectedAgentModel(models, model, task) : null;
        // API choices list only models that passed this task's check.
        const unavailable =
          provider === "api" &&
          !!current &&
          !usable.some((m) => m.id === current.id);
        const empty =
          provider === "api" && !loading && !error && usable.length === 0;
        const defaultLabel =
          recommended?.name ??
          (!empty ? "默认模型" : untested ? "等待检测" : "无可用模型");
        const effortInfo = (current ?? recommended)?.effortInfo;
        const fixedEffort =
          effortInfo?.mode === "fixed" || effortInfo?.mode === "unknown";
        const options =
          current &&
          provider !== "api" &&
          !models.some((m) => m.id === current.id)
            ? [current, ...usable]
            : usable;
        return (
          <div key={task}>
            <div className="flex items-center gap-2">
              <span
                className="w-10 shrink-0 text-sm"
                id={`${task}-model-label`}
              >
                {label}
              </span>
              <Select
                value={current?.id ?? recommended?.id ?? AUTO}
                disabled={disabled || saving || (empty && !current)}
                onValueChange={(value) =>
                  value &&
                  void chooseModel(
                    task,
                    value === recommended?.id ? AUTO : value,
                  )
                }
              >
                <SelectTrigger
                  className="min-w-0 flex-1"
                  aria-label={`${label}模型`}
                  aria-busy={loading || saving}
                >
                  <SelectValue>
                    {current
                      ? `${current.name}${unavailable ? "（未通过检测）" : ""}`
                      : loading
                        ? "加载模型…"
                        : defaultLabel}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {!recommended && !empty && (
                    <SelectItem value={AUTO} label={defaultLabel}>
                      {defaultLabel}
                    </SelectItem>
                  )}
                  {options.map((m) => (
                    <SelectItem key={m.id} value={m.id} label={m.name}>
                      {m.name}
                    </SelectItem>
                  ))}
                  {!loading && error && (
                    <div
                      className="px-2 py-1.5 text-xs text-muted-foreground"
                      role="alert"
                    >
                      {error}
                    </div>
                  )}
                </SelectContent>
              </Select>
              <Select
                value={effort}
                disabled={
                  disabled || saving || fixedEffort || (empty && !current)
                }
                onValueChange={(value) =>
                  value && void chooseEffort(task, model, value)
                }
              >
                <SelectTrigger className="w-28" aria-label={`${label} Effort`}>
                  <SelectValue>
                    {fixedEffort ? "固定／自动" : effortLabel(effort)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {efforts.map((value) => (
                    <SelectItem key={value} value={value}>
                      {effortLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        );
      })}
      {noVision && (
        <p className="text-xs text-muted-foreground" role="status">
          此 API Key 没有通过图片理解检测的模型，公式转换与图片提问不可用。
        </p>
      )}
    </div>
  );
}
