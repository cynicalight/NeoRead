# Agent 流式输出：前后端对接约定

## 同步与重新生成 · Issue #62 · 2026-10-15

历史加载失败时显示“重新加载”，只读取历史记录。回答明确失败、主动停止或意外断流后统一显示“重新生成”，不随内部历史查询的成功或失败切换按钮。点击后内部先核对保存状态：已有完整回答就恢复，没有才重新调用模型。检查失败时提示“暂时无法读取对话记录，请稍后重试。”，保留原按钮和已有内容，不发起生成请求。已收到 `done`、确认保存但尚未读回记录时显示“恢复回答”，只查询消息，不重新调用模型。不会自动重放 POST。

新客户端为每个问题生成可选 `userMessageId`（32 位小写十六进制），发送与显式重新生成使用同一个 ID。服务端在聊天互斥锁内仅复用同一文档尚无回答的最后一条用户消息，保留其 ID、时间、正文、引用、附件和阅读位置，并将该问题排除在历史输入之外。已有答案、后续消息、跨文档 ID 或改变原问题的请求返回 409；未提供 ID 的旧客户端保持原行为。

重新生成使用点击时当前选择的提供方，以及服务端最新已保存的模型/思考配置；模型设置保存中禁用重新生成。原问题的阅读位置、引用和图片不会随当前页面变化而重取。新尝试替换当前前端半成品（含草稿和思考），不归档成另一条回答；查询失败或请求在流开始前被拒绝时保留旧内容。每次尝试的失败审计和用量保留；不删除其他完整对话。重新打开文档可从末尾未回答的用户消息恢复重试入口。停止、卸载和迟到事件仍受请求身份与取消信号隔离。

SSE 事件形状不变；`userMessageId` 是请求中的问题身份，不是 SSE 消息序号或断点续传协议。下方冻结表描述旧版约定，以上扩展优先。

## API 思考过程 · 2026-10-15

新增 `reasoning {text:string}`，流式转发 API 明确返回的 `delta.reasoning_content`，与答案的 `delta`、候选正文 `draft`、工具状态 `activity` 分开。一次提问中多个工具轮次的思考按顺序追加，轮次之间插入空行。前端提供可展开的思考区域，答案开始或完成后默认折叠；收到思考片段后同样禁止自动备用拼接。取消或断流时只在当前界面保留已收到的片段，不将其保存为成功回答。

成功保存时，提供方返回的思考文本进入助手消息的可选 `reasoning` 字段，刷新后可回看。它不属于 `content`，复制答案及历史问题组装不包含它。API 活动窗口中的原始 `reasoning_content` 仍按协议回传，不受展示格式影响；运行审计不重复保存这份续接字段，诊断日志不记录思考正文。思考展示总量与正文分别限制为 1 MiB。本扩展仅显示 API 返回的字段，Codex 原生 reasoning 事件继续不向正文或此通道转发。

## 持续文档会话 · 2026-10-15

Codex 文档会话保留持久 thread，并在同一 turn 内读取和回答。API 保存完整有效消息窗口，达到上下文阈值时用检查点压缩旧记录，工具调用与结果保持配对。此节替代下文旧两阶段成文策略和文档聊天的三分钟上限；文档交互上限为十分钟，取消始终有效。

普通 Codex/API 文本提问记录发送时的原生阅读位置，默认不附加当前整页或整章。页面总结操作也由 Agent 根据位置自行读取；主动引用只发送选中的原文及位置，不扩展所在章节；图片附件也不触发整页文字提取。优先提供生成概要；没有有效概要时才使用元数据摘要，不重复附带两份背景。旧普通聊天的历史原文额度不裁剪持久文档会话；后者由 Codex 原生压缩或 API 检查点管理。原生 Anthropic Messages 目前走文字预检索、持久消息与压缩，不宣称已支持自主工具调用。

