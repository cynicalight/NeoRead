import { useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { AIConfig, APIProfile } from "@neoread/core";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@neoread/ui/components/alert-dialog";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@neoread/ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
const protocols = {
  openai: "OpenAI Chat Completions",
  responses: "OpenAI Responses",
  anthropic: "Anthropic Messages",
} as const;
type Protocol = keyof typeof protocols;
const tabLabels: Record<Protocol, string> = {
  openai: "Chat",
  responses: "Responses",
  anthropic: "Anthropic",
};
const isProtocol = (value: unknown): value is Protocol =>
  typeof value === "string" && value in protocols;
// The server reports the protocol in use; a legacy or empty value falls back to Chat Completions.
const savedProtocol = (connection: APIProfile): Protocol =>
  isProtocol(connection.protocol) ? connection.protocol : "openai";
const DEFAULT_API_URL = "https://api.deepseek.com";
const emptyProfile: APIProfile = { id: "", name: "", url: "", hasKey: false };

function defaultProfileName(url: string) {
  try {
    return new URL(url).host || "API 连接";
  } catch {
    return "API 连接";
  }
}

type ProfileConfig = Pick<AIConfig, "apiProfiles" | "activeAPIProfile">;

export function APIProfilesForm({
  config,
  disabled,
  onSave,
}: {
  config: ProfileConfig;
  disabled: boolean;
  onSave: (
    change: (latest: ProfileConfig) => ProfileConfig,
    connectionChanged: boolean,
  ) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const profiles = config.apiProfiles ?? [];
  const active = profiles.find(({ id }) => id === config.activeAPIProfile);
  const profile = adding || !active ? emptyProfile : active;
  return (
    <>
      {active && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select
            value={active.id}
            disabled={disabled || adding}
            onValueChange={(id) => {
              if (id && id !== active.id)
                void onSave(
                  (latest) => ({ ...latest, activeAPIProfile: id }),
                  true,
                );
            }}
          >
            <SelectTrigger aria-label="API 连接模板" className="min-w-0 flex-1">
              <SelectValue className="truncate">{active.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {profiles.map(({ id, name }) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {adding ? (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => setAdding(false)}
            >
              取消新增
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => setAdding(true)}
              >
                <Plus />
                新增模板
              </Button>
              <AlertDialog open={confirming} onOpenChange={setConfirming}>
                <AlertDialogTrigger
                  render={<Button type="button" variant="ghost" disabled={disabled} />}
                >
                  删除
                </AlertDialogTrigger>
                <AlertDialogContent initialFocus={cancelDelete}>
                  <AlertDialogHeader>
                    <AlertDialogTitle>删除 API 连接模板？</AlertDialogTitle>
                    <AlertDialogDescription>
                      将删除「{active.name}」及其保存的 API Key。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel ref={cancelDelete}>取消</AlertDialogCancel>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={disabled}
                      onClick={async () => {
                        const saved = await onSave(
                          (latest) => ({
                            ...latest,
                            apiProfiles:
                              latest.apiProfiles?.filter(({ id }) => id !== active.id) ?? [],
                          }),
                          true,
                        );
                        if (saved) setConfirming(false);
                      }}
                    >
                      删除模板
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </div>
      )}
      <APIAgentForm
        key={profile.id}
        profile={profile}
        disabled={disabled}
        onSave={async (edited) => {
          const id = profile.id || `profile-${crypto.randomUUID()}`;
          const next = { ...edited, id };
          const saved = await onSave(
            (latest) => {
              const profiles = latest.apiProfiles ?? [];
              if (profile.id && !profiles.some((item) => item.id === id))
                throw new Error("所选 API 连接模板不存在");
              return {
                apiProfiles: profile.id
                  ? profiles.map((item) => (item.id === id ? next : item))
                  : [...profiles, next],
                activeAPIProfile: id,
              };
            },
            !profile.id ||
              edited.url !== profile.url ||
              edited.protocol !== profile.protocol ||
              !!edited.key,
          );
          if (saved) setAdding(false);
          return saved;
        }}
      />
    </>
  );
}

/** A saved key is never returned; leaving the field empty keeps it. */
export function APIAgentForm({
  profile,
  disabled,
  onSave,
}: {
  profile: APIProfile;
  disabled: boolean;
  onSave: (profile: APIProfile) => Promise<boolean>;
}) {
  const [name, setName] = useState(profile.name);
  const [url, setURL] = useState(profile.url || DEFAULT_API_URL);
  const [protocol, setProtocol] = useState<Protocol>(savedProtocol(profile));
  useEffect(() => setName(profile.name), [profile.name]);
  useEffect(() => setProtocol(savedProtocol(profile)), [profile.protocol]);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const id = useId();
  const sameAddress =
    url.trim().replace(/\/+$/, "") === profile.url.replace(/\/+$/, "");
  useEffect(() => setURL(profile.url || DEFAULT_API_URL), [profile.url]);
  const changed =
    name.trim() !== profile.name ||
    url.trim() !== profile.url ||
    key.trim() !== "" ||
    protocol !== savedProtocol(profile);
  const defaultName = defaultProfileName(url.trim());
  const save = async () => {
    setSaving(true);
    try {
      const saved = await onSave({
        id: profile.id,
        name: name.trim() || defaultName,
        url: url.trim(),
        protocol,
        key: key.trim() || undefined,
        hasKey: !key.trim() && profile.hasKey,
      });
      if (saved) setKey("");
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2"
      method="post"
      aria-label="API 连接"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !saving && changed) void save();
      }}
    >
      <label htmlFor={`${id}-name`} className="text-sm">
        模板名称
      </label>
      <Input
        id={`${id}-name`}
        name="profileName"
        placeholder={defaultName}
        value={name}
        disabled={disabled || saving}
        onChange={(event) => setName(event.target.value)}
      />
      <label htmlFor={`${id}-url`} className="text-sm">
        Base URL
      </label>
      <Input
        id={`${id}-url`}
        name="baseURL"
        required
        autoCorrect="off"
        autoCapitalize="none"
        aria-label="Base URL"
        autoComplete="off"
        spellCheck={false}
        value={url}
        disabled={disabled || saving}
        onChange={(event) => setURL(event.target.value)}
      />
      <span id={`${id}-protocol`} className="text-sm">
        API 格式
      </span>
      <Tabs
        value={protocol}
        onValueChange={(value) => {
          if (isProtocol(value)) setProtocol(value);
        }}
      >
        <TabsList aria-labelledby={`${id}-protocol`} className="w-full">
          {Object.entries(protocols).map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              type="button"
              title={label}
              disabled={disabled || saving}
            >
              {tabLabels[value as Protocol]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <label htmlFor={`${id}-key`} className="text-sm">
        API Key
      </label>
      <div className="flex gap-2">
        <Input
          id={`${id}-key`}
          name="apiKey"
          aria-label="API Key"
          type="password"
          autoComplete="off"
          placeholder={
            profile.hasKey
              ? sameAddress
                ? "已保存，留空保持不变"
                : "地址已更改，请重新填写 API Key"
              : "API Key"
          }
          value={key}
          disabled={disabled || saving}
          onChange={(event) => setKey(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={disabled || saving || !changed}
        >
          保存
        </Button>
      </div>
    </form>
  );
}

/** Adds a model ID that the endpoint's /models list does not include. */
export function APIModelForm({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (id: string) => Promise<void>;
}) {
  const [id, setID] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="mt-2 flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const model = id.trim();
        if (!model) return;
        setSaving(true);
        void onAdd(model)
          .then(() => setID(""))
          .finally(() => setSaving(false));
      }}
    >
      <Input
        aria-label="添加模型 ID"
        placeholder="手动添加模型 ID"
        autoComplete="off"
        spellCheck={false}
        value={id}
        disabled={disabled || saving}
        onChange={(event) => setID(event.target.value)}
      />
      <Button
        type="submit"
        size="icon"
        variant="outline"
        aria-label="添加模型 ID"
        title="添加模型 ID"
        disabled={disabled || saving || !id.trim()}
      >
        <Plus />
      </Button>
    </form>
  );
}
