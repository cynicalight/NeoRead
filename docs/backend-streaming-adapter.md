# 后端实施方案：统一 Agent 与 API 流式服务

> 这份文档记录 Pi 迁移前的实现和验收。当前运行时见[内置 Pi 与模型连接](agent-streaming-contract.md#内置-pi-与模型连接)。

日期：2026-10-05。执行对象：NeoRead 后端。状态：基于现有实现的后续交付要求，不代表本文新增能力已经落地。

任务派给新建的 `NeoRead 流式迁移 · 后端` 会话，使用独立 worktree，不占用正在处理其他工作的 `Backend Infra CI/CD` 会话。执行 B1–B4，在已经完成的协议适配之上继续交付统一服务。适配器接口、目录组织和进程管理细节可自行设计，以可测试性和资源回收为依据；共同契约的冻结项不能单方变更。

配套文档：[前端流式迁移](./frontend-streaming-migration.md)。[Agent 流式输出约定](./agent-streaming-contract.md) 是当前 wire contract，即前后端实际交换的数据格式。本方案补充后端内部边界和下一步工作，不覆盖其中已实现的事件名称与完成语义。

## 1. 目标和已完成的基础

前端只调用 NeoRead 的统一聊天服务，接收原始 Markdown 文本增量、处理状态和终态。后端负责选择连接、读取后端配置、认证、模型参数、Agent 协议、图片输入、流解析、取消、错误分类、备用策略和保存。前端不处理 Codex JSON-RPC、Claude stream-json、Kimi ACP 或上游 API SSE。

基线 `2afe113` 已合入 Codex App Server、Claude Code partial stream-json 和 Kimi ACP 的实际增量提取，以及模拟协议和 HTTP 流测试。文字/图片 Agent 路径已经可以在请求完成前发送 delta。应复用现有 `codex.go`、`claude.go`、`cli.go` 和测试，避免把旧调研的限制当作当前缺陷。

仍需完成：把分散调用归入明确的适配器接口和统一服务；统一纯文字/图片的路由及备用规则；实现当前 `stream:false` 备用 API 的真实流读取；规范协议终态、取消和错误；向前端提供稳定、无密钥的连接能力信息。后台生成也应复用相同适配器，但不必走 HTTP。

## 2. 服务结构和职责

```text
POST /api/documents/{id}/chat
  → ChatService：校验、文档上下文、请求生命周期、消息保存
  → GenerationService：连接选择、配置快照、能力检查、备用策略
  → ProviderAdapter：各自原生协议 → 统一内部事件与结果
  → 单一 SSE writer：status / delta / fallback / error / done

后台处理 → GenerationService → 同一 ProviderAdapter
```

| 模块 | 所有权与边界 |
| --- | --- |
| ChatService | 请求和文档身份、上下文/历史、附件读取、保存和终态；适配器不直接操作数据库。 |
| GenerationService | 根据已保存配置解析连接，创建一次请求的不可变配置快照，执行统一策略；不生成 Markdown 动画或人为打字延迟。 |
| ProviderAdapter | 进程/HTTP 生命周期、原生事件过滤、累计与去重、上游成功判断、协议版本兼容。 |
| SSE writer | 按序输出有限类型的 JSON 事件，Flush、检查写失败、传播取消；适配器不能持有 ResponseWriter。 |
| Connection registry | 用连接 ID 绑定协议实现与认证引用，向上层提供能力和可用状态。 |

可以先在 `internal/neoread` 内整理，再视依赖划分 `internal/ai`；避免为了目录移动重写协议解析。核心接口示意如下，落地时应将事件和错误定义为明确类型：

```go
type Adapter interface {
    Stream(ctx context.Context, req GenerateRequest,
        emit func(ProviderEvent) error) (GenerateResult, error)
}
```

`GenerateRequest` 包含已构建提示、受控图片、模型参数和后端认证引用；不含 ResponseWriter 或数据库。`ProviderEvent` 第一阶段只需正文增量和可映射的处理状态；usage 可作为可选内部元数据。`GenerateResult` 包含权威正文与结束原因。适配器返回成功前必须验证原生成功终态；不能把 EOF、进程启动成功或 HTTP 200 当作生成成功。

正文事件必须按顺序、串行调用 emit。emit 返回错误时及时停止上游。若适配器内部使用 goroutine，需有界队列和单一出口，不能丢弃正文、无限缓存或乱序。上层拥有终态门控，成功、错误、取消只结算一次，终态后任何文本均不得进入前端或保存结果。

## 3. 统一前端协议：延续现有格式

继续保留 `status {status}`、`delta {text}`、`fallback {message}`、`error {error}`、`done {ok:true}`。当前格式在文档中称为协议 v1；现有线上帧没有版本字段或版本响应头，不得假定客户端已经能协商版本。

以共同契约“本轮联调冻结项”为准。请求继续使用必填 `provider` 和现有上下文/附件字段；本轮不新增 connectionId 选择接口、版本响应头或额外 SSE 字段。类型可以在 OpenAPI 中补全，但不能借类型生成改变 wire 格式。

`delta.text` 始终是新增的原始回答文本。它不包含模型标识、提示、推理过程、工具结果或重复的最终全文，也不要求闭合 Markdown。不得将后端流改成 HTML、AST、逐字符事件或渲染器专属块，以免后端和 LobeHub 组件耦合。上游单次返回全文时也可作为一次 delta，前端使用同一消费者。

```text
event: delta
data: {"text":"## 解释\n\n这段内容"}

event: delta
data: {"text":"说明了……"}

event: done
data: {"ok":true}

```

对接类型、SSE 示例与边界统一维护到现有契约和 `docs/openapi.yaml`。SDK 的流解析实现由前端负责，schema 和生成类型由后端负责。不要仅留下 `text/event-stream: string` 而没有事件结构的规范说明和契约 fixtures。

目前不增加断点续传、自动重发、流式推理或工具执行 UI。若以后需要 requestId、messageId、序号、权威全文替换或新的终态，先修改共同契约与双方测试，再以明确的版本协商交付；不能静默改变 delta 的追加语义。第一阶段依靠现有消息列表完成保存核对。

## 4. 连接与认证抽象

区分“哪个模型服务”和“使用什么协议”。Codex CLI 登录、Claude Code 登录、Kimi Code 登录与 API Key 是后端连接配置，不能散落在 HTTP handler 的 if/else 中。原生 Claude API、OpenAI 兼容 API 和 CLI 不是相同协议；不能因为模型名称相同就共用解析器。

第一阶段必须适配三种本地 Agent 和项目现有 `text-api`/`image-api` 连接。API 连接按协议选择适配器，初期明确支持现有 OpenAI Chat Completions 兼容格式；未经实现和测试，不声称兼容任意厂商 API。

前端聊天请求不接受或传递 API Key、上游地址、认证头、CLI 参数或文件路径。设置页可以将用户主动输入的 key 写入后端；后续读取只返回 `hasKey` 等状态，不能返回原值或保存在前端持久化状态/日志中。CLI 继续使用自身登录，NeoRead 不读取 CLI 凭据文件、不模拟 OAuth。

连接 registry 和连接 ID 在本轮作为后端内部模型。对外保留现有 provider 选择和配置接口，provider 只表达用户选定的 Agent，不使前端了解认证或协议。内部可保存协议、显示名称、认证引用和已验证能力；前端渲染不按 provider 分支。

动态连接目录和对外 `connectionId` 是后续扩展，不属于本轮交付，也不阻塞前端。不得把用户明确指定的 provider 静默换成另一 Agent；只有下文规定的显式备用 API 路径可以切换。

登录状态、协议支持、实际文字推理成功和图片能力验证分开记录。配置或模型改变时使旧验证结果失效。启动一次请求后使用配置快照，不能在同一条回答中途换 key、模型或主连接。

## 5. 三种 Agent 的规范化

### Codex：App Server

复用 [codex.go](../apps/server/internal/neoread/codex.go)。按连接初始化，然后创建隔离 thread/turn；将 `item/agentMessage/delta` 转成内部正文增量。核对 thread、turn、item 身份，正确处理 RPC response 与 notification 交错。`item/completed` 是单 item 的最终快照，不能再次追加全文；只补未发送的后缀。无法以追加表达的改写在 v1 返回协议错误，不把两版答案拼接。

整个生成是否成功以 `turn/completed` 的状态为准。取消优先使用 `turn/interrupt`，设有限等待后关闭管道并回收进程。沿用禁止工具、无凭据读取及临时目录隔离。参考 [官方 App Server 协议](https://learn.chatgpt.com/docs/app-server)。本地已有解析实现与测试是迁移起点，实施时对目标 CLI 版本重新验证字段和能力。

### Claude Code：partial stream-json

复用 [claude.go](../apps/server/internal/neoread/claude.go) 和 [cli.go](../apps/server/internal/neoread/cli.go)。使用 print 模式、`--output-format stream-json`、`--include-partial-messages`，按当前 CLI 要求启用 verbose。正文来自 `stream_event` 内的 text block 起始文本与 `content_block_delta/text_delta`。过滤非主请求内容；assistant 快照和 result 不重复追加。

`message_stop` 不是整个 Agent 调用成功；必须检查 `result` 的 subtype、`is_error` 和子进程退出。记录成功终态后停止接受正文，并处理迟到/重复事件。用户取消与异常 EOF 分开；协议没有正常 result 的主动终止不能伪装成成功。优先正常中断，超时后强制回收。参考 [官方流式事件](https://code.claude.com/docs/en/agent-sdk/streaming-output)、[CLI 流式与停止行为](https://code.claude.com/docs/en/headless)、[result 类型](https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage)。

### Kimi Code：ACP

复用 `cli.go` 的 Kimi 实现。验证 initialize 的协商版本与图片能力；创建 session 后，核对 `session/update.params.sessionId`，只将 `agent_message_chunk` 的 text 内容转成正文。忽略思考、工具进度和用户回显；无法处理的权限请求按拒绝或取消回复。

终态取匹配的 `session/prompt` response 中的 `stopReason`。`end_turn` 才按正常完成处理；限制、中止和拒绝分别保留内部原因，不能因已有文字或连接结束就成功。取消用无 ID 的 `session/cancel` notification，等待原 prompt response；终态确认前可能还有排队更新，上层取消门控不再向前端追加。有限等待后关闭管道并回收进程。

当前实现以取消 Context/杀进程停止，尚不能称为协议取消确认；会话身份与协商版本校验也需补齐。参考 [Kimi ACP 支持](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html)、[ACP 回合与取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[ACP schema](https://agentclientprotocol.com/protocol/v1/schema)。

## 6. API Key 连接的真实流

当前 `invokeAPI` 使用 `stream:false`。新增协议专属 HTTP 适配器，发送真实流式请求，逐事件解析正文增量，同时处理上游错误和结束条件。文字和图片仅在输入构造上不同，归一化输出完全一致。不得收到完整响应后人为拆成小片段并标称真实流式。

OpenAI Chat Completions 兼容格式应明确处理 choice/index、`delta.content`、`finish_reason` 与流结束标记；只选定一个 choice，不能拼接多个候选。拒绝、截断、超限等原因必须保留内部分类。具体提供商对终止标记的差异通过已声明的兼容能力和测试覆盖，不把任何 EOF 当成功。[官方流式说明](https://platform.openai.com/docs/guides/streaming-responses)

上游确实不支持流时，连接能力应声明 non-incremental，并复用一次 delta 的兼容路径；不因解析失败自动再发一次非流式请求。所有 API 认证头、错误脱敏、超时、重定向策略与请求限制由后端统一管理。

## 7. 生命周期、备用、保存与资源

统一文字和图片服务的备用规则：仅使用用户配置且能力已验证的对应备用 API；主连接尚未向前端发出正文便失败时可以切换，并先发送 fallback。取消、文档删除、请求超时不得触发备用。首个正文 delta 已发出后发生错误则结束为 error，不自动切换，不拼接第二份答案。此规则延续当前防止混合回答的原则，并需补充普通 Codex/Claude 文字路径的统一测试。

后台任务没有前端可见流时可以丢弃失败 attempt 的暂存结果后按配置重试，但每个 attempt 的文本容器独立。不能让后台“可重试”策略污染交互式已显示内容。

用户消息只保存一次。完整助手回答在适配器确认成功、累计文本一致且数据库保存成功后发送 done；保存失败发送 error，绝不能先 done 后存储。已有数据库记录不回滚、不覆盖；不完整回答不按成功助手消息保存。

done 丢失或取消与保存竞争时，数据库可能已经有完整回答，前端查消息列表核对。因此不能把无 done 的错误文案写成“一定未保存”。不自动重放 POST；断点恢复与幂等生成不在 v1 中。

成功、错误、取消统一释放 CLI、管道、HTTP body、临时图片/目录、goroutine、锁和定时器。SSE 写失败也触发上游停止；避免断开的客户端继续占用模型调用。协议取消要在管道尚可写时尝试，强制终止作为有界兜底，不能让取消等待无限延长。

保留当前交互请求并发限制、3 分钟总超时和 1MiB UTF-8 正文上限，除非另有明确需求。帧限制须考虑 JSON 转义后的大小，不把网络块边界等同于 UTF-8 字符边界。超大/畸形帧立即终止且不落库。进程工作目录只能是受控临时目录，不能使用文档原目录。

内部错误至少区分配置/认证、能力、协议、上游拒绝或限制、网络中断、超时、主动取消、保存失败。v1 仍映射为现有 HTTP 错误或 error 事件；日志只记录脱敏类别、耗时和内部关联 ID，不记录 key、认证 token 或整篇文档。可观测性记录首个真实正文时间、首个 SSE Flush 时间与完成时间，不以动画时间代替上游延迟。

## 8. 分阶段交付

| 阶段 | 交付物与完成条件 |
| --- | --- |
| B1：提取统一接口 | 保持 v1 wire 不变，将三种 Agent 归入 Adapter/GenerationService；旧协议测试保持通过，纯文字/图片不各自维护终态与保存规则。 |
| B2：API 流与统一策略 | 备用 API 真实增量、连接能力、文字/图片备用规则一致；首段发出后上游仍未结束的 gated 测试通过。 |
| B3：生命周期 | 迟到/重复事件、身份过滤、协议取消与强制回收、写失败、无终态、保存失败均有覆盖；无部分成功落库或二次回答拼接。 |
| B4：连接抽象与联调 | 内部连接/认证抽象完成，对外保持冻结请求；补齐 OpenAPI 与生成类型，前端同一消费者驱动三种 Agent 与 API，完成真实文字/图片联调。 |

重点复用并扩展 `agent_stream_test.go`。每个适配器都用相同合同测试验证：第一段在上游完成前到达、所有 delta 拼接等于成功正文、快照不重复、失败/取消不成功保存、终态仅一次、资源及时释放。Kimi 增加 sessionId/协商版本/取消排队更新，Claude 增加 result 后迟到 delta，Codex 保留 thread/turn/item 边界及快照改写检查。HTTP API 增加 SSE 分片、上游错误、截断和无终态测试。

正式检查：`pnpm typecheck`、`pnpm test`、`pnpm build`，后端补 `go test -race ./...`。真实模型测试只用内置原创提示/合成图片，不用用户书籍。每个 Agent 分别记录 CLI 版本、真实或模拟、文字/图片、首段是否早于终态、取消结果；未登录项标为待验证。现有对接文档记录的历史实测不等于本次重构已验证。

后端负责 `apps/server`、`docs/openapi.yaml`、生成的 `packages/api-client/src/schema.d.ts` 与共同契约；前端负责 SDK 消费及 UI。实施前核对 worktree 和未提交修改，不回退另一会话的编辑。交付包括代码、测试记录、更新后的共同契约和具体未验证项。两份方案的完成不等于代码迁移完成。

共同契约的冻结内容由协调会话维护。后端可更新其中的实现/验证进度，但接口变更须先提出原因和兼容方案，不能直接修改冻结项。前端拥有渲染依赖和 pnpm 锁文件；后端不并发编辑 UI、SDK 消费实现或锁文件。向协调会话报告 B1–B4 状态、分支/提交、已实现的备用行为、模拟/真实测试和前端可用的联调方式。

阶段记录写入自己拥有的 `docs/implementation/backend-streaming-progress.md`。任务分支以已提交 main 加本轮任务文档为基线；不改正在工作的其他后端分支或主工作区。提交仅包含自己拥有的改动，先交付分支与证据，由协调会话统一安排联调和集成，不自行合并 main。
