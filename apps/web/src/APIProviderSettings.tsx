import { useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { AIConfig, APIProvider, AgentModel } from "@reader/core";
import { api } from "@reader/api";
import { ChevronDown, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@reader/ui/components/button";
import { Input } from "@reader/ui/components/input";
import { Checkbox } from "@reader/ui/components/checkbox";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@reader/ui/components/collapsible";
import { APIAgentForm } from "./APIAgentForm";
import { APIPricingForm } from "./APIPricingForm";
import { ModelTimeoutForm, modelTimeoutFields } from "./APITimeouts";

// Native snapshots animate additions/removals without delaying the state update.
function transitionCards(update: () => void) {
  if (
    !document.startViewTransition ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }
  try {
    document.startViewTransition(() => flushSync(update)).ready.catch(() => {});
  } catch {
    update();
  }
}

function savedProviders(config: AIConfig): APIProvider[] {
  return (
    config.apiProviders ?? [
      {
        id: "default",
        name: "API",
        connection: config.api,
        models: config.apiModels ?? [],
        enabledModels: config.apiEnabledModels,
      },
    ]
  );
}
const configured = (provider: APIProvider) =>
  provider.id !== "default" ||
  !!provider.connection.url ||
  provider.models.length > 0;

export function APIProviderSettings({
  config,
  models,
  disabled,
  loading,
  testing,
  modelsError,
  onConfig,
  onSaving,
  onRefresh,
  onCheck,
  onCheckTools,
  renderStatus,
}: {
  config: AIConfig;
  models: AgentModel[];
  disabled: boolean;
  loading: boolean;
  testing: boolean;
  modelsError: string;
  onConfig: (config: AIConfig) => void;
  onSaving: (saving: boolean) => void;
  onRefresh: () => Promise<void>;
  onCheck: (stage: "text" | "vision", models: AgentModel[]) => void;
  onCheckTools: (model: AgentModel) => void;
  renderStatus: (id: string) => ReactNode;
}) {
  const saved = savedProviders(config).filter(configured);
  const [drafts, setDrafts] = useState<Record<string, APIProvider>>({});
  const [selected, setSelected] = useState(saved[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [manual, setManual] = useState<Record<string, string>>({});
  const [search, setSearch] = useState<Record<string, string>>({});
  const cards = [
    ...saved.map((p) => drafts[p.id] ?? p),
    ...Object.values(drafts).filter((p) => !saved.some((s) => s.id === p.id)),
  ];
  const edit = (provider: APIProvider) =>
    setDrafts((current) => ({ ...current, [provider.id]: provider }));
  const forget = (id: string) =>
    setDrafts((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  const listFor = (provider: APIProvider) => {
    const listed = models.filter(
      (m) =>
        splitModelRef(m.id)[0] === provider.id &&
        (!m.custom || provider.models.includes(splitModelRef(m.id)[1])),
    );
    return [
      ...listed,
      ...provider.models
        .filter((id) => !listed.some((m) => splitModelRef(m.id)[1] === id))
        .map((id) => ({
          id: modelRef(provider.id, id),
          name: id,
          description: "",
          isDefault: false,
          custom: true,
        })),
    ];
  };
  const enabledIDs = (provider: APIProvider) =>
    provider.enabledModels ?? [
      ...new Set(
        [
          ...listFor(provider).map((m) => splitModelRef(m.id)[1]),
          ...provider.models,
          ...[
            config.models.api,
            config.translationModels?.api,
            config.visionModels?.api,
          ]
            .filter(
              (id): id is string =>
                !!id && splitModelRef(id)[0] === provider.id,
            )
            .map((id) => splitModelRef(id)[1]),
        ]
          .filter((id): id is string => !!id)
          .filter(
            (id) => !id.includes("::") || splitModelRef(id)[0] === provider.id,
          )
          .map((id) => splitModelRef(id)[1]),
      ),
    ];
  const valid = (provider: APIProvider) =>
    !!provider.name.trim() &&
    [
      provider.connection,
      ...Object.values(provider.modelOverrides ?? {}),
    ].every(
      (value, index) =>
        modelTimeoutFields.every(([field, , max]) => {
          const n = value[field];
          return (
            n === undefined ||
            (Number.isInteger(n) &&
              n >= (index === 0 && field.includes("Probe") ? 1 : 0) &&
              n <= max)
          );
        }) &&
        (!("pricing" in value) ||
          !value.pricing ||
          ((value.pricing.currency === "CNY" ||
            value.pricing.currency === "USD") &&
            [
              value.pricing.input,
              value.pricing.output,
              value.pricing.cacheRead,
              value.pricing.cacheWrite,
            ].every((n) => n === undefined || (Number.isFinite(n) && n >= 0)))),
    );
  const save = async (provider: APIProvider) => {
    if (busy || disabled || !valid(provider)) return;
    setBusy(true);
    onSaving(true);
    setErrors((current) => ({ ...current, [provider.id]: "" }));
    try {
      const latest = await api.aiConfig();
      const connection = provider.connection.url.trim()
        ? {
            ...provider.connection,
            url: provider.connection.url.trim(),
            protocol: provider.connection.protocol ?? "auto",
            key: provider.connection.key?.trim() || undefined,
          }
        : { url: "", model: "", key: "", hasKey: false };
      const record = { ...provider, name: provider.name.trim(), connection };
      const legacy =
        !latest.apiProviders &&
        provider.id === "default" &&
        !provider.modelOverrides &&
        provider.name === "API";
      const records = savedProviders(latest).filter(configured);
      const savedConfig = await api.saveAIConfig(
        legacy
          ? {
              ...latest,
              api: connection,
              apiModels: record.models,
              apiEnabledModels: record.enabledModels,
            }
          : {
              ...latest,
              apiProviders: records.some((p) => p.id === record.id)
                ? records.map((p) => (p.id === record.id ? record : p))
                : [...records, record],
            },
      );
      onConfig(savedConfig);
      forget(provider.id);
      await onRefresh();
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [provider.id]: (error as Error).message,
      }));
    } finally {
      setBusy(false);
      onSaving(false);
    }
  };
  const remove = async (provider: APIProvider) => {
    if (!saved.some((p) => p.id === provider.id)) {
      transitionCards(() => {
        forget(provider.id);
        setSelected("");
      });
      return;
    }
    setBusy(true);
    onSaving(true);
    try {
      const latest = await api.aiConfig();
      const savedConfig = await api.saveAIConfig({
        ...latest,
        apiProviders: savedProviders(latest).filter(
          (p) => p.id !== provider.id,
        ),
      });
      transitionCards(() => {
        onConfig(savedConfig);
        forget(provider.id);
        setSelected("");
      });
      await onRefresh();
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [provider.id]: (error as Error).message,
      }));
    } finally {
      setBusy(false);
      onSaving(false);
    }
  };
  return (
    <div className="api-provider-settings">
      <div className="api-provider-heading">
        <div>
          <h3>API 提供商</h3>
          <p>每个连接单独保存 每个模型单独设置价格</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-label="添加 API 提供商"
          disabled={disabled || busy}
          onClick={() => {
            const id = crypto.randomUUID();
            transitionCards(() => {
              edit({
                id,
                name: "新提供商",
                connection: { url: "", model: "", hasKey: false },
                models: [],
                enabledModels: [],
              });
              setSelected(id);
            });
          }}
        >
          <Plus />
          添加提供商
        </Button>
      </div>
      {!cards.length && (
        <div className="api-provider-empty">
          添加 API 提供商后 填写地址与 Key 并保存连接
        </div>
      )}
      {cards.map((provider) => {
        const original = saved.find((p) => p.id === provider.id);
        const dirty =
          !original || JSON.stringify(provider) !== JSON.stringify(original);
        const active = selected === provider.id;
        const allModels = listFor(provider);
        const query = (search[provider.id] ?? "").trim().toLowerCase();
        const visibleModels = allModels.filter((model) =>
          `${model.name} ${model.id}`.toLowerCase().includes(query),
        );
        const enabled = enabledIDs(provider);
        const selectedModels = allModels.filter((m) =>
          enabled.includes(splitModelRef(m.id)[1]),
        );
        const locked = disabled || busy;
        const cannotTest = locked || testing || dirty;
        const updateModel = (
          id: string,
          value: NonNullable<APIProvider["modelOverrides"]>[string],
        ) =>
          edit({
            ...provider,
            modelOverrides: { ...provider.modelOverrides, [id]: value },
          });
        return (
          <Collapsible
            key={provider.id}
            open={active}
            onOpenChange={(open) => setSelected(open ? provider.id : "")}
            className="api-provider-card"
            data-provider-card
            style={{ viewTransitionName: `api-provider-${provider.id}` }}
            data-open={active}
            data-dirty={dirty}
          >
            <CollapsibleTrigger
              render={<Button type="button" variant="ghost" />}
              className="api-provider-summary"
              aria-label={`${active ? "收起" : "展开"} ${provider.name}`}
            >
              <span className="api-provider-summary-main">
                <strong>{provider.name || "新提供商"}</strong>
                <span>{provider.connection.url || "尚未填写 API 地址"}</span>
              </span>
              <span className="api-provider-summary-meta">
                {dirty ? "未保存" : `已启用 ${selectedModels.length} 个模型`}
              </span>
              <ChevronDown className="api-provider-chevron" />
            </CollapsibleTrigger>
            <CollapsibleContent className="api-provider-content">
              <form
                className="api-provider-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (dirty) void save(provider);
                }}
              >
                <label className="api-provider-name">
                  提供商名称
                  <Input
                    aria-label="提供商名称"
                    value={provider.name}
                    disabled={locked}
                    onChange={(e) =>
                      edit({ ...provider, name: e.target.value })
                    }
                  />
                </label>
                <APIAgentForm
                  connection={provider.connection}
                  disabled={locked}
                  onChange={(connection) => edit({ ...provider, connection })}
                />
                <section className="api-provider-models">
                  <div className="api-model-heading">
                    <h4>模型</h4>
                    <span>{selectedModels.length} 个已启用</span>
                  </div>
                  <div className="api-model-actions">
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label="刷新模型列表"
                        disabled={
                          locked ||
                          loading ||
                          dirty ||
                          !original?.connection.url
                        }
                        onClick={() => void onRefresh()}
                      >
                        <RefreshCw />
                        获取模型列表
                      </Button>
                      <p>读取候选模型 不发起能力测试</p>
                    </div>
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label="检测已启用模型的文本"
                        disabled={cannotTest || !selectedModels.length}
                        onClick={() => onCheck("text", selectedModels)}
                      >
                        测试文本
                      </Button>
                      <p>验证已启用模型能否回答</p>
                    </div>
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label="检测已启用模型的图片"
                        disabled={
                          cannotTest ||
                          !selectedModels.some(
                            (m) => config.capabilities[`api:${m.id}`]?.text,
                          )
                        }
                        onClick={() =>
                          onCheck(
                            "vision",
                            selectedModels.filter(
                              (m) => config.capabilities[`api:${m.id}`]?.text,
                            ),
                          )
                        }
                      >
                        测试图片
                      </Button>
                      <p>验证已启用模型能否识图</p>
                    </div>
                  </div>
                  <p className="api-field-help">
                    {dirty
                      ? "请先保存配置 再获取模型列表或测试 测试使用已保存配置"
                      : "测试使用已保存配置 会发起少量 API 请求"}
                  </p>
                  {!!allModels.length && (
                    <div className="api-model-list-heading">
                      <span>勾选需要使用的模型</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label="停用全部模型"
                        disabled={locked}
                        onClick={() => edit({ ...provider, enabledModels: [] })}
                      >
                        全部停用
                      </Button>
                    </div>
                  )}
                  {(allModels.length > 8 || search[provider.id]) && (
                    <label className="api-model-search">
                      <Input
                        aria-label="搜索模型"
                        placeholder="搜索模型名称或 ID"
                        value={search[provider.id] ?? ""}
                        onChange={(event) =>
                          setSearch((current) => ({
                            ...current,
                            [provider.id]: event.target.value,
                          }))
                        }
                      />
                      <span className="api-field-help">
                        仅筛选列表 批量测试和全部停用仍作用于此提供商的全部模型
                      </span>
                    </label>
                  )}
                  {query && !visibleModels.length && (
                    <p className="api-field-help">没有匹配的模型</p>
                  )}
                  <ul className="api-model-list">
                    {visibleModels.map((model) => {
                      const raw = splitModelRef(model.id)[1];
                      const override = provider.modelOverrides?.[raw];
                      const result = config.capabilities[`api:${model.id}`];
                      const isEnabled = enabled.includes(raw);
                      return (
                        <li key={model.id} className="api-model-row">
                          <div className="api-model-row-main">
                            <Checkbox
                              aria-label={`启用 ${model.id}`}
                              checked={isEnabled}
                              disabled={locked}
                              onCheckedChange={(checked) =>
                                edit({
                                  ...provider,
                                  enabledModels: checked
                                    ? [...new Set([...enabled, raw])]
                                    : enabled.filter((id) => id !== raw),
                                })
                              }
                            />
                            <span className="api-model-name" title={model.id}>
                              {model.name}
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-label={`检测 ${model.id} 文本`}
                              disabled={cannotTest || !isEnabled}
                              onClick={() => onCheck("text", [model])}
                            >
                              测试文本
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              aria-label={`检测 ${model.id} 图片`}
                              disabled={
                                cannotTest || !isEnabled || !result?.text
                              }
                              onClick={() => onCheck("vision", [model])}
                            >
                              测试图片
                            </Button>
                            {model.custom && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`移除 ${model.name}`}
                                disabled={locked}
                                onClick={() =>
                                  edit({
                                    ...provider,
                                    models: provider.models.filter(
                                      (id) => id !== raw,
                                    ),
                                    enabledModels: enabled.filter(
                                      (id) => id !== raw,
                                    ),
                                  })
                                }
                              >
                                <Trash2 />
                              </Button>
                            )}
                          </div>
                          {renderStatus(`api:${model.id}`)}
                          {result?.error && (
                            <p className="api-field-help">{result.error}</p>
                          )}
                          {(result?.textLastSucceededAt ||
                            result?.visionLastSucceededAt) && (
                            <p className="api-field-help">
                              最近成功{" "}
                              {result.textLastSucceededAt &&
                                `文本 ${result.textLastSucceededAt}`}{" "}
                              {result.visionLastSucceededAt &&
                                `图片 ${result.visionLastSucceededAt}`}
                            </p>
                          )}
                          <details className="api-model-options">
                            <summary aria-label={`${model.id} 模型设置`}>
                              价格与高级设置
                            </summary>
                            <APIPricingForm
                              model={model.id}
                              value={override?.pricing}
                              disabled={locked}
                              onChange={(pricing) =>
                                updateModel(raw, { ...override, pricing })
                              }
                            />
                            <ModelTimeoutForm
                              model={model.id}
                              value={override}
                              inherited={provider.connection}
                              disabled={locked}
                              onChange={(value) => updateModel(raw, value)}
                            />
                            {result?.text && (
                              <div className="api-tool-check">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  disabled={cannotTest || !isEnabled}
                                  onClick={() => onCheckTools(model)}
                                  title={result.toolError}
                                >
                                  {result.tools === "passed"
                                    ? "检索工具已通过"
                                    : "检测检索工具"}
                                </Button>
                                <p className="api-field-help">
                                  工具测试可选 不影响普通文本问答
                                </p>
                              </div>
                            )}
                          </details>
                        </li>
                      );
                    })}
                  </ul>
                  {modelsError && original?.connection.url && (
                    <p role="alert" className="api-field-help">
                      {modelsError}
                    </p>
                  )}
                  <div className="api-manual-model">
                    <Input
                      aria-label="添加模型 ID"
                      placeholder="列表中没有？手动填写模型 ID"
                      value={manual[provider.id] ?? ""}
                      disabled={locked}
                      onChange={(e) =>
                        setManual((current) => ({
                          ...current,
                          [provider.id]: e.target.value,
                        }))
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      aria-label="添加模型"
                      disabled={locked || !manual[provider.id]?.trim()}
                      onClick={() => {
                        const id = manual[provider.id].trim();
                        edit({
                          ...provider,
                          models: [...new Set([...provider.models, id])],
                        });
                        setManual((current) => ({
                          ...current,
                          [provider.id]: "",
                        }));
                      }}
                    >
                      添加
                    </Button>
                  </div>
                </section>
                {errors[provider.id] && (
                  <p role="alert" className="api-save-error">
                    {errors[provider.id]} 草稿已保留 请重试
                  </p>
                )}
                <footer className="api-provider-footer">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="删除 API 提供商"
                    disabled={locked}
                    onClick={() => void remove(provider)}
                  >
                    <Trash2 />
                    {original ? "删除提供商" : "丢弃新提供商"}
                  </Button>
                  <span role="status">
                    {busy ? "保存中" : dirty ? "有未保存的修改" : "已保存"}
                  </span>
                  <Button
                    type="submit"
                    disabled={locked || !dirty || !valid(provider)}
                  >
                    {busy ? "保存中…" : "保存配置"}
                  </Button>
                </footer>
              </form>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}
export function splitModelRef(ref: string): [string, string] {
  const index = ref.indexOf("::");
  return index < 0
    ? ["default", ref]
    : [ref.slice(0, index), ref.slice(index + 2)];
}
export function modelRef(provider: string, model: string) {
  return provider === "default" && !model.includes("::")
    ? model
    : `${provider}::${model}`;
}
