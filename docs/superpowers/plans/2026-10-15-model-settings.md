# Reader 模型配置 Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement these tasks sequentially, with task review and final review. Never dispatch multiple implementers concurrently.

**Goal:** 用户在自己的分支控制检测等待时间、启用模型、多个 API 提供商及估算费用。
**Architecture:** 保留 Go API 调用层和现有 JSON 配置存储；扩展 API 连接配置与模型引用，复用现有用量记录。逐阶段迁移，保留 CLI Agent 和备用 API 行为。
**Tech Stack:** Go, React/TypeScript, existing shadcn components, Vitest, Go tests.
**Spec:** docs/superpowers/specs/2026-10-15-model-settings.md (user approved).

## Global Constraints

- 只在 codex/model-settings 工作区修改并分阶段提交，不推送、不创建上游 PR。
- 不读取真实凭据或修改真实书库；测试使用临时书库和 mock HTTP。
- 保留已有 CLI Agent、流式输出和备用 API 行为；不新增依赖或重写传输层。
- Key 返回前必须脱敏；保存空输入按 hasKey 保留旧值，显式删除只清除目标提供商。
- UI 复用组件，支持暗色、reduced motion 和现有过渡，不做无关视觉重构。禁止浏览器自动化视觉验收。
- 每阶段先写并运行失败测试，再实现；每阶段运行相关测试及类型检查，最后 pnpm typecheck、pnpm test、pnpm build。
- 合同同时更新 Go、reader-core 类型、OpenAPI 和 api:generate 产物。

### Task 1: 检测时限和启用模型

**Files:** apps/server/internal/reader/connections.go, connection_probe_test.go, connections_test.go, api_agent.go, api_agent_test.go; apps/web/src/Settings.tsx, APIAgentForm.tsx, ModelSelector.tsx and related tests; packages/reader-core/src/index.ts; docs/openapi.yaml; packages/api-client/src/schema.d.ts.

**Interfaces:** Add optional AIConfig.apiEnabledModels string[] (nil/omitted means legacy enabled models; explicit [] disables all), APIConnection.textProbeTimeoutSeconds and visionProbeTimeoutSeconds (0/omitted defaults 45/90; values 1..600 accepted). Use same helper for text/vision/tool probes as appropriate. Existing APIModels continues to mean manual IDs, never reinterpret as allowlist. AgentModel.enabled optional boolean identifies disabled candidates. Catalog can show candidates but recommendations/routing/selectors must exclude disabled models. Preserve explicitly selected legacy task models and manual IDs on first selection save; allow removing all without silently reverting to defaults.

- [ ] Write failing Go tests for timeout validation/defaults/persistence and probe context deadline with a local HTTP server; use short configurable durations rather than a minute-long test.
- [ ] Write failing behavior tests for enabled-model restrictions across recommendations/generation, empty allowlist, old configuration, and manually added IDs when /models fails. UI test opening/refetching settings issues no API probe; explicit selected-model test only probes selected models with bounded concurrency.
- [ ] Implement shared timeout resolution and explicit stage-aware timeout messages. A transient timeout/network/429/5xx check must retain previous success for same fingerprint, expose last error and last successful time separately; hard auth/unsupported capability failures must not become success. Do not mark never-successful models usable.
- [ ] Implement checkbox-based enabled models, text and image probe timeout form controls. Separate fetch-model-list from test actions. Do not automatically test API models on open/config save or refresh-list. Text-only testing must not unconditionally trigger paid vision probes; provide explicit vision action. At most two explicit model checks concurrently. Keep CLI behavior unchanged.
- [ ] Regenerate schema, run focused Go/Vitest tests and pnpm typecheck, inspect diff, commit feat(ai): configure model probes and enabled models.

Example test contract:
```go
c := AIConfig{APIEnabledModels: []string{}}
// No cached successful capability may make apiCapable(c, taskChat, false) true.
// With explicit enabled model, disabled candidate never receives RecommendedFor.
```
```ts
// Fetch settings/catalog, assert api.testAI has no API calls.
// Enable model A only, click explicit text check, assert B and vision not requested.
```

### Task 2: 多提供商和实际请求时限

**Files:** connections.go and new focused api_providers.go/tests; api_agent.go, generation.go, document tool adapters and catalog handlers as needed; Settings.tsx/APIAgentForm.tsx/TaskModels.tsx/ModelSelector.tsx; reader-core, api-client, OpenAPI, related tests.

