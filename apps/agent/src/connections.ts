import {
  ModelRuntime,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryModelsStore,
  type AuthInteraction,
  type Provider,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export interface PiConnection {
  provider: "openai" | "anthropic" | "kimi-coding";
  authPath: string;
}

const providers = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  "kimi-coding": kimiCodingProvider,
};

export function connectionProvider(connection: PiConnection): Provider {
  const factory = providers[connection.provider];
  if (!factory) throw new Error("不支持的 Pi 连接");
  const provider: Provider = factory();
  if (!provider.auth.oauth) throw new Error("不支持的认证方式");
  return { ...provider, auth: { oauth: provider.auth.oauth } };
}

export function authOrigin(connection?: PiConnection) {
  switch (connection?.provider) {
    case "openai":
      return "https://auth.openai.com";
    case "anthropic":
      return "https://platform.claude.com";
    case "kimi-coding":
      return "https://auth.kimi.com";
  }
}

export async function connectionRuntime(
  connection: PiConnection,
  signal: AbortSignal,
) {
  if (!connection.authPath) throw new Error("缺少 Pi 凭据存储位置");
  const runtime = await ModelRuntime.create({
    authPath: connection.authPath,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
    allowModelNetwork: false,
    signal,
  });
  const provider = connectionProvider(connection);
  runtime.registerNativeProvider(provider);
  return { runtime, provider };
}

export async function loginConnection(
  connection: PiConnection,
  deviceId: string,
  interaction: AuthInteraction & { signal: AbortSignal },
) {
  const { runtime, provider } = await connectionRuntime(
    connection,
    interaction.signal,
  );
  await runtime.login(provider.id, "oauth", interaction, {
    agentName: "NeoRead",
    getDeviceId: () => deviceId,
  });
  if (readStoredCredential(provider.id, connection.authPath)?.type !== "oauth")
    throw new Error("无法保存本地凭据");
}

export async function connectionModels(
  connection: PiConnection,
  signal: AbortSignal,
) {
  const { runtime, provider } = await connectionRuntime(connection, signal);
  const models = runtime.getModels(provider.id);
  let names: Map<string, string> | undefined;
  if (connection.provider === "openai") {
    const auth = await runtime.getAuth(provider.id, { signal });
    if (!auth?.auth.apiKey) throw new Error("请重新连接 ChatGPT");
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${auth.auth.apiKey}` },
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("无法获取 ChatGPT 套餐模型");
    const catalog = (await response.json()) as {
      models: { slug: string; display_name: string; visibility: string }[];
    };
    names = new Map(
      catalog.models
        .filter((m) => m.visibility === "list")
        .map((m) => [m.slug, m.display_name]),
    );
  }
  const known = new Map(models.map((model) => [model.id, model]));
  return [...(names?.keys() ?? known.keys())].map((id) => {
    const model = known.get(id);
    return {
      id,
      name: names?.get(id) || model?.name || id,
      contextWindow: model?.contextWindow,
      maxOutputTokens: model?.maxTokens,
      supportedEfforts: model?.reasoning ? ["low", "medium", "high"] : [],
    };
  });
}