新增 `draft {text:string,reset:boolean}`：API 的 content 在 stop/tool_calls 确认前以增量候选文本显示；reset=true 清除候选文本，不改变已提交的 delta。工具调用出现时丢弃候选文本；成功 stop 后用 delta 提交完整答案并清除候选显示，不再额外调用模型成文。Codex 按 agentMessage.phase 直接流出正式答案，工具与 commentary 不混入正文。缺少阶段的旧协议只能在完整消息/turn 结束后确认候选。draft 一旦可见也禁止自动切换备用，不能在可见部分输出后拼接另一模型答案。

前端显示候选文本以维持增量体验，但只将 delta 累积内容与服务端保存结果核对；错误/断流不会把候选内容保存为成功答案。DeepSeek 等提供方要求的续接字段保留在 API 活动窗口，并在同一模型的后续请求回传；可见思考通过上方独立通道展示和保存，不混入答案正文。

## #41 文档检索扩展 · 2026-10-14

全文工具问答沿用下方请求、正文追加、备用和成功保存约定，增加可选 `activity` 事件：`{phase:"indexing"|"reading"|"writing",message:string,tool?:string}`。原有五种事件的形状不变；不识别该扩展的客户端可以忽略它。

`activity` 只显示准备原文、检索/读取及生成答案的状态，不包含完整工具参数、原文工具结果、模型推理或进度百分比。Codex/API 的全文工具路径在读取阶段仅发送 `activity`，读取结束后用收集到的原文生成最终回答，才开始发送 `delta`。成功序列为 `status → activity* → delta+ → done`；备用与失败仍遵守下方终态规则。`activity` 不代表正文已经输出，也不代表请求成功。

`message` 可包含经过清理和长度限制的检索关键词、章节名或 PDF 页码，用于说明当前工具的目标和用途，例如“正在检索 ‘cobalt’ · 查找相关原文”“正在查看第 12 页 · 核对原文与相邻段落”；不传递完整参数 JSON。前端以书本图标和状态文字显示，原文或最终答案不包含这些状态。全文索引在导入／解析流程中提前准备，提问命中缓存不发送 `indexing`；只有补建或重建才发送该状态。

本扩展的 OpenAPI、SDK 解码、前端状态显示及共用 fixtures 随 #41 一起更新。下方 2026-10-05 冻结表保留作为原协议基线；其中“事件形状始终不变”指原有事件，新增 `activity` 以本节为准。

## 本轮联调冻结项 · 2026-10-05

本节是已确认的 LobeHub 前端迁移与后端统一适配工作的固定边界。两方分别执行 [前端任务](./frontend-streaming-migration.md) 和 [后端任务](./backend-streaming-adapter.md)，内部实现可自行决定；修改下表必须先由协调会话确认并同步两方，不能单方改变字段、追加/替换语义或完成条件。

| 项目             | 本轮固定约定                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 接口与认证       | `POST /api/documents/{documentId}/chat`；Reader 会话 Bearer token；JSON 请求。不是 Agent API Key。                                                                                              |
| 必填请求字段     | `provider: "codex" \| "claude" \| "kimi" \| "api"`、`prompt: string`、`context: string`；context 可为空。                                                                                       |
| 可选请求字段     | `references: SourceReference[]`、`attachments: string[]`，省略等价于空数组；附件是当前文档块 ID。不新增 connectionId 或客户端模型/认证字段。                                                    |
| 事件与 JSON data | `status {status:"reading"\|"reading-image"}`、`delta {text:string}`、`fallback {message:string}`、`error {error:string}`、`done {ok:true}`。仍使用独立 SSE event 行，不另包 type/payload 外壳。 |
| 正文             | delta 仅为新增原始文本，保留空格/换行；按到达顺序追加。不是累计全文、HTML 或 AST，不携带推理/工具/日志。                                                                                        |
| 成功终态         | 适配器确认成功且完整助手消息保存成功后，仅一次 done；最终全文从 messages 读取并替换临时回答，不再次追加。                                                                                       |
| 失败终态         | 流开始前非 200 JSON error；开始后仅一次 error，不再 done；终态后无正文。EOF 本身不代表成功。                                                                                                    |
| 取消/断流        | AbortSignal 断开请求并停止上游；不承诺取消事件。保存竞态/终态丢失由 messages 核对；不自动重新 POST。                                                                                            |
| 备用策略         | 最多从选定 Agent 切换到已配置且验证通过的对应备用 API；只允许首个正文之前切换，先 fallback 再 delta。已显示正文、主动取消、总超时均不自动切换；不能自动轮询另两种 Agent。                       |
| 请求限制         | 维持当前 prompt 16,000 / context 256,000 UTF-8 字节、最多 4 个附件、回答 1MiB、3 分钟总超时及交互请求并发限制。                                                                                 |
| 暂不支持         | wire 版本字段/协商、序号、messageId、usage、断点续传、正文替换事件。不得依赖未实现字段。                                                                                                        |

