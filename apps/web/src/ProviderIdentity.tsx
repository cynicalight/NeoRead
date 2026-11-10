import { Claude, DeepSeek, Kimi, OpenAI, Qwen } from "@lobehub/icons";
import { KeyRound } from "lucide-react";

// The API agent is not one brand, so it uses a neutral key mark.
function APIIcon({ size = 24 }: { size?: number }) {
  return <KeyRound size={size} strokeWidth={1.75} />;
}
function APIAvatar({ size = 20 }: { size?: number; iconClassName?: string }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full bg-muted text-foreground"
      style={{ width: size, height: size }}
    >
      <KeyRound
        style={{
          width: Math.round(size * 0.55),
          height: Math.round(size * 0.55),
        }}
        strokeWidth={2}
      />
    </span>
  );
}

const providers = {
  codex: { Icon: OpenAI, Avatar: OpenAI.Avatar, label: "Codex" },
  claude: { Icon: Claude, Avatar: Claude.Avatar, label: "Claude Code" },
  kimi: { Icon: Kimi, Avatar: Kimi.Avatar, label: "Kimi Code" },
  api: { Icon: APIIcon, Avatar: APIAvatar, label: "API" },
};

export const providerLabel = (provider: string) =>
  providers[provider as keyof typeof providers]?.label ?? provider;

export function ProviderGlyph({
  provider,
  size = 24,
}: {
  provider: string;
  size?: number;
}) {
  const brand = providers[provider as keyof typeof providers];
  return brand ? <brand.Icon size={size} /> : null;
}

export function ProviderIcon({
  provider,
  model,
  size = 20,
}: {
  provider: string;
  model?: { id: string; name: string };
  size?: number;
}) {
  const brand = providers[provider as keyof typeof providers];
  if (!brand) return null;
  const modelBrand = model
    ? [model.id, model.name]
        .map((name) => {
          if (/gpt|openai/i.test(name)) return OpenAI;
          if (/claude/i.test(name)) return Claude;
          if (/qwen/i.test(name)) return Qwen;
          if (/deepseek|^ds[\s-]/i.test(name)) return DeepSeek;
          if (/kimi/i.test(name)) return Kimi;
          return undefined;
        })
        .find(Boolean)
    : undefined;
  const Avatar = modelBrand?.Avatar ?? brand.Avatar;
  return (
    <span aria-hidden="true" className="provider-icon inline-flex shrink-0">
      <Avatar size={size} iconClassName="size-full" />
    </span>
  );
}

export function ProviderIdentity({
  provider,
  size = 20,
}: {
  provider: string;
  size?: number;
}) {
  const brand = providers[provider as keyof typeof providers];
  if (!brand) return <span>{provider}</span>;
  return (
    <span className="provider-identity">
      <ProviderIcon provider={provider} size={size} />
      <span>{brand.label}</span>
    </span>
  );
}
