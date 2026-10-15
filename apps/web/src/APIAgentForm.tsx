import type { APIConnection } from "@reader/core";
import { Input } from "@reader/ui/components/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@reader/ui/components/select";
import { TimeoutFields, runtimeTimeoutFields } from "./APITimeouts";
const protocols = {
  auto: "自动识别",
  openai: "OpenAI Chat Completions",
  anthropic: "Anthropic Messages",
} as const;

/** Controlled fields share the provider card's draft and save boundary. */
export function APIAgentForm({
  connection,
  disabled,
  onChange,
}: {
  connection: APIConnection;
  disabled: boolean;
  onChange: (connection: APIConnection) => void;
}) {
  const protocol = connection.protocol ?? "auto";
  return (
    <div className="api-connection-fields">
      <label>
        API 地址
        <Input
          aria-label="API 地址"
          placeholder="https://api.example.com/v1"
          autoComplete="off"
          spellCheck={false}
          value={connection.url}
          disabled={disabled}
          onChange={(e) => onChange({ ...connection, url: e.target.value })}
        />
      </label>
      <label>
        API Key
        <Input
          aria-label="API Key"
          type="password"
          autoComplete="off"
          placeholder={
            connection.hasKey ? "已保存，留空保持不变" : "输入 API Key"
          }
          value={connection.key ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ ...connection, key: e.target.value })}
        />
      </label>
      <label>
        接口协议
        <Select
          value={protocol}
          disabled={disabled}
          onValueChange={(value) =>
            value && onChange({ ...connection, protocol: value })
          }
        >
          <SelectTrigger aria-label="API 协议">
            <SelectValue>{protocols[protocol]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(protocols).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="api-field-help">
          自动识别官方地址 中转接口默认使用 OpenAI 协议
        </span>
      </label>
      <details className="api-advanced">
        <summary>高级连接设置</summary>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ["textProbeTimeoutSeconds", "文本检测时限（秒）", 45],
              ["visionProbeTimeoutSeconds", "图片检测时限（秒）", 90],
            ] as const
          ).map(([field, label, fallback]) => (
            <label key={field}>
              {label}
              <Input
                aria-label={label}
                type="number"
                min={1}
                max={600}
                step={1}
                value={connection[field] ?? fallback}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    ...connection,
                    [field]: e.target.value === "" ? 0 : Number(e.target.value),
                  })
                }
              />
            </label>
          ))}
        </div>
        <TimeoutFields
          fields={runtimeTimeoutFields}
          value={connection}
          onChange={(value) => onChange({ ...connection, ...value })}
          disabled={disabled}
        />
        <p className="api-field-help">
          请求时限留空或 0 使用默认值 首个输出和空闲不限 总时限通常 180 秒
          文档对话 600 秒
        </p>
      </details>
    </div>
  );
}