正常序列为 `status → delta+ → done`；备用序列为 `status → fallback → delta+ → done`；失败为 `status → [fallback] → delta* → error`，也可能在建立流前直接 HTTP 失败。SSE 注释可忽略；网络读取分片没有业务含义。主动取消或断网可能没有终态。

**实现状态边界：** 下方正文记录 `2afe113` 已交付行为。迁移目标会将“首段前可用配置内备用”统一到普通文字及图片/Kimi 路径，并把已支持的备用 HTTP API 改为真实流；这两项由后端 B2 交付，不能在交付前视为已实现。事件形状始终不变，前端需兼容单个大 delta。其余冻结项延续当前协议；后端须补足终态后拒绝迟到事件等边界测试。

联调至少共同覆盖成功、首段前备用、首段后失败、主动取消、无 done 断流、保存成功但同步查询失败。前端用相同事件 fixtures 回放，后端用 gated HTTP 测试验证首段在上游结束前送达。两方都不以“HTTP 200”或“已有文字”代替成功终态。

后端负责调用 Agent、过滤协议事件、及时发送回答片段，并在成功结束后保存完整回答。前端负责接收 SSE、维护临时回答及渲染状态。Markdown、公式、代码块的渲染方式、刷新频率、自动滚动及取消后的展示由前端决定。

`2afe113` 的三种 Agent 协议实现已合入 main。本轮统一服务来自 `backend/unified-streaming`，随 `frontend/lobehub-streaming` 联合分支合入 main。阶段实现及证据见 [后端进度](./implementation/backend-streaming-progress.md)。顶部冻结表保持不变。

## 1. 请求接口

```http
POST /api/documents/{documentId}/chat
Authorization: Bearer <当前 Reader 会话 token>
Content-Type: application/json
```

```ts
import type { SourceReference } from "@reader/core";

type ChatRequest = {
  provider: "codex" | "claude" | "kimi" | "api";
  prompt: string;
  context: string;
  references?: SourceReference[];
  attachments?: string[];
};
```

`claude` 对应 Claude Code，`kimi` 对应 Kimi Code，`api` 对应设置中填写的 OpenAI 兼容 API（地址与 Key）。`references` 用于保存来源引用；EPUB 使用自身的 `href`、`locator` 等位置字段，PDF 使用页码，类型见 [reader-core](../packages/reader-core/src/index.ts)。

普通提问默认传空 `context` 和 `references`，并记录发送时的原生 `readingLocation`。手动引用、解释选区或提问批注时，只发送用户主动选择的原文和位置，不附带所在整章、邻近段落或全篇批注。图片附件不自动附加当前页文字。Codex/API 文档 Agent 根据概要、位置和问题调用工具；未具备文档工具的 CLI，仅在用户主动点击“总结当前页面／章节”等操作时通过阅读器取得该范围文字。无工具 API 的预检索仍复用后端原文索引。

持久文档 Agent 直接使用结构化会话、当前问题和明确引用，不再提前组装旧式完整历史提示词。只有普通无工具／图片适配路径按需组装兼容提示词。

客户端和服务端对显式原文附件统一执行 256,000 UTF-8 字节上限，超限提示用户减少引用，不静默裁剪，也不提供自动扩展章节后的裁剪弹窗。旧消息和来源仍保留。普通无工具聊天的历史来源额度仅用于其兼容提示词；持久文档会话的上下文由 Codex 原生管理或 API compact 管理。

