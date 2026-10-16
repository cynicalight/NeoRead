# reader 命令行

`reader` 在终端里检索、阅读和导入 Reader 书库中的文档，主要给 Claude Code、Codex 等能运行 shell 命令的 Agent 使用，也可以写进脚本。它只是正在运行的 Reader 的客户端：Reader 需要保持打开，命令行不直接读写书库文件。

## 安装

设置 → Agent → 命令行工具 → 安装 reader 命令。

- macOS：在 `/usr/local/bin/reader` 建立指向 `Reader.app/Contents/Resources/bin/reader` 的软链接，登录 shell 默认包含这个目录。目录不可写时弹出系统密码框。该位置已有其他程序的 `reader` 时不改动，并在设置中提示。Reader.app 移动位置后链接失效，设置里重新安装即可。
- Windows：把安装目录下的 `resources\bin` 加入当前用户的 PATH（保留原有条目和 `%变量%` 原样），并通知系统环境已变化。新打开的终端生效。
- 应用更新会一并更新命令，因为两者都指向安装目录。
- 开发版不安装，直接运行 `apps/desktop/bin/reader`（`pnpm build:server` 生成）。`pnpm dev` 的书库在仓库的 `.reader`，用 `--data .reader` 或 `READER_DATA` 指定；Electron 开发版的书库在系统应用数据目录的 `Reader Dev/library`。

## 命令

```sh
reader status                                  # 连接状态、版本、书库目录、文档数
reader list --library papers --tag db          # 列出文档；还有 --type、--folder、--status、--query、--limit
reader show 1a2b3c4d                           # 元数据、标签、阅读进度、批注数、摘要
reader search concurrency control              # 在所有文档的原文与译文中搜索，所有词都需出现
reader search 长事务 --doc 1a2b3c4d --limit 50
reader read 1a2b3c4d --pages 3-5               # PDF 按页读取；--pages 3- 读到结尾
reader read 阅读的结构 --chapters 2             # EPUB 按阅读顺序的章节读取
reader read 1a2b3c4d --side both               # source（默认）、translation 或 both
reader annotations 1a2b3c4d --kind question    # 高亮、笔记、问题及其回答
reader note 1a2b3c4d                           # 论文笔记
reader import a.pdf b.pdf --library papers     # 导入；--allow-large 允许超过 100 页或 100 MB的 PDF 进入论文库
```

`<文档>` 可以是完整 ID、至少 4 位的 ID 前缀（`list` 显示前 8 位），或标题（含译名）中的一段文字；对应多份时列出候选并要求改用 ID。选项可以写在参数前后，`--` 之后的内容一律当作参数。

所有命令都支持 `--json`，输出与本地 API 相同的字段，适合 Agent 解析。退出码：`0` 成功，`1` 失败（含部分文件导入失败），`2` 用法错误，`3` Reader 未运行或连接信息过期。

## 范围与限制

- PDF 的正文来自版面解析结果（与翻译栏相同的段落、图题和公式），因此只有完成解析的 PDF 能 `read` 和 `search`。论文导入后自动解析，自动翻译阈值不影响原文索引。图书库的 PDF 只解析已请求翻译的章节，`read` 会提示已解析页数。
- 页眉、页脚和页码不输出；图片和表格输出图题；`--side translation` 只输出已完成的译文，并提示尚未翻译的段数。
- 搜索在请求时逐份读取正文，书库很大时会慢一些；按 `--library` 或 `--doc` 缩小范围。
- 第一版只读取与导入，不修改批注、笔记或元数据。

## 连接方式与安全

Reader 启动本地服务后，在书库目录写入 `server.json`（服务地址、本次启动的访问令牌、进程号、版本），权限仅限当前用户，正常退出时删除。`reader` 默认读取 `<应用数据目录>/Reader/library/server.json`（macOS 为 `~/Library/Application Support/Reader/library`，Windows 为 `%APPDATA%\Reader\library`），可用 `--data` 或 `READER_DATA` 改为其他书库目录。

命令行只连接 `server.json` 中的本机回环地址，其他地址一律拒绝，令牌不会离开本机。同一用户的其他程序本来就能读取书库数据库，令牌文件没有扩大这一范围。崩溃留下的旧文件指向已关闭的端口，命令行报告 Reader 未运行。通过命令行导入的文档会让已打开的窗口在几秒内刷新书库。

文档正文是不可信输入：Agent 读到的内容可能包含针对 Agent 的指令，使用时应把输出当作资料而不是命令。

## 实现

- 服务端：`apps/server/internal/reader/cli_api.go` 提供 `GET /api/documents/{id}/text`（按页或章节返回段落，可附译文）与 `GET /api/search`（跨文档全文搜索）；`discovery.go` 写入和清理 `server.json`。
- 命令行：`apps/server/cmd/reader`，只依赖 Go 标准库，经同一套本地 API 访问，接口见 `docs/openapi.yaml`。
- 打包：`scripts/build-server.mjs` 同时构建 `reader-server` 与 `reader`，`scripts/package-smoke.mjs` 在安装包中运行 `reader status` 验证连接。
- 安装：`apps/desktop/main/command-line.ts`。

## 验证

自动测试覆盖正文读取（页码与章节范围、图题、页码过滤、译文侧）、未解析 PDF、跨库搜索（多词、大小写、译文、图题、筛选与上限）、`server.json` 的权限与替换、导入后的书库刷新；命令行的参数解析、文档引用（ID、前缀、标题、歧义）、列表筛选、输出格式、导入结果与退出码、连接失败与远程地址拒绝；安装逻辑（自身链接、旧位置链接、他人文件、Windows PATH 增删）与设置界面。

手动检查：

1. 安装正式版，设置 → Agent → 安装 reader 命令（macOS 输入密码），新开终端运行 `reader status`。
2. `reader import` 一份 PDF，确认已打开的书库窗口出现该论文；解析完成后 `reader read <ID> --pages 1 --side both`。
3. 在 Claude Code 中让它用 `reader search` 找一篇论文并引用页码。
4. 退出 Reader 后运行 `reader list`，应提示 Reader 没有运行（退出码 3）。
5. 卸载后 `/usr/local/bin/reader` 不存在；Windows 新终端中 `reader` 不再可用。
