import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  FileText,
  Bot,
  Check,
  CircleCheck,
  CircleHelp,
  Highlighter,
  Library,
  LoaderCircle,
  Monitor,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { DiagnosticExport } from "./DiagnosticExport";
import { CommandLineSettings } from "./CommandLineSettings";
import { ProviderIdentity } from "./ProviderIdentity";
import { TaskModels } from "./TaskModels";
import {
  APIProviderSettings,
  splitModelRef,
  modelRef,
} from "./APIProviderSettings";
import { APIPricingForm } from "./APIPricingForm";
import { ModelTimeoutForm } from "./APITimeouts";
import { APIAgentForm, APIModelForm } from "./APIAgentForm";
import { api } from "@reader/api";
import type {
  AICapability,
  AIConfig,
  AgentModel,
  APIConnection,
  LibraryMode,
  JournalRankConfig,
  Provider,
} from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Input } from "@reader/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@reader/ui/components/dialog";
import { Badge } from "@reader/ui/components/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@reader/ui/components/select";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@reader/ui/components/tooltip";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@reader/ui/components/tabs";
import { HighlightColorsEditor } from "./HighlightColorsEditor";
import { ProxySettings } from "./ProxySettings";
import {
  primaryLibraryMode,
  updateLibraryPreferences,
  useReaderStore,
} from "./store";
import { libraryModes } from "./LibraryModeSwitcher";
import { Checkbox } from "@reader/ui/components/checkbox";
import { toast } from "sonner";
export function Settings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const {
    theme,
    setTheme,
    aiConfig: config,
    setAIConfig,
    aiModelSaving,
    libraryPreferences,
  } = useReaderStore();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [testing, setTesting] = useState<Map<string, "text" | "vision">>(
    new Map(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const checked = useRef(new Set<string>());
  const refreshing = useRef(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [apiModels, setAPIModels] = useState<AgentModel[]>([]);
  const [apiModelsError, setAPIModelsError] = useState("");
  const [apiDetails, setAPIDetails] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("default");
  const providerRecord = config?.apiProviders?.find(
    (p) => p.id === selectedProvider,
  );
  useEffect(() => {
    if (
      config?.apiProviders?.length &&
      !config.apiProviders.some((p) => p.id === selectedProvider)
    )
      setSelectedProvider(config.apiProviders[0]!.id);
  }, [config?.apiProviders, selectedProvider]);
  const visibleAPIModels = apiModels.filter(
    (m) => !config?.apiProviders || splitModelRef(m.id)[0] === selectedProvider,
  );
  const connection = providerRecord?.connection ?? config?.api;
  const providerView = (latest: AIConfig): AIConfig => {
    if (!latest.apiProviders) return latest;
    const p = latest.apiProviders.find((p) => p.id === selectedProvider);
    return {
      ...latest,
      api: p?.connection ?? { url: "", model: "", hasKey: false },
      apiModels: (p?.models ?? []).map((id) => modelRef(selectedProvider, id)),
      apiEnabledModels: p?.enabledModels?.map((id) =>
        modelRef(selectedProvider, id),
      ),
    };
  };
  const changeProvider = (
    latest: AIConfig,
    change: (view: AIConfig) => AIConfig,
  ): AIConfig => {
    if (!latest.apiProviders) return change(latest);
    const next = change(providerView(latest));
    return {
      ...latest,
      apiProviders: latest.apiProviders.map((p) =>
        p.id === selectedProvider
          ? {
              ...p,
              connection: next.api,
              models: (next.apiModels ?? []).map((id) => splitModelRef(id)[1]),
              enabledModels: next.apiEnabledModels?.map(
                (id) => splitModelRef(id)[1],
              ),
            }
          : p,
      ),
    };
  };
  const [connector, setConnector] = useState<Awaited<
    ReturnType<typeof api.connectorStatus>
  > | null>(null);
  const [journalRank, setJournalRank] = useState<JournalRankConfig | null>(
    null,
  );
  const [journalKey, setJournalKey] = useState("");
  const [journalSaving, setJournalSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    let mounted = true;
    void api
      .journalRankConfig()
      .then((config) => {
        if (mounted) setJournalRank(config);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [open]);
  const saveJournalRank = async (
    patch: Partial<
      Pick<JournalRankConfig, "enabled" | "filterMode" | "selected">
    >,
    key?: string,
  ) => {
    if (!journalRank) return;
    setJournalSaving(true);
    try {
      const saved = await api.saveJournalRankConfig({
        enabled: patch.enabled ?? journalRank.enabled,
        filterMode: patch.filterMode ?? journalRank.filterMode,
        selected: patch.selected ?? journalRank.selected,
        ...(key !== undefined ? { key } : {}),
      });
      setJournalRank(saved);
      setJournalKey("");
      window.dispatchEvent(new Event("reader:journal-rank-config"));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setJournalSaving(false);
    }
  };
  useEffect(() => {
    if (!open) setAPIDetails(false);
  }, [open]);
  useEffect(() => {
    if (open)
      void api
        .connectorStatus()
        .then(setConnector)
        .catch(() => setConnector(null));
  }, [open]);
  const paperPreferences =
    useReaderStore((s) => s.libraryPreferences.papers) || {};
  // CLI agents check text then vision; API models check only the requested stage.
  // Drop a result if its configuration changed meanwhile.
  const check = async (
    id: string,
    first: "text" | "vision",
    snapshot: AIConfig,
  ) => {
    const model = id.startsWith("api:") ? id.slice(4) : undefined;
    const run = (stage: "text" | "vision") =>
      model ? api.testAI("api", stage, model) : api.testAI(id, stage);
    let stage = first;
    const update = (capability: AICapability) => {
      const current = useReaderStore.getState().aiConfig;
      if (
        !current ||
        (model
          ? JSON.stringify(current.apiProviders ?? current.api) !==
            JSON.stringify(snapshot.apiProviders ?? snapshot.api)
          : current.models[id] !== snapshot.models[id])
      )
        return false;
      setAIConfig({
        ...current,
        capabilities: { ...current.capabilities, [id]: capability },
      });
      return true;
    };
    try {
      if (stage === "text") {
        const capability = await run("text");
        if (!update(capability) || !capability.text) return;
        if (model) return;
        stage = "vision";
        setTesting((current) => new Map(current).set(id, "vision"));
      }
      update(await run("vision"));
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [`${id}:${stage}`]: (error as Error).message,
      }));
    } finally {
      setTesting((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    }
  };
  const checkAll = async (
    ids: string[],
    firstStage: (id: string) => "text" | "vision",
    snapshot: AIConfig,
  ) => {
    setTesting((current) => {
      const next = new Map(current);
      for (const id of ids) next.set(id, firstStage(id));
      return next;
    });
    setErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([key]) => !ids.some((id) => key.startsWith(`${id}:`)),
        ),
      ),
    );
    const pending = [...ids];
    await Promise.all(
      Array.from({ length: Math.min(2, pending.length) }, async () => {
        for (let id = pending.shift(); id; id = pending.shift())
          await check(id, firstStage(id), snapshot);
      }),
    );
  };
  const refresh = async (force = false) => {
    if (refreshing.current) return;
    refreshing.current = true;
    setLoading(true);
    try {
      const [providers, config] = await Promise.all([
        api.providers(false),
        api.aiConfig(),
      ]);
      setProviders(providers);
      setAIConfig(config);
      // CLI agents are checked as a whole, the API agent one model at a time.
      const pending = providers
        .filter((provider) => {
          if (provider.id === "api" || !provider.installed) return false;
          // Saved results survive dialog remounts and application restarts.
          // Only an explicit retry replaces an existing result, including failures.
          if (
            !force &&
            config.capabilities[provider.id] &&
            !config.capabilities[provider.id].pendingVision
          )
            return false;
          const key = JSON.stringify([provider.id, config.models[provider.id]]);
          if (!force && checked.current.has(key)) return false;
          checked.current.add(key);
          return true;
        })
        .map(({ id }) => id);
      let models: AgentModel[] = [];
      if (providers.some(({ id, installed }) => id === "api" && installed)) {
        try {
          models = await api.agentModels("api");
          setAPIModelsError("");
        } catch (error) {
          setAPIModelsError((error as Error).message);
        }
      }
      setAPIModels(models);
      const firstStage = (id: string): "text" | "vision" =>
        !force && config.capabilities[id]?.pendingVision ? "vision" : "text";
      setLoading(false);
      await checkAll(pending, firstStage, config);
    } catch (e) {
      toast.error(String(e));
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  };
  useEffect(() => {
    if (open) void refresh();
  }, [open]);
  const modelEnabled = (model: AgentModel, value = config) =>
    value
      ? (providerView(value).apiEnabledModels?.includes(model.id) ?? true)
      : true;
  const checkModels = async (stage: "text" | "vision", model?: AgentModel) => {
    const snapshot = useReaderStore.getState().aiConfig;
    if (!snapshot || testing.size || saving) return;
    const selected = (model ? [model] : visibleAPIModels).filter(
      (item) =>
        modelEnabled(item, snapshot) &&
        (stage === "text" || snapshot.capabilities[`api:${item.id}`]?.text),
    );
    await checkAll(
      selected.map((item) => `api:${item.id}`),
      () => stage,
      snapshot,
    );
  };
  const checkTools = async (model: AgentModel) => {
    const snapshot = useReaderStore.getState().aiConfig;
    if (!snapshot) return;
    setSaving(true);
    try {
      const capability = await api.testAI("api", "tools", model.id);
      const current = useReaderStore.getState().aiConfig;
      if (
        current &&
        JSON.stringify(current.apiProviders ?? current.api) ===
          JSON.stringify(snapshot.apiProviders ?? snapshot.api)
      )
        setAIConfig({
          ...current,
          capabilities: {
            ...current.capabilities,
            [`api:${model.id}`]: capability,
          },
        });
      if (capability.tools !== "passed")
        toast.error(
          capability.toolError || "工具调用未通过，仍可使用检索辅助回答",
        );
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const saveConfig = async (change: (latest: AIConfig) => AIConfig) => {
    setSaving(true);
    try {
      setAIConfig(await api.saveAIConfig(change(await api.aiConfig())));
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
    await refresh();
    return true;
  };
  const saveAPI = async (connection: APIConnection) => {
    if (
      !(await saveConfig((latest) =>
        changeProvider(latest, (view) => ({ ...view, api: connection })),
      ))
    )
      throw new Error("保存失败");
  };
  const saveAPIModels = async (change: (models: string[]) => string[]) => {
    if (
      !(await saveConfig((latest) =>
        changeProvider(latest, (view) => ({
          ...view,
          apiModels: change(view.apiModels ?? []),
        })),
      ))
    )
      throw new Error("保存失败");
  };
  const enabledModelIDs = (latest: AIConfig) =>
    latest.apiEnabledModels ?? [
      ...new Set(
        [
          ...visibleAPIModels.map((model) => model.id),
          ...(latest.apiModels ?? []),
          latest.models.api,
          latest.translationModels?.api,
          latest.visionModels?.api,
        ].filter(
          (value): value is string =>
            !!value &&
            (!latest.apiProviders ||
              splitModelRef(value)[0] === selectedProvider),
        ),
      ),
    ];
  const setModelEnabled = (id: string, enabled: boolean) =>
    saveConfig((latest) =>
      changeProvider(latest, (view) => {
        const current = enabledModelIDs(view);
        return {
          ...view,
          apiEnabledModels: enabled
            ? [...new Set([...current, id])]
            : current.filter((value) => value !== id),
        };
      }),
    );
  const removeAPIModel = (id: string) =>
    saveConfig((latest) =>
      changeProvider(latest, (view) => ({
        ...view,
        apiModels: (view.apiModels ?? []).filter((value) => value !== id),
        apiEnabledModels: enabledModelIDs(view).filter((value) => value !== id),
      })),
    );
  const checkStatus = (id: string, capability?: AICapability) => (
    <div className="flex flex-wrap gap-x-5">
      {(
        [
          ["text", "文本推理"],
          ["vision", "图片理解"],
        ] as const
      ).map(([kind, label]) => {
        const stage = testing.get(id);
        const pending =
          stage === "text" || (stage === "vision" && kind === "vision");
        const error = errors[`${id}:${kind}`] || capability?.error;
        const ready =
          !errors[`${id}:text`] &&
          !errors[`${id}:${kind}`] &&
          !!capability?.[kind];
        const state = pending ? "pending" : ready ? "passed" : "failed";
        const apiModel = id.startsWith("api:");
        return (
          <div
            key={kind}
            className="agent-check-status"
            role="status"
            aria-live="polite"
            aria-label={`${label}：${pending ? "检测中" : ready ? "已通过" : "未通过"}`}
          >
            <span className="agent-check-icon" key={state} data-state={state}>
              {pending ? (
                <LoaderCircle className="animate-spin" />
              ) : ready ? (
                <CircleCheck />
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={<Button variant="ghost" size="icon" />}
                    className="size-4 p-0 text-inherit hover:bg-transparent hover:text-inherit"
                    aria-label={`${label}未通过：查看详情`}
                  >
                    <TriangleAlert />
                  </TooltipTrigger>
                  <TooltipContent className="block max-w-xs space-y-2 leading-5 break-words">
                    <p>
                      {error ||
                        (capability?.text
                          ? "文本推理可用，图片理解未通过检测。"
                          : apiModel
                            ? "检测未通过，请检查 API 地址、Key、模型名称、网络或额度。"
                            : "检测未通过，请检查终端中的 Agent、API 配置、网络或额度。")}
                    </p>
                    {!capability?.text && !apiModel && (
                      <p>
                        支持 CLI 当前使用的订阅登录或 API Key
                        配置；以实际调用结果为准。
                      </p>
                    )}
                  </TooltipContent>
                </Tooltip>
              )}
            </span>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
  const apiCardStatus = () => (
    <span className="flex flex-wrap gap-x-5">
      {(["text", "vision"] as const).map((kind) => {
        const label = kind === "text" ? "文本推理" : "图片理解";
        // The API agent uses a separate model for each task. One passing model
        // is enough for the corresponding capability on this summary card.
        const ready = apiModels.some((model) => {
          const id = `api:${model.id}`;
          return (
            modelEnabled(model) &&
            !errors[`${id}:text`] &&
            !errors[`${id}:${kind}`] &&
            config?.capabilities[id]?.[kind]
          );
        });
        const pending =
          !ready &&
          (loading || [...testing.keys()].some((id) => id.startsWith("api:")));
        const state = pending ? "pending" : ready ? "passed" : "failed";
        return (
          <span
            key={kind}
            className="agent-check-status"
            role="status"
            aria-live="polite"
            aria-label={`${label}：${pending ? "检测中" : ready ? "已通过" : "未通过"}`}
          >
            <span className="agent-check-icon" data-state={state}>
              {pending ? (
                <LoaderCircle className="animate-spin" />
              ) : ready ? (
                <CircleCheck />
              ) : (
                <TriangleAlert />
              )}
            </span>
            <span>{label}</span>
          </span>
        );
      })}
    </span>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog p-6 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {apiDetails ? (
              <Button
                variant="ghost"
                className="-ml-2 gap-1 px-2 text-base"
                onClick={() => setAPIDetails(false)}
                aria-label="返回 Agent 设置"
              >
                <ChevronLeft />
                API 配置
              </Button>
            ) : (
              "设置"
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Agent 连接、显示、阅读、诊断与论文库
          </DialogDescription>
        </DialogHeader>
        {apiDetails && (
          <div className="settings-panel">
            <section>
              {config?.apiProviders && (
                <APIProviderSettings
                  providers={config.apiProviders}
                  selected={selectedProvider}
                  disabled={saving || testing.size > 0}
                  onSelect={setSelectedProvider}
                  onAdd={() => {
                    const id = crypto.randomUUID();
                    void saveConfig((latest) => ({
                      ...latest,
                      apiProviders: [
                        ...(latest.apiProviders ?? []),
                        {
                          id,
                          name: "新提供商",
                          connection: { url: "", model: "", hasKey: false },
                          models: [],
                          enabledModels: [],
                        },
                      ],
                    })).then((ok) => {
                      if (ok) setSelectedProvider(id);
                    });
                  }}
                  onRename={(name) => {
                    void saveConfig((latest) => ({
                      ...latest,
                      apiProviders: latest.apiProviders?.map((p) =>
                        p.id === selectedProvider ? { ...p, name } : p,
                      ),
                    }));
                  }}
                  onDelete={() => {
                    void saveConfig((latest) => ({
                      ...latest,
                      apiProviders: latest.apiProviders?.filter(
                        (p) => p.id !== selectedProvider,
                      ),
                    }));
                  }}
                />
              )}
              {config &&
                connection &&
                (!config.apiProviders || providerRecord) && (
                  <APIAgentForm
                    key={selectedProvider}
                    connection={connection}
                    disabled={saving || testing.size > 0}
                    onSave={saveAPI}
                  />
                )}
              {config && connection?.url && (
                <div className="mt-6">
                  <h3 className="mb-1 text-sm font-medium">启用模型</h3>
                  <div className="mb-2 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="刷新模型列表"
                      disabled={loading || saving || testing.size > 0}
                      onClick={() => void refresh()}
                    >
                      刷新列表
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="检测已启用模型的文本"
                      disabled={
                        saving ||
                        testing.size > 0 ||
                        !visibleAPIModels.some((model) => modelEnabled(model))
                      }
                      onClick={() => void checkModels("text")}
                    >
                      检测文本
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="检测已启用模型的图片"
                      disabled={
                        saving ||
                        testing.size > 0 ||
                        !visibleAPIModels.some(
                          (model) =>
                            modelEnabled(model) &&
                            config.capabilities[`api:${model.id}`]?.text,
                        )
                      }
                      onClick={() => void checkModels("vision")}
                    >
                      检测图片
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="停用全部模型"
                      disabled={saving || testing.size > 0}
                      onClick={() =>
                        void saveConfig((latest) =>
                          changeProvider(latest, (view) => ({
                            ...view,
                            apiEnabledModels: [],
                          })),
                        )
                      }
                    >
                      全部停用
                    </Button>
                  </div>
                  <ul className="api-model-list">
                    {visibleAPIModels.map((model) => {
                      const id = `api:${model.id}`;
                      const result = config.capabilities[id];
                      return (
                        <li
                          key={model.id}
                          className="flex min-h-9 flex-wrap items-center gap-3"
                        >
                          <Checkbox
                            aria-label={`启用 ${model.id}`}
                            checked={modelEnabled(model)}
                            disabled={saving || testing.size > 0}
                            onCheckedChange={(value) =>
                              void setModelEnabled(model.id, !!value)
                            }
                          />
                          <span
                            className="min-w-24 flex-1 truncate text-sm"
                            title={model.id}
                          >
                            {model.name}
                          </span>
                          {(testing.has(id) ||
                            result ||
                            errors[`${id}:text`]) &&
                            checkStatus(id, result)}
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`检测 ${model.id} 文本`}
                            disabled={
                              saving || testing.size > 0 || !modelEnabled(model)
                            }
                            onClick={() => void checkModels("text", model)}
                          >
                            文本
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`检测 ${model.id} 图片`}
                            disabled={
                              saving ||
                              testing.size > 0 ||
                              !modelEnabled(model) ||
                              !result?.text
                            }
                            onClick={() => void checkModels("vision", model)}
                          >
                            图片
                          </Button>
                          {result?.error && (
                            <span
                              className="w-full break-words text-xs text-muted-foreground"
                              title={result.error}
                            >
                              {result.error}
                            </span>
                          )}
                          {(result?.textLastSucceededAt ||
                            result?.visionLastSucceededAt) && (
                            <span className="w-full text-xs text-muted-foreground">
                              最近成功{" "}
                              {result.textLastSucceededAt &&
                                `文本 ${result.textLastSucceededAt}`}{" "}
                              {result.visionLastSucceededAt &&
                                `图片 ${result.visionLastSucceededAt}`}
                            </span>
                          )}
                          {result?.text && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={
                                saving ||
                                testing.size > 0 ||
                                !modelEnabled(model)
                              }
                              onClick={() => void checkTools(model)}
                              title={result.toolError}
                            >
                              {result.tools === "passed"
                                ? "检索工具已通过"
                                : "检测检索工具"}
                            </Button>
                          )}
                          {model.custom && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`移除 ${model.name}`}
                              title="移除"
                              disabled={saving || testing.size > 0}
                              onClick={() => void removeAPIModel(model.id)}
                            >
                              <X />
                            </Button>
                          )}
                          {providerRecord && (
                            <details className="w-full text-xs text-muted-foreground motion-safe:animate-in motion-safe:fade-in">
                              <summary
                                aria-label={`${model.id} 模型设置`}
                                className="cursor-pointer py-2"
                              >
                                {model.name} 设置
                              </summary>
                              <APIPricingForm
                                model={model.id}
                                value={
                                  providerRecord.modelOverrides?.[
                                    splitModelRef(model.id)[1]
                                  ]?.pricing
                                }
                                disabled={saving || testing.size > 0}
                                onSave={(pricing) =>
                                  saveConfig((latest) => ({
                                    ...latest,
                                    apiProviders: latest.apiProviders?.map(
                                      (p) =>
                                        p.id === selectedProvider
                                          ? {
                                              ...p,
                                              modelOverrides: {
                                                ...p.modelOverrides,
                                                [splitModelRef(model.id)[1]]: {
                                                  ...p.modelOverrides?.[
                                                    splitModelRef(model.id)[1]
                                                  ],
                                                  pricing,
                                                },
                                              },
                                            }
                                          : p,
                                    ),
                                  }))
                                }
                              />
                              <ModelTimeoutForm
                                model={model.id}
                                value={
                                  providerRecord.modelOverrides?.[
                                    splitModelRef(model.id)[1]
                                  ]
                                }
                                inherited={providerRecord.connection}
                                disabled={saving || testing.size > 0}
                                onSave={(value) =>
                                  saveConfig((latest) => ({
                                    ...latest,
                                    apiProviders: latest.apiProviders?.map(
                                      (p) =>
                                        p.id === selectedProvider
                                          ? {
                                              ...p,
                                              modelOverrides: {
                                                ...p.modelOverrides,
                                                [splitModelRef(model.id)[1]]: {
                                                  ...value,
                                                  pricing:
                                                    p.modelOverrides?.[
                                                      splitModelRef(model.id)[1]
                                                    ]?.pricing,
                                                },
                                              },
                                            }
                                          : p,
                                    ),
                                  }))
                                }
                              />
                            </details>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {apiModelsError && (
                    <p
                      className="mt-1 text-xs text-muted-foreground"
                      role="alert"
                    >
                      {apiModelsError}
                    </p>
                  )}
                  <APIModelForm
                    disabled={saving}
                    onAdd={(id) =>
                      saveAPIModels((models) => [
                        ...models,
                        modelRef(selectedProvider, id),
                      ])
                    }
                  />
                </div>
              )}
            </section>
          </div>
        )}
        <Tabs
          defaultValue="agent"
          className="settings-tabs"
          style={{ display: apiDetails ? "none" : undefined }}
        >
          <TabsList aria-label="设置分类" className="settings-nav">
            <TabsTrigger value="agent">
              <Bot />
              Agent
            </TabsTrigger>
            <TabsTrigger value="display">
              <Monitor />
              显示
            </TabsTrigger>
            <TabsTrigger value="reading">
              <Highlighter />
              阅读
            </TabsTrigger>
            <TabsTrigger value="diagnostics">
              <FileText />
              诊断
            </TabsTrigger>
            <TabsTrigger value="papers">
              <Library />
              论文库
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="diagnostics"
            className="settings-panel"
            keepMounted
          >
            {window.readerDesktop?.proxySettings && (
              <div className="mb-6">
                <ProxySettings open={open} />
              </div>
            )}
            <section>
              <h3 className="mb-3 text-sm font-medium">本地日志</h3>
              <p className="mb-4 text-xs leading-5 text-muted-foreground">
                导出全部已保留日志和运行环境供开发者排查。凭据、用户路径和翻译诊断中的正文会脱敏；不包含文档、聊天或批注。日志最多保留
                7 天、100 MiB，仅在本机保存。
              </p>
              <DiagnosticExport />
            </section>
          </TabsContent>
          <TabsContent value="display" className="settings-panel" keepMounted>
            <section className="mb-6">
              <h3
                id="primary-library-label"
                className="mb-3 text-sm font-medium"
              >
                主要模式
              </h3>
              <Select
                value={primaryLibraryMode(libraryPreferences)}
                onValueChange={(value) => {
                  if (value !== "papers" && value !== "books") return;
                  void updateLibraryPreferences({ primaryMode: value }).catch(
                    (error) => toast.error((error as Error).message),
                  );
                }}
              >
                <SelectTrigger
                  aria-labelledby="primary-library-label"
                  className="w-48"
                >
                  <SelectValue>
                    {libraryModes[primaryLibraryMode(libraryPreferences)].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(libraryModes) as LibraryMode[]).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {libraryModes[mode].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-2 text-xs text-muted-foreground">
                下次启动时默认进入此模式。
              </p>
            </section>
            <section>
              <h3 className="mb-3 text-sm font-medium">界面主题</h3>
              <div className="flex gap-2">
                {(["light", "sepia", "dark", "system"] as const).map(
                  (mode, i) => (
                    <Button
                      key={mode}
                      aria-pressed={(theme.appearance ?? "system") === mode}
                      variant={
                        (theme.appearance ?? "system") === mode
                          ? "default"
                          : "outline"
                      }
                      onClick={() =>
                        setTheme({
                          appearance: mode,
                          mode:
                            mode === "dark" || mode === "sepia"
                              ? mode
                              : "light",
                        })
                      }
                    >
                      {["浅色", "纸张", "深色", "跟随系统"][i]}
                      {(theme.appearance ?? "system") === mode && (
                        <Check className="size-3" />
                      )}
                    </Button>
                  ),
                )}
              </div>
            </section>
          </TabsContent>
          <TabsContent value="reading" className="settings-panel" keepMounted>
            <section className="mb-6 space-y-4">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={theme.autoGenerateOverview ?? false}
                  onCheckedChange={(checked) =>
                    setTheme({ autoGenerateOverview: !!checked })
                  }
                />
                <span>
                  导入后生成文档概要
                  <span className="block text-xs text-muted-foreground">
                    使用已配置的文字模型，单独记录用量；已有文档按需生成。
                  </span>
                </span>
              </label>
              <label className="block text-sm">
                文档上下文上限（可选）
                <Input
                  className="mt-2 max-w-48"
                  type="number"
                  min={8192}
                  max={1048576}
                  step={1024}
                  defaultValue={theme.documentContextTokens || ""}
                  placeholder="自动获取"
                  key={theme.documentContextTokens}
                  onBlur={(e) => {
                    const n = Number(e.currentTarget.value);
                    if (
                      Number.isInteger(n) &&
                      (n === 0 || n >= 8192) &&
                      n <= 1048576
                    )
                      setTheme({ documentContextTokens: n });
                    else
                      e.currentTarget.value = String(
                        theme.documentContextTokens || "",
                      );
                  }}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  优先读取模型信息或 Codex 配置；留空为自动，未知时采用
                  64K。填写后只限制上限。
                </span>
              </label>
            </section>
            <section className="mb-6">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={theme.autoCopySelection === true}
                  onCheckedChange={(checked) =>
                    setTheme({ autoCopySelection: !!checked })
                  }
                />
                <span>
                  自动复制选中文字
                  <span className="block text-xs text-muted-foreground">
                    选中文字或点击高亮、划线等批注时，自动复制到剪贴板
                  </span>
                </span>
              </label>
            </section>
            <section className="mb-6">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={theme.linkTranslationAnnotations !== false}
                  onCheckedChange={(checked) =>
                    setTheme({ linkTranslationAnnotations: !!checked })
                  }
                />
                <span>
                  译文原文划线关联
                  <span className="block text-xs text-muted-foreground">
                    悬停与批注同步到另一侧对应的完整句子
                  </span>
                </span>
              </label>
            </section>
            <section>
              <h3 className="mb-3 text-sm font-medium">高亮颜色</h3>
              <HighlightColorsEditor />
            </section>
          </TabsContent>
          <TabsContent value="papers" className="settings-panel" keepMounted>
            <section>
              <h3 className="mb-3 text-sm font-medium">论文库</h3>
              <div className="mb-5 rounded-md border p-3 text-sm">
                <div className="font-medium">浏览器收录插件</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  启动 Reader 后，Chrome 插件会自动连接本机论文库。
                </p>
                {connector && !connector.available && (
                  <p
                    className={`mt-2 text-xs ${connector.reason === "disabled" ? "text-muted-foreground" : "text-destructive"}`}
                  >
                    {connector.reason === "disabled"
                      ? "开发模式未启用插件连接。"
                      : "本机端口 17841 被占用，插件连接不可用。"}
                  </p>
                )}
              </div>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={paperPreferences.autoLookup !== false}
                  onCheckedChange={(checked) =>
                    void updateLibraryPreferences({
                      papers: { ...paperPreferences, autoLookup: !!checked },
                    }).catch((e) => toast.error(e.message))
                  }
                />
                <span>
                  导入 PDF 后自动补全论文信息
                  <span className="block text-xs text-muted-foreground">
                    只把文中的 DOI 或 arXiv 编号发送给 arXiv、Crossref 与
                    Semantic Scholar
                  </span>
                </span>
              </label>
              <label className="mt-4 flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={theme.autoTranslatePDF ?? true}
                  onCheckedChange={(checked) =>
                    setTheme({ autoTranslatePDF: !!checked })
                  }
                />
                <span>
                  导入后自动翻译
                  <span className="block text-xs text-muted-foreground">
                    开启后，新导入的论文会自动翻译全文。
                  </span>
                </span>
              </label>
            </section>
            <section className="mt-7 border-t pt-5">
              <h3 className="mb-3 text-sm font-medium">期刊指标</h3>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={journalRank?.enabled ?? true}
                  disabled={!journalRank || journalSaving}
                  onCheckedChange={(checked) =>
                    void saveJournalRank({ enabled: !!checked })
                  }
                />
                <span>
                  在论文库显示 easyScholar 期刊指标
                  <span className="block text-xs text-muted-foreground">
                    默认开启；配置 SecretKey 后按论文出处查询。
                  </span>
                </span>
              </label>
              {journalRank?.enabled && (
                <>
                  <div className="mt-4 flex items-center gap-2">
                    <Input
                      type="password"
                      autoComplete="off"
                      aria-label="easyScholar SecretKey"
                      placeholder={
                        journalRank.hasKey
                          ? "已保存 SecretKey；输入新密钥可替换"
                          : "输入 easyScholar SecretKey"
                      }
                      value={journalKey}
                      onChange={(event) => setJournalKey(event.target.value)}
                    />
                    <Button
                      variant="outline"
                      disabled={!journalKey.trim() || journalSaving}
                      onClick={() =>
                        void saveJournalRank({}, journalKey.trim())
                      }
                    >
                      保存
                    </Button>
                  </div>
                  <div className="mt-4 flex items-center gap-2 text-xs">
                    <span id="journal-rank-filter-label">指标筛选</span>
                    <Select
                      value={journalRank.filterMode}
                      onValueChange={(value) => {
                        if (value !== "include" && value !== "exclude") return;
                        void saveJournalRank({
                          filterMode: value,
                          selected:
                            value === "include"
                              ? journalRank.available.map((field) => field.key)
                              : [],
                        });
                      }}
                      disabled={journalSaving}
                    >
                      <SelectTrigger
                        aria-labelledby="journal-rank-filter-label"
                        className="w-48"
                      >
                        <SelectValue>
                          {journalRank.filterMode === "include"
                            ? "只显示选中的指标"
                            : "隐藏选中的指标"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="include">
                          只显示选中的指标
                        </SelectItem>
                        <SelectItem value="exclude">隐藏选中的指标</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {journalRank.filterMode === "include"
                      ? "勾选要显示的指标。"
                      : "勾选不想显示的指标。"}
                    无数据或超出标题列宽度的标签会省略。
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                    {journalRank.available.map((field) => (
                      <label
                        key={field.key}
                        className="flex min-w-0 items-center gap-2 text-xs"
                      >
                        <Checkbox
                          checked={journalRank.selected.includes(field.key)}
                          disabled={journalSaving}
                          onCheckedChange={(checked) =>
                            void saveJournalRank({
                              selected: checked
                                ? [...journalRank.selected, field.key]
                                : journalRank.selected.filter(
                                    (value) => value !== field.key,
                                  ),
                            })
                          }
                        />
                        <span className="truncate" title={field.name}>
                          {field.name}
                        </span>
                      </label>
                    ))}
                  </div>
                  {journalRank.hasKey && (
                    <Button
                      className="mt-4"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        window.dispatchEvent(
                          new Event("reader:journal-rank-refresh"),
                        )
                      }
                    >
                      <RefreshCw />
                      刷新当前列表的期刊指标
                    </Button>
                  )}
                </>
              )}
            </section>
          </TabsContent>
          <TabsContent value="agent" className="settings-panel" keepMounted>
            <section>
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-medium">Agent 连接</h3>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="重新检测 Agent"
                  title="重新检测 Agent"
                  disabled={loading || testing.size > 0}
                  onClick={() => void refresh(true)}
                >
                  <RefreshCw className={loading ? "animate-spin" : ""} />
                </Button>
              </div>
              {config && (
                <div className="mb-4 flex flex-col gap-2">
                  <label className="text-sm" id="primary-agent-label">
                    Agent SDK
                  </label>
                  <Select
                    value={config.primary || null}
                    disabled={saving || aiModelSaving || testing.size > 0}
                    onValueChange={async (value) => {
                      if (!value) return;
                      setSaving(true);
                      try {
                        const latest = await api.aiConfig();
                        const saved = await api.saveAIConfig({
                          ...latest,
                          primary: value,
                        });
                        setAIConfig(saved);
                      } catch (e) {
                        toast.error((e as Error).message);
                      } finally {
                        setSaving(false);
                      }
                    }}
                  >
                    <SelectTrigger
                      aria-labelledby="primary-agent-label"
                      className="w-full"
                    >
                      <SelectValue placeholder="请选择 Agent SDK">
                        {config.primary ? (
                          <ProviderIdentity provider={config.primary} />
                        ) : undefined}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="codex">
                        <ProviderIdentity provider="codex" />
                      </SelectItem>
                      <SelectItem value="claude">
                        <ProviderIdentity provider="claude" />
                      </SelectItem>
                      <SelectItem value="kimi">
                        <ProviderIdentity provider="kimi" />
                      </SelectItem>
                      <SelectItem value="api">
                        <ProviderIdentity provider="api" />
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <TaskModels disabled={saving || testing.size > 0} />
                  <p className="text-xs leading-5 text-muted-foreground">
                    {config.primary === "api"
                      ? "只列出通过检测的模型：问答与翻译需通过文本推理，图片需通过图片理解。公式转换与主动图片提问使用图片模型。"
                      : "问答与翻译分别使用上方模型；未指定时，问答使用主力模型，翻译使用快速模型。公式转换与主动图片提问会向此 Agent 发送图片。"}
                  </p>
                </div>
              )}
              <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
                {(["codex", "claude", "kimi", "api"] as const).map((name) => {
                  const p = providers.find((p) => p.id === name);
                  const capability = config?.capabilities[name];
                  const pending = testing.has(name);

                  if (name === "api")
                    return (
                      <Button
                        key={name}
                        variant="outline"
                        className="h-auto min-h-28 min-w-0 flex-col items-stretch justify-start gap-0 rounded-xl border-border bg-transparent p-4 text-left font-normal whitespace-normal hover:bg-muted/50 dark:border-border dark:bg-transparent"
                        onClick={() => setAPIDetails(true)}
                        aria-label="配置 API Key"
                      >
                        <span className="flex w-full items-center gap-3">
                          <span className="flex-1 text-base font-medium">
                            <ProviderIdentity provider={name} size={36} />
                          </span>
                          {!loading && !p?.installed && (
                            <Badge variant="outline">未配置</Badge>
                          )}
                        </span>
                        {p?.installed ? (
                          apiCardStatus()
                        ) : (
                          <span className="mt-3 text-xs text-muted-foreground">
                            点击卡片配置你的apikey
                          </span>
                        )}
                      </Button>
                    );

                  return (
                    <div
                      key={name}
                      className="min-h-28 min-w-0 rounded-xl border p-4"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex-1 text-base font-medium">
                          <ProviderIdentity provider={name} size={36} />
                        </span>
                        {!loading && !p?.installed && (
                          <Badge variant="outline">未安装</Badge>
                        )}
                      </div>
                      {(pending || p?.installed || capability) &&
                        checkStatus(name, capability)}
                    </div>
                  );
                })}
              </div>
              <p className="mt-4 flex gap-2 text-xs leading-5 text-muted-foreground">
                <CircleHelp className="mt-0.5 size-4 shrink-0" />
                Reader 调用已安装的 CLI，不读取账号凭据。AI 请求使用 CLI
                当前账户与计费方式；选择订阅登录时无需另填 API Key。API 连接使用
                OpenAI 兼容接口，Key 保存在本机 Reader
                数据目录。发送的选区或章节会交给对应服务。
              </p>
            </section>
            <CommandLineSettings open={open} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