`attachments` 是当前文档已有图片块的 ID，例如 `p1-b1`，最多 4 项。后端读取并发送图片；前端无需在此请求中上传 base64。`prompt` 必须非空，最多 16,000 UTF-8 字节；`context` 最多 256,000 UTF-8 字节。没有摘录时传空字符串。

```json
{
  "provider": "codex",
  "prompt": "请解释这段内容",
  "context": "当前摘录……",
  "references": [],
  "attachments": []
}
```

通过 `fetch` 发起 POST 并读取 `response.body`。原生 `EventSource` 不适合此接口，因为需要 POST 请求体和 Authorization 请求头。复用现有 `configureAPI(token)` 与会话初始化，不另建 Agent 登录流程。

## 2. 响应与事件数据

成功建立输出流后，HTTP 状态为 `200`，响应头为：

```http
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no
```

每个 SSE 事件由 `event:` 行、`data:` 行及一个空行组成。`data` 是 JSON；正文中的换行在 JSON 中转义。以下类型描述每个事件解析后的结构，**不是另外包在 HTTP 响应中的 JSON 对象**。

```ts
type ChatStreamEvent =
  | { event: "status"; data: { status: "reading" | "reading-image" } }
  | {
      event: "activity";
      data: {
        phase: "indexing" | "reading" | "writing";
        message: string;
        tool?: string;
      };
    }
  | { event: "delta"; data: { text: string } }
  | { event: "fallback"; data: { message: string } }
  | { event: "error"; data: { error: string } }
  | { event: "done"; data: { ok: true } };
```

| 事件       | 含义                                                        | 前端处理约定                                           |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `status`   | 后端已开始处理。不是进度百分比，也不是回答正文。            | 可以进入等待回答状态。                                 |
| `activity` | 文档原文准备、读取或最终回答生成状态。                      | 更新本次请求的状态提示，不追加到正文。                 |
| `delta`    | 回答的新增文本片段。                                        | 按到达顺序追加到本次请求的临时回答，不能替换已有全文。 |
| `fallback` | 主 Agent 未输出文字便失败，已切换到通过能力测试的备用 API。 | 可以显示提示；不要将提示写入回答正文。                 |
| `error`    | 本次请求失败。流建立后 HTTP 仍然为 200。                    | 结束生成状态，显示错误；不要继续等待 `done`。          |
| `done`     | 完整回答已经成功保存到后端数据库。                          | 将本次请求标记完成，读取消息列表与已保存记录对齐。     |

`delta.text` 是原始回答文本，可能包含 Markdown。它不是累计全文，不保证是一个 token、一个字、一句话或完整的 Markdown 节点。后台不会把推理内容、工具输出、CLI 日志或重复的最终全文放入 `delta`。目前没有 message ID、序号、usage、心跳或断点续传事件。

一次成功响应示例：

```text
event: status
data: {"status":"reading"}

event: delta
data: {"text":"这段内容"}

event: delta
data: {"text":"说明了 HTTP 流式传输。\n\n"}

event: delta
data: {"text":"**关键点**是逐段接收数据。"}

event: done
data: {"ok":true}

```

后端在每个事件后调用 `Flush()`。网络和运行时仍可能合并多个事件，或把一个事件切成多个读取块。因此，一次 `reader.read()` 不等于一个事件，也不等于一个文本片段。

## 3. 完成、失败、取消与保存

正常顺序是 `status → delta… → done → 连接结束`。发生自动切换时为 `status → fallback → delta… → done`。失败可能发生在首个 `delta` 前，也可能发生在若干片段后；`error` 后没有 `done`。

用户消息在开始生成前保存。生成中的助手文字只存在于临时输出中；后端确认 Agent 成功完成后，才保存一条完整的助手消息，再发送 `done`。前端不要为每个 `delta` 创建一条持久化消息。

收到 `done` 后，可调用 `GET /api/documents/{documentId}/messages`，也就是现有 `api.messages(documentId)`。该接口返回的助手 `content` 是完整回答。不要再将它追加到临时回答，否则会重复显示。前端决定如何用已保存记录替换临时消息。

流开始前的校验、登录或并发错误使用非 200 HTTP 响应和 `{"error":"说明"}`。常见状态为 `400`、`401`、`404`、`409`；`409` 表示已有交互式 AI 请求运行。应先检查 `response.ok`，再选择 JSON 错误处理或 SSE 读取。

