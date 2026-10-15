# Reader API 设置与用量体验 Implementation Plan

**Goal:** API 提供者使用可收起卡片管理，明确保存与测试操作；只按选中模型的相关能力限制使用；阅读器 token 面板仅为有定价的实际 API 调用显示费用。
**Architecture:** 保留现有 Go 配置、探测、价格快照与 API 合同。前端为提供者维护隔离的临时草稿，显式保存到当前配置；不引入配置框架、依赖或新协议。
**Tech Stack:** React/TypeScript、已有 Base UI/shadcn、现有CSS、Vitest、Go。
**Spec:** 本轮用户纠正：更流畅外观，提供者切换时折叠成完整小矩形，按钮小字用途说明，明确保存配置，可用选中模型可选，token 面板有 API 价格才显示价格。此前每模型独立价格要求继续有效。

## 边界与外观
- 同一 codex/model-settings 工作区从4ec4019继续，不push，不访问真实书库/Key。读AGENTS.local。禁止浏览器自动化视觉验收。
- 配色沿用主题token：浅色白#ffffff、背景#f8fafc、文字#171717、次级#64748b、边框#e2e8f0、蓝#2563eb；这些是语义参考，不把浅色常量强加给暗色。字体复用系统字体。
- 卡片左对齐，名字14px、字段13px、说明12px；收起显示名称、地址、已启用模型数、未保存状态。高级设置和模型设置按需展开。
- 使用现有Collapsible/Tooltip/Button等原语。展开高度/透明度、收起、按钮hover/active使用约180–220ms过渡并支持reduced-motion；不添加装饰动画。
- DSH参考：/tmp/reader-dsh-reference下ProviderEditor.tsx、EditorFooter.tsx、ModelRow.tsx、ModelsSection.module.css。参考其连接/模型/保存层级，不复制完整依赖。

## Task A: 提供者卡片与明确保存
Owner: Settings.tsx, APIProviderSettings.tsx, APIAgentForm.tsx, APIPricingForm.tsx, APITimeouts.tsx, style.css, api-agent-settings.test.tsx，以及必要的专用新组件/测试。
- [ ] 先添加行为失败测试：新增/切换只展开一张卡；未保存连接、Key、模型价和时限切换后仍保留；保存失败不清空；显式保存一次合并当前提供者草稿且保留其他提供者。
- [ ] 维护草稿和服务器状态边界。例如 `saveProvider(id, draft)` 先GET最新config，再只替换该id的record；成功后采用脱敏响应并清除Key输入，失败保留草稿。
- [ ] 无配置时显示添加入口，不显示虚构默认提供者或默认DeepSeek地址。保持已有真实配置可编辑。新建卡片输入名称/地址/协议/Key，底部“保存配置”；切换或新增折叠前卡，草稿不丢。
- [ ] 保存连接后获取模型列表（不探测）。模型列表、手填模型、勾选启用、每模型独立价/时限均可操作并纳入卡片保存。测试按钮使用已保存配置；若草稿未保存清楚提示，不悄悄测试旧地址。
- [ ] “获取模型列表”说明只读取候选，不发起能力测试；“测试文本/图片”说明验证相应可用性；工具测试放高级，不作为普通问答门槛。模型搜索如列表长可使用本地过滤，不丢草稿。
- [ ] 保存状态清晰：未保存/保存中/已保存，保存失败inline error与可重试；不要重命名、连接、单价等分散一串保存按钮。
- [ ] Settings主API选择不因其他模型测试而disable；保留实际保存互斥。Task B负责选择组件，协调文案。
- [ ] 跑focusedSettings测试与typecheck；只修改本任务文件，根任务集成后提交。

## Task B: 明确模型选择与条件费用
Owner: TaskModels.tsx, ModelSelector.tsx, ProcessingUsage.tsx, 对应测试；只有证据证明backend额外gate才修改所需Go及测试。不得编辑Task A文件。
- [ ] 添加失败测试：用户选推荐API模型时保存实际modelID，不编码成auto；另一模型失败/未检测/无图片或tools不影响所选文本可用模型。保持显式停用不可选，图片需求只看对应图像能力。
- [ ] 精准修改选择逻辑：`chooseModel(task, id)` 保存id；auto仅在用户明确选auto时使用。检查UI/后端不要求其他provider/model检查全通过，不进行无依据重构。
- [ ] 用量面板费用按实际calls及其模型cost/price，不按当前选中Agent重算旧记录。`call.provider === 'api' && call.price` 才能贡献价格展示；无单价、无可计算金额/无usage则隐藏价格区，不影响token统计。显式0显示0，部分可估算显示已估部分，各币种分列。
- [ ] 单纯CLI报告无费用标题/费用未知/价格来源。混合报告只汇总已定价API金额，未定价或CLI不伪装免费。模型详情有对应价格时才显示单价来源；保留历史快照，不能当前配置×历史token。
- [ ] 跑模型选择及usage相关测试/typecheck，相关Go按变更决定；根任务最终全量验证与提交。

## 集成与验收
- [ ] 两任务文件互斥并行，用dispatching-parallel-agents；检查草稿保存与TaskModels读取已保存配置的衔接。
- [ ] 单次独立review覆盖本轮完整diff，修复重要问题。
- [ ] pnpm typecheck、pnpm test --maxWorkers=2、pnpm build；失败先诊断。不得仅为了流程重复已通过且未变化的检查。
- [ ] 原63735预览保持session与开发书库更新，HTTP验证，用户手动视觉验收。
- [ ] 明确报告行为、提交、本地预览、自动验证及视觉未自动验收边界。
