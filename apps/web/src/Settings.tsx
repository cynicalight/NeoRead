import { PaperServiceSettings } from "./papers/PaperServiceSettings";
import { AutoTranslationSettings } from "./papers/AutoTranslationSettings";
import { TranslationPromptSettings } from "./TranslationPromptSettings";
import { WebSearchSettings } from "./WebSearchSettings";
import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  FileText,
  Bot,
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
import { LibraryLocationSettings } from "./LibraryLocationSettings";
import { CommandLineSettings } from "./CommandLineSettings";
import { ProviderIdentity } from "./ProviderIdentity";
import { TaskModels } from "./TaskModels";
import { APIAgentForm, APIModelForm } from "./APIAgentForm";
import { api } from "@neoread/api";
import type {
  AICapability,
  AIConfig,
  AgentModel,
  APIConnection,
  LibraryMode,
  JournalRankConfig,
  PaperColumn,
  Provider,
} from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@neoread/ui/components/dialog";
import { Badge } from "@neoread/ui/components/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@neoread/ui/components/select";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@neoread/ui/components/tooltip";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@neoread/ui/components/tabs";
import { CitePluginSettings } from "./cite/CitePluginSettings";
import { HighlightColorsEditor } from "./HighlightColorsEditor";
import { ProxySettings } from "./ProxySettings";
import {
  primaryLibraryMode,
  updateLibraryPreferences,
  useReaderStore,
} from "./store";
import { libraryModes } from "./LibraryModeSwitcher";
import { Checkbox } from "@neoread/ui/components/checkbox";
import { toast } from "sonner";
import { columnLabels, defaultColumns, toggleColumn } from "./papers/model";
import { savePaperPreferences } from "./papers/actions";
import { AppearancePicker } from "./AppearancePicker";
// Checks run automatically for this many API models; the rest on demand.
const autoAPIChecks = 12;
export function Settings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [testing, setTesting] = useState<Map<string, "text" | "vision">>(
    new Map(),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const checked = useRef(new Set<string>());
  const refreshing = useRef(false);
  const [saving, setSaving] = useState(false);
  const [searchSaving, setSearchSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  // Whether a detection has finished since the dialog opened.
  const [probed, setProbed] = useState(false);
  const [apiModels, setAPIModels] = useState<AgentModel[]>([]);
  const [apiModelsError, setAPIModelsError] = useState("");
  const [apiDetails, setAPIDetails] = useState(false);
  const [probeWait, setProbeWait] = useState("");
  const probeSeconds = Number(probeWait);
  const validProbeWait =
    Number.isInteger(probeSeconds) && probeSeconds >= 0 && probeSeconds <= 600;
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
      window.dispatchEvent(new Event("neoread:journal-rank-config"));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setJournalSaving(false);
    }
  };
  useEffect(() => {
    if (!open) setAPIDetails(false);
  }, [open]);
  const {
    theme,
    setTheme,
    aiConfig: config,
    setAIConfig,
    aiModelSaving,
    libraryPreferences,
  } = useReaderStore();
  const paperPreferences =
    useReaderStore((s) => s.libraryPreferences.papers) || {};
  // Run the text check, then the vision check, for an agent or an API model
  // ("api:<model>"). A result is dropped if its configuration changed meanwhile.
  const check = async (
    id: string,
    first: "text" | "vision",
    snapshot: AIConfig,
    timeoutSeconds?: number,
  ) => {
    const model = id.startsWith("api:") ? id.slice(4) : undefined;
    const run = (stage: "text" | "vision") =>
      model
        ? timeoutSeconds
          ? api.testAI("api", stage, model, timeoutSeconds)
          : api.testAI("api", stage, model)
        : api.testAI(id, stage);
    let stage = first;
    const update = (capability: AICapability) => {
      const current = useReaderStore.getState().aiConfig;
      if (
        !current ||
        (model
          ? current.api.url !== snapshot.api.url
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
    timeoutSeconds?: number,
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
    await Promise.all(
      ids.map((id) => check(id, firstStage(id), snapshot, timeoutSeconds)),
    );
  };
  const warnWithoutVision = (models: AgentModel[]) => {
    const capabilities = useReaderStore.getState().aiConfig?.capabilities;
    const results = models.map(({ id }) => capabilities?.[`api:${id}`]);
    if (
      results.length &&
      results.every(Boolean) &&
      !results.some((r) => r?.vision)
    )
      toast.warning(
        "此 API Key 不符合图片理解要求：拉取到的模型都没有通过图片理解检测。",
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
      // Large catalogs are checked on demand, row by row.
      const modelChecks = models
        .filter((model) => {
          const saved = config.capabilities[`api:${model.id}`];
          if (!force && saved && !saved.pendingVision) return false;
          return (
            force || !checked.current.has(JSON.stringify(["api", model.id]))
          );
        })
        .slice(0, autoAPIChecks);
      for (const model of modelChecks)
        checked.current.add(JSON.stringify(["api", model.id]));
      const firstStage = (id: string): "text" | "vision" =>
        !force && config.capabilities[id]?.pendingVision ? "vision" : "text";
      setLoading(false);
      await checkAll(
        [...pending, ...modelChecks.map(({ id }) => `api:${id}`)],
        firstStage,
        config,
      );
      if (modelChecks.length) warnWithoutVision(models);
    } catch (e) {
      toast.error(String(e));
    } finally {
      refreshing.current = false;
      setLoading(false);
      setProbed(true);
    }
  };
  useEffect(() => {
    if (open) void refresh();
    else setProbed(false);
  }, [open]);
  const checkModel = async (model: AgentModel) => {
    const snapshot = useReaderStore.getState().aiConfig;
    if (!snapshot || !validProbeWait) return;
    checked.current.add(JSON.stringify(["api", model.id]));
    await checkAll(
      [`api:${model.id}`],
      () => "text",
      snapshot,
      probeSeconds || undefined,
    );
    warnWithoutVision(apiModels);
  };
  const checkTools = async (model: AgentModel) => {
    const snapshot = useReaderStore.getState().aiConfig;
    if (!snapshot) return;
    setSaving(true);
    try {
      const capability = await api.testAI("api", "tools", model.id);
      const current = useReaderStore.getState().aiConfig;
      if (current && current.api.url === snapshot.api.url)
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
  const saveConfig = async (
    change: (latest: AIConfig) => AIConfig,
    refreshAfter = true,
  ) => {
    setSaving(true);
    try {
      setAIConfig(await api.saveAIConfig(change(await api.aiConfig())));
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
    if (refreshAfter) await refresh();
    return true;
  };
  const saveAPI = async (connection: APIConnection) => {
    // A new address or key is a new connection: test its models again.
    for (const key of checked.current)
      if (key.startsWith('["api"')) checked.current.delete(key);
    await saveConfig((latest) => ({ ...latest, api: connection }));
  };
  const saveAPIModels = async (change: (models: string[]) => string[]) => {
    await saveConfig((latest) => ({
      ...latest,
      apiModels: change(latest.apiModels ?? []),
    }));
  };
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
  const apiReady = (kind: "text" | "vision") =>
    // The API agent uses a separate model for each task. One passing model
    // is enough for the corresponding capability on this summary card.
    apiModels.some((model) => {
      const id = `api:${model.id}`;
      return (
        !errors[`${id}:text`] &&
        !errors[`${id}:${kind}`] &&
        !!config?.capabilities[id]?.[kind]
      );
    });
  const apiPending = () =>
    loading || [...testing.keys()].some((id) => id.startsWith("api:"));
  // Read by the first-run tour to point at an agent that works.
  const agentStatus = (name: string) => {
    const installed = providers.find((p) => p.id === name)?.installed;
    if (name === "api") {
      if (!installed) return "missing";
      return apiReady("text") ? "ready" : apiPending() ? "pending" : "failed";
    }
    if (loading || testing.has(name)) return "pending";
    if (!installed) return "missing";
    return config?.capabilities[name]?.text && !errors[`${name}:text`]
      ? "ready"
      : "failed";
  };
  const apiCardStatus = () => (
    <span className="flex flex-wrap gap-x-5">
      {(["text", "vision"] as const).map((kind) => {
        const label = kind === "text" ? "文本推理" : "图片理解";
        const ready = apiReady(kind);
        const pending = !ready && apiPending();
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
      <DialogContent
        data-tour="settings"
        className="settings-dialog p-6 sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>
            {apiDetails ? (
              <Button
                variant="ghost"
                className="-ml-2 gap-1 px-2 text-base"
                onClick={() => setAPIDetails(false)}
                aria-label="返回 Agent 设置"
                data-tour="api-back"
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
          <div className="settings-panel" data-tour="api-details">
            <section data-tour="api-form">
              {config && (
                <APIAgentForm
                  connection={config.api}
                  disabled={saving || testing.size > 0}
                  onSave={saveAPI}
                />
              )}
              {config &&
                providers.some((p) => p.id === "api" && p.installed) && (
                  <div className="mt-6">
                    <h3 className="mb-1 text-sm font-medium">模型</h3>
                    <label className="mb-1 flex items-center gap-3 text-xs text-muted-foreground">
                      检测等待上限（秒）
                      <Input
                        type="number"
                        min={0}
                        max={600}
                        step={1}
                        value={probeWait}
                        onChange={(event) => setProbeWait(event.target.value)}
                        aria-label="检测等待上限（秒）"
                        aria-describedby="api-probe-wait-help"
                        aria-invalid={!validProbeWait}
                        placeholder="默认"
                        className="h-7 w-24"
                      />
                    </label>
                    <p
                      id="api-probe-wait-help"
                      className="mb-3 text-xs text-muted-foreground"
                    >
                      仅用于手动检测，每阶段最多 600 秒；留空或 0 使用文本 45
                      秒、图片 90 秒
                    </p>
                    {!validProbeWait && (
                      <p className="mb-2 text-xs text-destructive" role="alert">
                        请输入 0–600 的整数
                      </p>
                    )}
                    <ul className="api-model-list">
                      {apiModels.map((model) => {
                        const id = `api:${model.id}`;
                        const result = config.capabilities[id];
                        const error =
                          errors[`${id}:vision`] ||
                          errors[`${id}:text`] ||
                          result?.error;
                        const retry = result || error;
                        const timings = [
                          !errors[`${id}:text`] &&
                          result?.textFirstOutputMs != null
                            ? `文本首输出 ${(result.textFirstOutputMs / 1000).toFixed(2)} s`
                            : "",
                          !errors[`${id}:text`] &&
                          !errors[`${id}:vision`] &&
                          result?.visionFirstOutputMs != null
                            ? `图片首输出 ${(result.visionFirstOutputMs / 1000).toFixed(2)} s`
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ");
                        return (
                          <li
                            key={model.id}
                            className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 py-1"
                          >
                            <span
                              className="min-w-0 flex-1 truncate text-sm"
                              title={model.id}
                            >
                              {model.name}
                            </span>
                            {(testing.has(id) || result || error) &&
                              checkStatus(id, result)}
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={
                                saving || testing.has(id) || !validProbeWait
                              }
                              aria-label={`${retry ? "重新检测" : "检测"} ${model.id}`}
                              onClick={() => void checkModel(model)}
                            >
                              {retry ? "重新检测" : "检测"}
                            </Button>
                            {result?.text && (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={saving || testing.has(id)}
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
                                disabled={saving || testing.has(id)}
                                onClick={() =>
                                  void saveAPIModels((models) =>
                                    models.filter((item) => item !== model.id),
                                  )
                                }
                              >
                                <X />
                              </Button>
                            )}
                            {!testing.has(id) && (timings || error) && (
                              <div className="w-full break-words text-xs text-muted-foreground">
                                {timings && (
                                  <p title="本次首次收到思考或正文的耗时，不含模型列表加载，受网络和服务负载影响">
                                    {timings}
                                  </p>
                                )}
                                {error && <p>{error}</p>}
                              </div>
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
                      onAdd={(id) => saveAPIModels((models) => [...models, id])}
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
            <TabsTrigger value="agent" data-tour="settings-agent-tab">
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
            {window.neoreadDesktop?.proxySettings && (
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
              <AppearancePicker theme={theme} setTheme={setTheme} buttons />
            </section>
            <section className="mt-6">
              <label
                className="mb-2 block text-sm font-medium"
                htmlFor="pdf-dark-image-mode"
              >
                PDF 深色图像处理
              </label>
              <Select
                value={theme.pdfDarkImageMode ?? "adaptive"}
                onValueChange={(value) => {
                  if (
                    value === "preserve" ||
                    value === "invert" ||
                    value === "adaptive"
                  )
                    setTheme({ pdfDarkImageMode: value });
                }}
              >
                <SelectTrigger
                  id="pdf-dark-image-mode"
                  className="w-full max-w-sm"
                >
                  <SelectValue>
                    {
                      {
                        preserve: "保持原色（透明底补白）",
                        invert: "图片全部反色",
                        adaptive: "自适应深色（处理图片白底）",
                      }[theme.pdfDarkImageMode ?? "adaptive"]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="adaptive">
                    自适应深色（处理图片白底）
                  </SelectItem>
                  <SelectItem value="preserve">
                    保持原色（透明底补白）
                  </SelectItem>
                  <SelectItem value="invert">图片全部反色</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-2 text-xs text-muted-foreground">
                扫描版页面也按此选项处理；文字颜色会保留色相并调整亮度。
              </p>
            </section>
          </TabsContent>
          <TabsContent value="reading" className="settings-panel" keepMounted>
            <section className="mb-6 space-y-4">
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
                  原文译文悬停关联
                  <span className="block text-xs text-muted-foreground">
                    悬停时提示另一侧对应的完整句子
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
            {window.neoreadDesktop?.libraryLocation && (
              <div className="mb-6">
                <LibraryLocationSettings open={open} />
              </div>
            )}
            <CitePluginSettings open={open} />
            <section>
              <h3 className="mb-3 text-sm font-medium">导入设置</h3>
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
                    通过文中的 DOI 或 arXiv 编号向 arXiv、Crossref 与 Semantic
                    Scholar 查询
                  </span>
                </span>
              </label>
              <label className="mt-4 flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
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
              <AutoTranslationSettings theme={theme} setTheme={setTheme} />
            </section>
            <PaperServiceSettings open={open} />
            <fieldset className="mt-7 border-t pt-5">
              <legend className="text-sm font-medium">表格显示列</legend>
              <p className="mb-3 text-xs text-muted-foreground">
                标题始终显示。以下选择应用于论文库的表格视图。
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {(Object.keys(columnLabels) as PaperColumn[]).map((column) => (
                  <label
                    key={column}
                    htmlFor={`paper-column-${column}`}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      id={`paper-column-${column}`}
                      checked={(
                        paperPreferences.columns ?? defaultColumns
                      ).includes(column)}
                      onCheckedChange={() =>
                        void savePaperPreferences((prefs) => ({
                          ...prefs,
                          columns: toggleColumn(
                            prefs.columns ?? defaultColumns,
                            column,
                          ),
                        }))
                      }
                    />
                    {columnLabels[column]}
                  </label>
                ))}
              </div>
            </fieldset>
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
                          new Event("neoread:journal-rank-refresh"),
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
            <section
              data-tour="agent-section"
              data-detecting={!probed || loading || testing.size > 0}
            >
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-medium">Agent 连接</h3>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="重新检测 Agent"
                  title="重新检测 Agent"
                  data-tour="agent-refresh"
                  disabled={loading || testing.size > 0}
                  onClick={() => void refresh(true)}
                >
                  <RefreshCw className={loading ? "animate-spin" : ""} />
                </Button>
              </div>
              {config && (
                <div className="mb-4 flex flex-col gap-2">
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
                      data-tour="agent-select"
                      aria-label="Agent SDK"
                      className="w-full"
                    >
                      <SelectValue placeholder="请选择 Agent SDK">
                        {config.primary ? (
                          <ProviderIdentity provider={config.primary} />
                        ) : undefined}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="codex" data-agent="codex">
                        <ProviderIdentity provider="codex" />
                      </SelectItem>
                      <SelectItem value="claude" data-agent="claude">
                        <ProviderIdentity provider="claude" />
                      </SelectItem>
                      <SelectItem value="kimi" data-agent="kimi">
                        <ProviderIdentity provider="kimi" />
                      </SelectItem>
                      <SelectItem value="api" data-agent="api">
                        <ProviderIdentity provider="api" />
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <div data-tour="task-models">
                    <TaskModels disabled={saving || testing.size > 0} />
                  </div>
                  {config.primary === "api" && (
                    <p className="text-xs leading-5 text-muted-foreground">
                      只列出通过检测的模型：问答与翻译需通过文本推理，图片需通过图片理解。公式转换与主动图片提问使用图片模型。
                    </p>
                  )}
                </div>
              )}
              {config && (
                <WebSearchSettings
                  value={config.webSearch}
                  disabled={aiModelSaving || (saving && !searchSaving)}
                  onSave={async (webSearch) => {
                    setSearchSaving(true);
                    try {
                      return await saveConfig(
                        (latest) => ({ ...latest, webSearch }),
                        false,
                      );
                    } finally {
                      setSearchSaving(false);
                    }
                  }}
                />
              )}
              <div
                data-tour="agent-cards"
                className="mt-5 grid grid-cols-1 items-start gap-3 sm:grid-cols-2"
              >
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
                        data-tour="agent-card"
                        data-agent={name}
                        data-status={agentStatus(name)}
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
                      data-tour="agent-card"
                      data-agent={name}
                      data-status={agentStatus(name)}
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
                NeoRead 调用已安装的 CLI，不读取账号凭据。AI 请求使用 CLI
                当前账户与计费方式；选择订阅登录时无需另填 API Key。API 连接使用
                OpenAI 兼容接口，Key 保存在本机 NeoRead
                数据目录。发送的选区或章节会交给对应服务。
              </p>
            </section>
            <CommandLineSettings open={open} />
            {config && (
              <section className="mt-7 border-t pt-1">
                <TranslationPromptSettings
                  value={config.translationPrompt ?? ""}
                  disabled={saving || aiModelSaving || testing.size > 0}
                  onSave={(translationPrompt) =>
                    saveConfig((latest) => ({ ...latest, translationPrompt }))
                  }
                />
              </section>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