流开始后的失败使用 `event: error`。一旦已有文字送达，后端不会自动切换到另一个模型追加第二份回答。不完整的助手回答不会按成功结果保存。当前端没有收到 `done` 就遇到 EOF、网络错误或解析错误，应视为“完成状态未确认”。如果后端恰好已保存、但终止事件在网络中丢失，数据库仍可能有完整回答；应重新读取消息列表确认，不要断言一定没有保存。

取消使用本次 `fetch` 的 `AbortController.abort()`。连接断开会传播到后端 Context，终止 CLI 并清理临时工作目录。主动取消不保证还能收到终止事件。用户消息不会因此回滚；若取消与保存同时发生，仍以消息列表为准。前端决定是否保留临时文字供查看，但不能将其显示成已保存的成功回答。

后端每次生成的超时为 3 分钟，回答上限为 1 MiB UTF-8 字节。Agent 启动或思考期间可能只有 `status`，暂时没有 `delta`。当前没有自动恢复流的接口；重新 POST 是新的请求，会新增用户消息，因此不要对断流自动重放请求。

## 4. 各 Agent 的后端适配

| Provider | 后端获取的增量事件                                                                                 | 对前端的统一输出                   |
| -------- | -------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `codex`  | `codex app-server` 的 `item/agentMessage/delta`                                                    | `delta {text}`                     |
| `claude` | Claude Code `stream-json` 的 `content_block_delta / text_delta`，启用 `--include-partial-messages` | `delta {text}`                     |
| `kimi`   | Kimi Code ACP 的 `session/update / agent_message_chunk`                                            | `delta {text}`                     |
| `api`    | Chat Completions SSE 中 choice 0 的 `delta.content`；`reasoning_content` 走独立思考通道            | `delta {text}`、`reasoning {text}` |

前端无需解析上述 CLI 协议，也无需为不同 Agent 编写 SSE 分支。纯文字及带图片请求都使用相同事件结构。Codex 的完整消息事件仅用于补齐未发送后缀与一致性校验，不会重复发送已有内容。

本轮 `backend/unified-streaming` 已将 `text-api` / `image-api` 接到 OpenAI Chat Completions SSE：发送 `stream:true`，只消费 choice 0 的 `delta.content`，要求 `finish_reason:stop` 与 `[DONE]`。不支持 SSE 的上游明确报错，不自动再发非流请求；尚未声明其他 API 协议兼容性。正文及图片输入共用相同适配器与输出。前端仍须兼容单个大 delta。

本轮普通 Codex/Claude 文字、Kimi 和图片均使用统一备用策略：首段前仅切到已配置且通过所需能力验证的对应备用 API；先 fallback 后 delta。首段后失败、客户端取消、总超时均不切换。后台任务的失败 attempt 单独丢弃，不混入备用正文。配置在请求开始时建立快照，不在生成中途读取新 key 或模型。

当前 `/api/ai/config` 仍是无密钥的配置/验证状态读取入口；只返回 hasKey，保留文字和图片验证结果。CLI 登录状态由现有 providers 接口提供，不把安装、登录、文字能力、图片能力混为一个状态。本轮没有新增连接目录或 connectionId。

错误和成功终态由同一 SSE writer 门控。写入/Flush 失败取消上游；Codex 尝试 turn/interrupt，Kimi 发送 session/cancel 并等待原 prompt response，400ms watchdog 强制回收。Claude 先 SIGINT 再有界强制退出。取消开始后拒绝正文；Claude result 后忽略迟到文字且仍要求进程正常退出。Kimi 校验 sessionId 和协商版本。

## 5. 前端工作范围

已有接入点是 [packages/api-client/src/index.ts](../packages/api-client/src/index.ts) 的 `chat()` 和 [apps/web/src/Workspace.tsx](../apps/web/src/Workspace.tsx) 的发送流程。当前 SDK 使用 `onDelta(text)` 转发片段，已有 `AbortSignal`、`onFallback`、错误处理与完成检查；当前界面通过 `setStream(previous => previous + text)` 追加内容。`status` 尚未通过 SDK 回调暴露。前端同事可在此基础上决定是否调整接口和渲染实现。

