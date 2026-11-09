import { useEffect, useId, useState } from "react";
import { Plus } from "lucide-react";
import type { APIConnection } from "@neoread/core";
import { Button } from "@neoread/ui/components/button";
import { Input } from "@neoread/ui/components/input";

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
const savedProtocol = (connection: APIConnection): Protocol =>
  isProtocol(connection.protocol) ? connection.protocol : "openai";
const DEFAULT_API_URL = "https://api.deepseek.com";

/** Endpoint, protocol and key of the "api" agent. A saved key is
 * never sent back; leaving the field empty keeps it. */
export function APIAgentForm({
  connection,
  disabled,
  onSave,
}: {
  connection: APIConnection;
  disabled: boolean;
  onSave: (connection: APIConnection) => Promise<void>;
}) {
  const [url, setURL] = useState(connection.url || DEFAULT_API_URL);
  const [protocol, setProtocol] = useState<Protocol>(savedProtocol(connection));
  useEffect(
    () => setProtocol(savedProtocol(connection)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connection.protocol],
  );
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const id = useId();
  useEffect(() => setURL(connection.url || DEFAULT_API_URL), [connection.url]);
  const changed =
    url.trim() !== connection.url ||
    key.trim() !== "" ||
    protocol !== savedProtocol(connection);
  const save = async () => {
    setSaving(true);
    try {
      const endpoint = url.trim();
      // Clearing the address also removes the saved key.
      await onSave(
        endpoint
          ? {
              url: endpoint,
              protocol,
              model: "",
              key: key.trim() || undefined,
              hasKey: key.trim() ? false : connection.hasKey,
            }
          : { url: "", model: "", key: "", hasKey: false },
      );
      setKey("");
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) void save();
      }}
    >
      <label htmlFor={`${id}-url`} className="text-sm">
        Base URL
      </label>
      <Input
        id={`${id}-url`}
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
          aria-label="API Key"
          type="password"
          autoComplete="off"
          placeholder={connection.hasKey ? "已保存，留空保持不变" : "API Key"}
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
