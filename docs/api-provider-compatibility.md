# API 厂商适配与错误诊断

规则核对日期：2026-10-13。实现入口为 `api_profile.go`，规则版本随能力变更更新。以下是官方文档依据，自动测试使用模拟 HTTP/SSE 响应，不代表七家真实账号均已实测。

## 地址与协议

`APIConnection.protocol` 由用户在 `openai`（Chat Completions）、`responses`（OpenAI Responses）、`anthropic`（Messages）中选择。老配置的空值或 `auto` 仍按地址推断，设置页显示推断结果，原样保存时不改写旧值，以免检测结果失效。

自动识别仅匹配 HTTPS 官方主机和已知 API 根路径，不根据模型名、域名子串或中转返回的模型归属切换厂商。非官方地址默认 OpenAI Chat Completions；手动选择 Responses 或 Anthropic Messages 后使用对应认证和请求格式。OpenAI 官方地址的 Responses 沿用 Chat Completions 的强度档位，写入 `reasoning.effort`；其他厂商的专用规则只适用于 Chat Completions。中转地址保持用户提供的根路径，不自动添加 `/v1`。Chat Completions 和 Responses 都经过工具检测后启用文档工具：Responses 以扁平 `function` 定义发送工具，以 `function_call` / `function_call_output` 条目往返，不回放推理内容。Anthropic Messages 暂不支持 Go 直连的文档工具轮次。不支持 Azure 或 Vertex 专用认证。

| 厂商        | 自动识别入口                                                               | 强度处理与官方依据                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI      | `api.openai.com`，根路径或 `/v1`                                           | [推理文档](https://developers.openai.com/api/docs/guides/reasoning)；Chat Completions 使用 `reasoning_effort`，已登记 GPT/o 系列按具体模型取合法档位。非推理模型不发送。                                                                                                                                                                                            |
| Anthropic   | `api.anthropic.com`，根路径或 `/v1`                                        | 原生 Messages 使用 [output_config.effort](https://platform.claude.com/docs/en/build-with-claude/effort)。旧模型使用 [thinking.budget_tokens](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)。手动选 OpenAI 协议时不发送 effort，因为[官方兼容层忽略此参数](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)。 |
| Google      | `generativelanguage.googleapis.com`，根路径、`/v1beta` 或 `/v1beta/openai` | 规范为[官方 OpenAI 兼容入口](https://ai.google.dev/gemini-api/docs/openai)，发送 reasoning_effort，不与 thinking_config 同发。                                                                                                                                                                                                                                      |
| Moonshot    | `api.moonshot.ai` / `api.moonshot.cn`，根路径或 `/v1`                      | [模型参数表](https://platform.kimi.ai/docs/api/models-overview)：K3 支持 low/high/max；K2.x 使用思考开关或固定模式。K3/K2.7 翻译连续轮次保留 reasoning_content，只有成功轮次进入内存历史。                                                                                                                                                                          |
| 智谱 / Z.AI | `open.bigmodel.cn` / `api.z.ai`，`/api/paas/v4` 或 `/api/coding/paas/v4`   | [深度思考](https://docs.z.ai/guides/capabilities/thinking)：GLM-5.3 为 low/high/max，5.2 实际思考档位 high/max；旧系列使用思考模式。发送两种入口共同支持的原生档位，避免依赖 Coding Plan 特有的宽松别名。                                                                                                                                                           |
| DeepSeek    | `api.deepseek.com`，根路径或 `/v1`                                         | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)：已登记 V4 模型 thinking enabled + reasoning_effort low/high/max；旧 chat/reasoner 别名使用默认模式。                                                                                                                                                                                          |
| MiniMax     | `api.minimax.io` / `api.minimaxi.com`，根路径或 `/v1`                      | [官方 OpenAI 接口](https://platform.minimax.io/docs/api-reference/text-openai-api)：M3.1 Flash Preview 可调 low/medium/high/xhigh/max；M3/M2.x 不宣称强度可调。设置 reasoning_split，避免思考内容混入回答正文。                                                                                                                                                     |

依据 [Claude effort 文档](https://platform.claude.com/docs/en/build-with-claude/effort)，Fable 5/5.1 与 Mythos 5/5.1 已登记 low/medium/high/xhigh/max，使用 adaptive thinking；遵循 NeoRead 已登记模型的 32768 输出上限。

每家的具体模型名单以 `reasoningRule` 为准。未知官方模型保留默认强度并显示“尚无规则”，不将整个新模型系列自动归为已支持。其他厂商的 Anthropic 专用根路径暂不在自动识别表内；可以手动选择 Messages 协议，但不应用未经核对的厂商模型规则。

## 用户选择与实际参数

UI 保留 low/medium/high/max 偏好；只在有可调能力时启用控件。缺少某档时映射到最近合法档位，等距选择较强的一档；设置与阅读面板显示映射。旧 Claude 的预算映射为 1024/4096/8192/16384 token，这是 NeoRead 的策略，不是厂商定义的四个离散 effort。预算必须小于 max_tokens。

未知中转缺少能力元数据时尝试标准 low/medium/high，max 映射为 high。端点明确发布档位时使用该列表；全部档位无法识别时省略强度并显示未知，不丢弃声明后伪造标准支持。不把 off/on 当作通用 reasoning_effort。

协议构造器仅发送允许的字段：Messages 不带 n、stream_options 或 reasoning_effort；Chat Completions 不带 output_config；不混发 Gemini 的两种思考配置；不主动发送会与思考模式冲突的 temperature/top_p。协议或规则版本变化会使旧能力检测失效。

检测使用同一参数构造器和已保存强度。成功代表请求被接受并完成，不代表端点实际应用了档位。不会根据回答长度、耗时或一次 token 数认定强度生效。

## 错误与日志

错误按 HTTP 状态、厂商业务码、通用结构化 code/type/status 分类；具体 code 优先于宽泛 type，数值业务码只在对应厂商解释。文案不作为自动重试依据。未知错误保留未知原因，不一律归因于 effort。参考 [OpenAI](https://developers.openai.com/api/docs/guides/error-codes)、[Anthropic](https://platform.claude.com/docs/en/api/errors)、[Google](https://ai.google.dev/gemini-api/docs/troubleshooting)、[Kimi](https://platform.kimi.ai/docs/api/errors)、[GLM](https://docs.bigmodel.cn/cn/api/api-code)、[DeepSeek](https://api-docs.deepseek.com/quick_start/error_codes/) 的错误文档。

读取最多 64 KiB 的 HTTP 错误体；同样识别 HTTP 200 中的业务错误和 SSE 错误。任意错误正文只在解析时使用，不写入日志。已知错误码、白名单参数名、受限请求 ID、错误体长度与摘要指纹进入日志；未知 code/type 记为 unrecognized。响应可能包含用户正文，因此不保存原始 message、请求正文或回答内容。

复用现有本地日志、脱敏、轮转和导出。`api.start` / `api.response` / `api.error` / `api.finish` 记录厂商、协议、模型、用户选择档位、发送档位、规则来源与版本、阶段、耗时、是否已有输出。通过 `requestId`、`attemptId`、`apiRequestId` 关联调用；有厂商 request ID 时一并保存。HTTP/流内上游失败的用户提示带诊断编号。

不会删除 effort 后重试，也不会从 SSE 自动重试为非流式。已有备用连接的显式切换行为保留；已经输出正文时不切换、不把失败轮次保存为成功。Claude 必须收到成功 stop_reason 和 message_stop，Chat Completions 必须收到成功 finish_reason 和 [DONE]。
