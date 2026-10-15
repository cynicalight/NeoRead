import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "@reader/api";
import type {
  AIConfig,
  AgentModel,
  ModelTask,
  ReasoningEffort,
} from "@reader/core";
import { RotateCcw, Zap } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@reader/ui/components/popover";
import { Slider } from "@reader/ui/components/slider";
import { Button } from "@reader/ui/components/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@reader/ui/components/select";
import { useReaderStore } from "./store";
import { ProviderIcon } from "./ProviderIdentity";
import { toast } from "sonner";

export const efforts: ReasoningEffort[] = ["low", "medium", "high", "max"];
// Base UI emits a scalar for a single-thumb pointer interaction, even when
// the controlled value is a one-element array. Keyboard input can emit an array.
const effortFromSlider = (value: number | readonly number[]) =>
  efforts[typeof value === "number" ? value : value[0]!]!;
export const effortLabel = (value: ReasoningEffort) =>
  value[0]!.toUpperCase() + value.slice(1);
// Use the same GPT label before and after the SDK catalog arrives.
export const modelDisplayName = (id: string, name = id) =>
  /^gpt-\d/i.test(id)
    ? id
        .replace(/^gpt-/i, "GPT-")
        .replace(/-([a-z])/g, (_, letter: string) => `-${letter.toUpperCase()}`)
    : name;

// Unset choices follow the server's per-task recommendation, then the CLI default.
export function selectedAgentModel(
  models: AgentModel[],
  configured: string,
  task: ModelTask = "chat",
) {
  return configured
    ? (models.find(
        (model) =>
          model.id === configured || model.aliases?.includes(configured),
      ) ?? {
        id: configured,
        name: modelDisplayName(configured),
        description: "",
        isDefault: false,
      })
    : (models.find((model) => model.recommendedFor?.includes(task)) ??
        models.find((model) => model.isDefault));
}