需要前端确认以下行为：

1. 使用流式 UTF-8 解码和跨读取块缓冲；正确处理一个读取块含多个事件、一个事件跨多个读取块，以及中文字符被切开的情况。
2. 在请求结束前持续显示 `delta.text`。如为性能合并刷新，应保持文字顺序，不等待完整响应才渲染。
3. Markdown、代码围栏、公式等可能暂时不完整，渲染策略由前端决定。回答内容应按不可信文本处理。
4. `done` 后对齐已保存消息；`error`、主动取消、异常 EOF 都能结束生成状态，并与成功状态区分。
5. 切换文档或开始新请求后，旧请求的回调不再修改新会话的显示。
6. 长回答的自动滚动、用户上翻后的滚动策略，以及每帧批量刷新由前端决定。

这里没有要求前端增加模拟打字动画。后端提供的是 Agent 实际到达的片段，前端按需要组织渲染。

## 6. 联调与验证

后端自动测试覆盖三种 Agent 的纯文字和图片 HTTP/SSE 请求。测试中的 Agent 发出第一段后会暂停，只有 HTTP 客户端收到并确认该段，才继续输出和完成，因此能检测后端缓冲和遗漏 `Flush()`。另有重复完成事件、跨会话事件过滤、RPC 操作拒绝、失败、取消、临时目录清理及不完整回答不落库的测试。

```sh
cd apps/server
go test ./internal/reader -run 'TestAgent|TestCodexProtocolBoundaries|TestChatStreamsOverHTTP|TestChatPartialFailure' -count=1
```

真实调用可选以下测试，只发送内置原创提示，并使用 CLI 自身登录：

```sh
READER_TEST_STREAM_PROVIDER=codex go test ./internal/reader -run '^TestLiveAgentStreaming$' -count=1 -v
READER_TEST_STREAM_PROVIDER=claude go test ./internal/reader -run '^TestLiveAgentStreaming$' -count=1 -v
READER_TEST_STREAM_PROVIDER=kimi go test ./internal/reader -run '^TestLiveAgentStreaming$' -count=1 -v
```

本次本机实测：Codex CLI 0.160.0 返回 193 个片段，首段约 6.1 秒、完成约 10.6 秒；Kimi 返回 214 个片段，首段约 6.2 秒、完成约 11.8 秒。这些是一次请求的记录，不是延迟承诺。Codex 另通过合成图片识别测试。Claude Code 2.1.220 当前未登录，已验证模拟协议，真实生成待具备登录环境后验证。

人工联调可在合并后的仓库运行 `pnpm dev`，打开终端输出的带会话 token 的 Reader 地址。使用已登录的 Agent，分别测试长段落、代码块、公式和图片问题，确认首段提前显示、没有最终全文重复、取消后不再追加、失败后能重新发送。不要求用浏览器自动化验收；界面效果由前端同事人工确认。

官方协议参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claude Code 流式响应](https://code.claude.com/docs/en/headless#stream-responses)。

## 本轮类型与回放证据

[OpenAPI](./openapi.yaml) 的 `ChatStreamEvent` 描述原有五事件与可选 `activity` 扩展；`text/event-stream` 实际仍是 SSE 文本，没有 JSON envelope。生成类型位于 `packages/api-client/src/schema.d.ts`。可共用 [v1 fixtures](./fixtures/agent-streaming-v1.json)，覆盖成功、文档工具状态、备用、部分失败和无终态断流。`TestFrozenStreamFixtures` 通过实际 writer 回放，检查事件形状、正文追加及终态后拒绝事件；前端使用相同文档工具 fixture 验证状态不混入正文。

本轮真实 CLI 的版本、文字/合成图片首段与完成时间、取消结果及未验证项，以 [后端进度](./implementation/backend-streaming-progress.md) 为准。上文原有历史实测仅描述先前基线。Claude 未登录、商业备用 API 实测、合并前端后的真实人工验收仍待完成；模拟协议和 HTTP gated 测试不替代这些验收。
