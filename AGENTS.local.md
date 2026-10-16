# Reader Local Working Preferences

本 checkout 的个人规则，在 AGENTS.md 之上补充；两者冲突时以本文件为准。

## 在哪里工作
- 小型 UI 调整（间距、颜色、对齐、文案、图标、轻微布局；不改变行为、API、数据或依赖）：直接在 `main` 上做。先 `git pull --rebase`，跑下文的快速验证，提交后立即推送（覆盖 AGENTS.md 中“仅在用户要求时推送”的规则，仅限这类改动）。
- 其他工作（功能、跨模块改动、重构、OpenAPI/schema 或依赖变更）：编辑前先建独立 worktree 和分支：
  `git worktree add .claude/worktrees/<slug> -b <type>/<slug> origin/main`
- UI 微调一旦变成行为改动，先把改动移到 worktree 再继续。
- 每个 worktree 只做一个任务，在 worktree 内单独 `pnpm install`；主 checkout 保持干净，留给小修改。

## 合并后立即清理
合并后的 worktree 各自带着 node_modules 和构建产物，分支一进入 `main` 就删掉：
1. 确认已合并：`git fetch --prune`，然后 `git merge-base --is-ancestor <branch> origin/main`。仓库同时允许 squash/rebase 合并，此时改用 `gh pr view <branch> --json state` 返回 `MERGED`，或 `git cherry origin/main <branch>` 没有 `+` 行。
2. 确认不会丢东西：`git -C .claude/worktrees/<slug> status --short` 为空。有未提交或未合并的改动时停下来问我。
3. 删除：`git worktree remove .claude/worktrees/<slug>`，再 `git branch -d <branch>`（只有在第 1 步证明是 squash/rebase 合并后才用 `-D`）。worktree 若被其他会话锁定（`locked`），先问我。
4. `git worktree prune`。
开始新任务前先看 `git worktree list`，清理分支已合并的 worktree。

## 技术栈
- 前端：React + TypeScript。UI 用 `packages/ui` 中基于 Base UI（`@base-ui/react`）的 shadcn 组件（style `base-nova`），缺少的组件用 shadcn CLI 添加，不手写对话框、菜单、标签页、弹出层或按钮。图标用 Lucide。
- 后端：Go（`apps/server`）。
- 新代码优先沿用这套技术栈，除非该区域已有既定方案。

## Small UI validation

非常小、局部且低风险的 UI 调整不运行完整的 `pnpm test` 或 `pnpm build`。这类改动包括间距、颜色、对齐、控件位置、文案、图标，以及删除纯展示信息。

按实际改动执行最小验证：优先运行直接相关的测试；修改 TypeScript 时运行 `pnpm typecheck`；纯 CSS 或静态文案调整可只做差异检查和必要的人工验收说明。

当改动扩展到应用行为、数据持久化、生命周期、解析器、Provider 协议、跨模块接口、依赖、构建或发布配置时，再运行相应的完整检查。只有用户明确要求时，才为上述小型 UI 调整额外运行完整测试或完整构建。

## 合并前检查
合并 worktree 分支前运行完整检查：`pnpm typecheck`、`pnpm test`、`pnpm build`。

## Web 预览测试数据

启动 Web preview 后，必须预先导入至少一篇可打开的真实论文，并确认论文已出现在该预览的书库中，再向用户提供预览链接。优先使用工作区已有的测试论文。根据当前验收功能准备好所需的解析结果、段落 block 或译文；不能只启动空书库，让用户自行导入论文。使用独立预览数据目录，保留用户现有书库。