export function ModelSelector({
  disabled,
  onSettings,
}: {
  disabled: boolean;
  onSettings: () => void;
}) {
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
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(false);
  const [effortSaving, setEffortSaving] = useState(false);
  const [animateEffort, setAnimateEffort] = useState(true);
  const effortQueue = useRef<ReasoningEffort | null>(null);
  const effortSaveRunning = useRef(false);
  const [draftEffort, setDraftEffort] = useState<ReasoningEffort | null>(null);
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
  }, [provider, revision, retry]);
  const models = catalog.provider === provider ? catalog.models : [];
  const configuredModel = config?.models[provider] ?? "";
  const usable = usableModels(provider, models, "chat");
  const current = configuredModel
    ? selectedAgentModel(models, configuredModel)
    : selectedAgentModel(usable, "");
  const effortInfo = current?.effortInfo;
  const fixedEffort =
    effortInfo?.mode === "fixed" || effortInfo?.mode === "unknown";
  const currentEffort =
    config?.efforts?.[provider]?.[configuredModel] ?? "medium";
  const effort = draftEffort ?? currentEffort;
  useEffect(() => {
    setDraftEffort(null);
  }, [provider, configuredModel]);
  // An API model that failed its check is never offered again.
  const options =
    current &&
    provider !== "api" &&
    !models.some((model) => model.id === current.id)
      ? [current, ...usable]
      : usable;

  const choose = async (value: string | null) => {
    if (
      !value ||
      value === configuredModel ||
      useReaderStore.getState().aiModelSaving
    )
      return;
    setAIModelSaving(true);
    try {
      const latest = await api.aiConfig();
      if (latest.primary !== provider) {
        setAIConfig(latest);
        throw new Error("Agent SDK 已改变，请重新选择模型");
      }
      setAIConfig(
        await api.saveAIConfig({
          ...latest,
          models: { ...latest.models, [provider]: value },
        }),
      );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setAIModelSaving(false);
    }
  };
  const chooseEffort = async (value: ReasoningEffort) => {
    if (useReaderStore.getState().aiModelSaving && !effortSaveRunning.current)
      return;
    setDraftEffort(value);
    effortQueue.current = value;
    if (effortSaveRunning.current) return;
    effortSaveRunning.current = true;
    setEffortSaving(true);
    setAIModelSaving(true);
    try {
      // Keep interaction immediate; serialize writes so an older response
      // cannot replace a more recent choice or clear an in-progress drag.
      while (effortQueue.current !== null) {
        const next = effortQueue.current;
        effortQueue.current = null;
        const latest = await api.aiConfig();
        if (
          latest.primary !== provider ||
          (latest.models[provider] ?? "") !== configuredModel
        ) {
          setAIConfig(latest);
          throw new Error("模型已改变，请重新选择 Effort");
        }
        setAIConfig(
          await api.saveAIConfig({
            ...latest,
            efforts: {
              ...latest.efforts,
              [provider]: {
                ...latest.efforts?.[provider],
                [configuredModel]: next,
              },
            },
          }),
        );
        setDraftEffort((draft) => (draft === next ? null : draft));
      }
    } catch (error) {
      effortQueue.current = null;
      setDraftEffort(null);
      toast.error((error as Error).message);
    } finally {
      effortSaveRunning.current = false;
      setEffortSaving(false);
      setAIModelSaving(false);
    }
  };
  if (!provider)
    return (
      <Button
        className="model-select-trigger"
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onSettings}
      >
        选择模型
      </Button>
    );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setDraftEffort(null);
        if (next && error) setRetry((value) => value + 1);
      }}
    >
      <PopoverTrigger
        render={<Button variant="ghost" size="sm" />}
        className="model-select-trigger"
        aria-label="选择模型和 Effort"
        disabled={disabled}
      >
        <ProviderIcon provider={provider} size={20} />
        <span className="model-trigger-name">
          {current?.name ?? (loading ? "加载模型…" : "选择模型")}
        </span>
        <span className="model-trigger-effort">
          {fixedEffort ? "固定／自动" : effortLabel(currentEffort)}
        </span>
      </PopoverTrigger>
      <PopoverContent
        className="effort-panel"
        side="top"
        align="start"
        sideOffset={8}
      >
        <div className="effort-heading">
          <Zap size={16} className="effort-symbol" aria-hidden="true" />
          <PopoverTitle className="effort-title" aria-live="polite">
            {fixedEffort ? "固定／自动" : effortLabel(effort)}
          </PopoverTitle>
          <Button
            variant="ghost"
            size="icon"
            className="effort-reset"
            aria-label="恢复默认 Effort"
            title="恢复默认 Effort（Medium）"
            disabled={
              disabled ||
              fixedEffort ||
              (saving && !effortSaving) ||
              effort === "medium"
            }
            onClick={() => {
              setAnimateEffort(true);
              void chooseEffort("medium");
            }}
          >
            <RotateCcw size={16} />
          </Button>
          <Select
            value={configuredModel ? (current?.id ?? null) : null}
            disabled={disabled || saving}
            onValueChange={(value) => void choose(value)}
          >
            <SelectTrigger
              className="effort-model-trigger shadow-none"
              aria-label="选择模型"
              aria-busy={loading || saving}
            >
              <SelectValue>
                {current?.name ?? (loading ? "加载模型…" : "选择模型")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              className="model-select-menu"
              side="top"
              align="center"
              sideOffset={8}
              alignItemWithTrigger={false}
            >
              {options.map((model) => (
                <SelectItem
                  key={model.id}
                  value={model.id}
                  label={model.name}
                  className="model-select-option"
                >
                  <span className="model-select-name">{model.name}</span>
                </SelectItem>
              ))}
              {loading && (
                <div className="model-select-status" role="status">
                  正在获取模型…
                </div>
              )}
              {!loading && error && (
                <div className="model-select-status" role="alert">
                  {error}。关闭后重新打开可重试。
                </div>
              )}
              {!loading && !error && options.length === 0 && (
                <div className="model-select-status">暂无可用模型</div>
              )}
            </SelectContent>
          </Select>
        </div>
        {effortInfo && (
          <p className="text-xs text-muted-foreground" role="status">
            {effortInfo.note}
            {!fixedEffort &&
            effortInfo.mappings?.[effort] &&
            effortInfo.mappings[effort] !== effort
              ? ` ${effort} → ${effortInfo.mappings[effort]}${effortInfo.mode === "budget" ? " tokens" : ""}`
              : ""}
          </p>
        )}
        <div className="effort-slider-wrap">
          <Slider
            className="effort-slider"
            min={0}
            max={3}
            step={1}
            value={[efforts.indexOf(effort)]}
            disabled={disabled || fixedEffort || (saving && !effortSaving)}
            data-instant={!animateEffort || undefined}
            style={
              {
                "--effort-position": efforts.indexOf(effort) / 3,
              } as CSSProperties
            }
            thumbLabel="Effort"
            getAriaValueText={(_, value) => effortLabel(efforts[value]!)}
            onValueChange={(value, details) => {
              setAnimateEffort(details.reason !== "keyboard");
              setDraftEffort(effortFromSlider(value));
            }}
            onValueCommitted={(value) =>
              void chooseEffort(effortFromSlider(value))
            }
          />
          <div className="effort-ticks" aria-hidden="true">
            {efforts.map((value) => (
              <span key={value} />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The API agent's catalog carries per-model check results; reload it after
 * the address, the added models or any model check changes. */
export function catalogRevision(config: AIConfig | null | undefined) {
  if (config?.primary !== "api") return "";
  const checks = Object.entries(config.capabilities)
    .filter(([key]) => key.startsWith("api:"))
    .map(([key, value]) => `${key}@${value.checkedAt}`)
    .sort();
  return [
    JSON.stringify(config.apiProviders),
    config.api.url,
    config.api.protocol ?? "auto",
    ...(config.apiModels ?? []),
    JSON.stringify(config.apiEnabledModels),
    ...checks,
  ].join("\n");
}

/** API models are offered only for tasks whose checks they passed. */
export function usableModels(
  provider: string,
  models: AgentModel[],
  task: ModelTask,
) {
  if (provider !== "api") return models;
  return models.filter(
    (model) =>
      model.enabled !== false &&
      model.capability?.text &&
      (task !== "vision" || model.capability.vision),
  );
}