**Interfaces:** Consume Task 1 probe timeouts/allowlist. Introduce AIConfig.apiProviders array of stable-ID provider records holding display name, APIConnection, enabled/manual models and optional model overrides. Legacy API is migrated to a stable default provider without losing keys, selections or successful capabilities. Retain legacy config compatibility but avoid two independently mutable sources of truth. Task references and model capability identity must include provider ID; API wire model ID remains unchanged. User-facing names include provider/model. Stage 3 consumes provider identity on every API UsageCall and model override settings.

- [ ] Write failing migration/redaction tests: old key/model/capabilities survive save/reload; different providers same model ID do not share credentials or results; rename preserves identity; delete selected provider yields explicit missing-choice state, no silent reroute.
- [ ] Implement provider configuration and UI create/edit/delete, manual model IDs and optional discover/checkbox selection. All task selection paths (chat/translation/vision, toolbar, background processing, document tools) resolve snapshot provider + model, including auto defaults among enabled successful models. Do not add new protocols beyond existing OpenAI/Anthropic.
- [ ] Keep one immutable routing snapshot per generation. Add provider defaults/model overrides for probe timeouts and generation first-output, idle, total timeouts. Default actual request behavior stays current when fields omitted. Configured values 1..3600 seconds; total at most 7200 seconds, with outer task contexts respecting configured limits for API requests. Meaningful reasoning/text/tool progress resets idle; transport heartbeat alone does not. Cancellation remains immediate and no fallback after partial output. Implement timers around existing adapter events, not a second transport. Expose advanced timeout controls with effective inherited values.
- [ ] Write protocol integration tests showing chat and vision use different endpoints with same model ID, unrelated key changes preserve other provider capabilities, runtime total/first-output/idle timeout errors are distinct and parent cancellation wins. Verify document-tool path and API usage provider identity.
- [ ] Regenerate contracts, run focused tests and typecheck, inspect diff, commit feat(ai): support multiple API providers and request timeouts.

Pseudo-interface intent (choose exact representation matching repository patterns, document it in report):
```ts
// A saved model reference is namespaced; request body uses its raw model ID.
// resolve(providerId, modelId) => connection snapshot + effective settings
// provider default < model override; omitted fields inherit, not reset.
```

### Task 3: 自定义价格和历史费用

**Files:** new focused pricing.go/tests; connections.go provider/model validation, usage.go/usage_test.go, API adapter usage integration; provider/model settings UI; ProcessingUsage.tsx and processing-usage.test.tsx; reader-core, OpenAPI and generated types; docs/processing-usage.md.

**Interfaces:** Consume Task 2 provider/model identity and override records. Pricing has currency (CNY or USD), optional nonnegative finite input/output/cacheRead/cacheWrite values per million tokens. Model overrides inherit omitted fields from provider defaults; zero is explicit free. No currency mixing or automatic exchange rates. UsageCall or model usage saves effective price snapshot before first request and stores estimated cost/status, so editing prices never rewrites history.

- [ ] Write failing tests for default inheritance, partial model override, explicit zero vs unknown, invalid/negative prices, currency separation, price change mid-request, failed call with tokens, old records lacking price, incomplete usage and cache input counted exactly once.
- [ ] Implement price form with provider defaults/model overrides and inherited source; empty field clears override, not zero. Currency switches cannot retain inherited amounts from a different currency without explicit handling.
- [ ] Capture immutable effective prices with each call. Compute ordinary input as total input minus known cache read/write and output as total output already including reasoning. Do not charge reasoning twice. Missing usage or necessary price reports unknown/partial; never silently show zero. Handle unknown cache breakdown honestly if differential rates prevent complete estimate.
- [ ] Aggregate per currency into existing document/chat usage UI with estimated totals, partial/unknown counts, per-provider/model cost and price source. Preserve old history and existing duration/token counts, including combineUsageReports.
- [ ] Regenerate contracts, focused tests/typecheck, inspect diff, commit feat(usage): estimate costs with provider and model pricing.

Example expected arithmetic:
```text
input=1000 (cached=200, cacheWrite=100), output=100
prices per million: input=2, output=8, cacheRead=0.5, cacheWrite=3
cost=(700*2 + 100*8 + 200*0.5 + 100*3)/1e6 = 0.0026
```

## Final delivery

- [ ] Independent whole-branch review, resolve material findings with regression tests.
- [ ] Run pnpm typecheck, pnpm test, pnpm build on final HEAD; record logs.
- [ ] Launch isolated development preview using a temporary or Reader Dev library; no production library migration.
- [ ] Report branch, worktree, commit hashes, tests, preview access and manual verification steps; do not push unless user requests.
