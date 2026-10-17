<p align="center">
  <img src="assets/logo/reader-logo.svg" width="112" alt="Reader logo" />
</p>

<h1 align="center">Reader</h1>

<p align="center"><b>简体中文</b> | <a href="README.en.md">English</a> | <a href="https://cynicalight.github.io/reader/">官网</a></p>

一个本地优先的 EPUB / PDF AI 阅读器，用于阅读电子书与论文、对照译文、记录批注，以及结合原文向 AI 提问。

<p align="center">
  <img src="website/assets/screenshots/pdf-bilingual-ai.webp" alt="Reader 的 PDF 双语阅读界面：左侧目录，中间原文与译文，右侧 AI 助读" />
</p>

Reader 以 EPUB 和 PDF 为两种核心文档格式，将图书库与论文库分开管理，提供目录、搜索、双语对照、批注与 AI 助读。文档、阅读进度和笔记保存在本机。AI 功能可以通过已登录的 Claude Code、Codex CLI 或 Kimi Code CLI 调用，无需在 Reader 中另填 API Key；也可以填写 API 地址和 Key，接入 OpenAI 或 Anthropic 兼容接口。

可从[官网](https://cynicalight.github.io/reader/)了解项目，或在 [GitHub Releases](https://github.com/cynicalight/reader/releases) 下载安装包：macOS（Apple Silicon）DMG 与 Windows x64 EXE。Intel Mac 安装包暂停构建，Linux 不提供安装包，也可以从源码运行。安装包没有受系统信任的开发者证书，首次运行可能需要允许系统安全提示。流程与验证范围见[安装包与发版说明](docs/releasing.md)。

## 功能

**书库与论文管理**

- **图书库与论文库**：分别管理电子书和论文，可在两库间移动文档。图书库支持 EPUB / PDF；论文库只收 PDF，单个文件不超过 50 MB、150 页，超过 50 页时会先询问。
- **论文信息**：编辑作者、年份、出处、DOI、arXiv、摘要等信息；在线补全不覆盖手动修改。支持嵌套分类、标签与智能标签分类、列表与可排序表格视图、阅读状态、批量操作、重复论文检测与合并、双向相关论文。
- **期刊评级**：配置 easyScholar 密钥后，在论文标题旁显示期刊评级，可选择要显示的评级体系。
- **多种收录方式**：通过编号、链接或标题导入；安装 [Reader Connector](docs/reader-connector.md) Chrome 扩展后，可从论文页面或搜索结果收录 PDF、论文信息和离线网页快照；也可[从本机 Zotero 迁移](docs/zotero-migration.md) PDF、论文信息、分类、标签、笔记和可转换的批注。
- **引用导出**：支持 GB/T 7714、APA、BibTeX 和 RIS，可复制单篇引用或批量导出。
- **回收站**：删除后保留原文件、批注和对话，可撤销或恢复；确认彻底删除后才移除数据。

**阅读与翻译**

- **统一阅读界面**：左侧目录与搜索，中间正文，右侧 AI 对话与笔记；可调整侧栏宽度或收起侧栏。
- **PDF 解析与翻译**：本地按页解析正文与版面，翻译正文和图题，并把公式图片转为 LaTeX；图书 PDF 按章翻译。进度显示在书库封面浮层中，可边处理边阅读。鼠标移到段落或图片上时，可复制内容、放大查看原图或让 AI 解释。
- **EPUB 双语阅读**：正文在应用内连续滚动或翻页阅读，“翻译本章”按需翻译当前章节；原文与译文对照滚动，句子悬停联动，批注在原文和译文间共享。译文可单独设置字体、字号和字重。
- **阅读记录**：书签、高亮、下划线、问题批注、批注标签、论文笔记与阅读位置恢复；悬停即可预览批注，支持按颜色和标签筛选、搜索笔记、撤销批注改动、摘录批注、Markdown 导出及桌面 `reader://` 链接。PDF 内部引用支持悬停预览和返回阅读位置。
- **阅读偏好**：双击选中整句，可选开启选中文字自动复制；可自定义高亮颜色和译文字体；界面支持浅色、深色、纸张与跟随系统，桌面窗口外观同步切换。

**AI 助读**

- **问答与解释**：选区翻译与解释、多选区引用、EPUB 当前章节或 PDF 当前页总结、对话历史和生成取消。普通提问默认附带论文标题和摘要，可开启章节正文；引用选段提问时附带所在章节。回答中的出处可跳回原文并闪烁定位。
- **两种接入方式**：检测本机 Claude Code / Codex CLI / Kimi Code CLI 的安装与登录状态，通过官方 CLI 使用已有账户；或在设置中配置 API 连接，支持 OpenAI Chat Completions 与 Anthropic Messages 协议。问答与翻译可分别选择模型和思考强度。

**桌面应用**

- **应用内更新**：检查并下载新版本，显示下载进度；macOS 固定证书版本原地更新，Windows 校验后静默安装并重新打开 Reader。
- **代理与诊断**：在设置中选择跟随系统代理、手动代理或直连，并检测连接；遇到问题时可导出过滤敏感字段的[诊断日志](docs/diagnostics.md)。
- **指南与更新说明**：首次使用指南帮助完成 Agent 设置；每个版本附带离线更新说明，可从更新提示直接到 GitHub 反馈。

论文库的收录限制、联网查找、重复合并与人工检查步骤见[论文库说明](docs/paper-library.md)。

两种格式各自保留适合其排版的阅读方式：

| 能力       | EPUB                                            | PDF                      |
| ---------- | ----------------------------------------------- | ------------------------ |
| 阅读内核   | 应用内渲染清理后的章节，Readium Go Toolkit 解析 | PDF.js Viewer            |
| 导航       | 分级目录、章节跳转、章内与跨章链接              | Outline 目录、页码跳转   |
| 排版       | 连续滚动 / 翻页、字号、字体、行距、页边距       | 连续滚动、缩放、适合宽度 |
| 翻译       | 按章手动翻译，原文 / 译文对照                   | 导入后解析并翻译         |
| 搜索       | SQLite FTS5，配合字面子串匹配                   | 逐页文本搜索             |
| 定位与批注 | 章节资源、段落 ID 与字符范围                    | 页码与归一化选区矩形     |

空书库中可以点击“先体验示例文档”，加载项目附带的原创三章 EPUB 和两页 PDF。

## 截图

以下截图来自应用本身，使用项目自带的示例文档；图片会跟随 GitHub 的浅色 / 深色外观。

| 书库                                                                                                                                                                                                                         | Agent 设置                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| <picture> <source media="(prefers-color-scheme: dark)" srcset="website/assets/screenshots/library-dark.webp" /> <img src="website/assets/screenshots/library-light.webp" alt="书库，PDF 封面上显示后台处理进度" /></picture> | <img src="website/assets/screenshots/settings-light.webp" alt="Agent 设置：Codex、Claude Code 与 Kimi Code" /> |

## 快速开始

需要 **Node.js 22+、pnpm 10.30.3 和 Go 1.26.5+**。

```sh
git clone https://github.com/cynicalight/reader.git
cd reader
pnpm install
pnpm desktop
```

`pnpm desktop` 会构建 Go 服务、Web 界面和 Electron，然后打开桌面窗口。主 API 监听本机随机端口，并随应用关闭。

若安装时 Electron 二进制未成功下载，可运行以下命令后重试：

```sh
node apps/desktop/node_modules/electron/install.js
```

## 使用 AI

AI 是可选功能。本地阅读、搜索和批注不需要登录 AI 账户。

**通过 CLI 接入**：先安装所需的官方 CLI，并在终端完成登录：

```sh
# 使用 Codex
codex login

# 或使用 Claude Code
claude auth login
```

Reader 不安装 CLI、不读取其凭据文件，也不自行实现 OAuth。账户权限、额度、模型可用性与计费方式由 CLI 登录和对应服务决定。旧版 CLI 可能需要升级才能支持桥接参数。

**通过 API 接入**：在设置中选择 API，填写地址、Key 和模型。请求协议默认按官方地址自动识别，也可手动选择 OpenAI Chat Completions 或 Anthropic Messages；中转地址保持填写的根路径。Key 只保存在本机后端，界面只显示是否已配置。各厂商思考强度的适配规则见 [API 厂商适配](docs/api-provider-compatibility.md)。

打开 Reader 设置，指定主 Agent，并检查文字与图片能力检测结果。真实测试通过后显示绿色徽标，等待中的 PDF 翻译会自动继续。问答与翻译可分别选择模型及支持的思考强度；未指定时使用对应任务的推荐模型。

应用内置约 67 MB 的版面模型，首次解析 PDF 即可离线提取版面和定位图片区域；无需安装 Python 或 PaddlePaddle。模型在构建时获取并校验，权重不进入 Git。未配置通过能力测试的主 Agent 时，正文阅读和图片区域悬停仍可用，翻译显示等待配置。退出后会恢复任务并复用已保存译文；扫描页尚不支持 OCR，会明确标记正文不完整。

**调用 AI 时，相关内容会离开本机。** 图片能力测试使用合成图片；启用主 Agent 后，导入 PDF 的正文和图题会发送翻译，公式图片会发送转换为 LaTeX；图表和表格不会发送解析。EPUB 只在点击“翻译本章”后发送该章正文。触发翻译、解释、总结或发送问题后，Reader 会将选区、论文标题与摘要、按需附带的章节或当前页面上下文及最近对话交给 CLI 或 API 服务。章节和上下文有长度限制；当前页总结不等于整篇论文总结。

CLI 在临时空目录中运行。Claude 配置为禁用工具与 MCP；Codex 使用只读沙箱并禁用 shell 工具。CLI 的原始日志不会作为回答显示。Codex 通过 App Server 接收增量文字，Claude 使用 stream-json，Kimi 使用 ACP 消息片段，API 使用 SSE；纯文字和图片对话均逐段传输。前端对接约定见 [Agent 流式输出文档](docs/agent-streaming-contract.md)。

## 本地数据

原文件存放在文件系统，文档信息、进度、批注、对话与设置存放在 SQLite。Reader 没有内置云同步。论文元数据查找和在线导入会访问公开的论文服务；自动补全仅发送识别到的 DOI 或 arXiv 编号，可在设置中关闭。期刊评级只在配置 easyScholar 密钥后查询，并在本机缓存结果。

| 运行方式                       | 数据目录                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| 已安装桌面版                   | Electron `userData/library/`；macOS 通常为 `~/Library/Application Support/Reader/library/` |
| 未打包桌面版（`pnpm desktop`） | macOS 为 `~/Library/Application Support/Reader Dev/library/`                               |
| 浏览器开发模式（`pnpm dev`）   | 项目根目录的 `.reader/`                                                                    |

此前用 `pnpm desktop` 作为日常应用的人，旧书库仍在 `~/Library/Application Support/Reader/library/`；关闭 Reader 后可将其复制到新目录。

```text
library/
├── reader.sqlite       # 文档信息、阅读记录、对话、设置与全文索引
├── books/              # EPUB 原文件
├── papers/             # PDF 原文件
├── cache/              # EPUB 资源；PDF analysis 下的 Markdown、图片与解析稿
└── ai-work/            # CLI 临时目录，请求结束后移除
```

桌面版的运行日志保存在 `userData/logs/`，最多保留 7 天，不会自动上传。备份前先关闭应用，再复制整个数据目录。本地 API 使用每次启动随机生成的 token，并校验 Host / Origin。EPUB 导入会检查压缩包大小、资源路径并清理活动内容；原文件保持原样。

## 开发

启动 Go 服务和带热更新的 Web 界面：

```sh
pnpm dev
```

终端会输出 `http://127.0.0.1:5173/#token=…`，请用完整地址打开。Vite 将请求代理到 `127.0.0.1:17840` 的 Go 服务。该 token 用于本地服务鉴权，不是 AI 账户凭据，请勿分享带 token 的地址。

开发运行默认不监听插件端口；设置 `READER_DEV_CONNECTOR=1` 可启用。未打包桌面版默认不注册 `reader://`；设置 `READER_DEV_PROTOCOL=1` 可启用。

`pnpm dev`、`pnpm desktop` 和 `pnpm build` 会先准备固定版本的版面模型。首次构建需要下载约 67 MB，后续校验并复用 `apps/processor/models/` 中的构建缓存；该目录不进入 Git。离线构建可将 `READER_BUILD_LAYOUT_MODEL` 设为已有权重文件的绝对路径，仍需通过大小和 SHA256 校验。`pnpm install`、类型检查和普通单元测试不下载模型。

```sh
pnpm typecheck     # TypeScript 类型检查
pnpm test          # Go 集成测试与 Vitest
pnpm build         # 构建 Go、Web 和 Electron
pnpm api:generate  # 从 OpenAPI 重新生成客户端类型
```

项目官网位于 `website/`，是无需构建的静态 HTML / CSS / JavaScript。本地预览：`python3 -m http.server 4321 -d website`，然后打开 `http://127.0.0.1:4321/`。

测试覆盖文档导入、持久化、资源访问边界、CLI 与 API 协议、PDF 解析与部分前端回归。构建和测试通过不能替代真实文档与界面的人工检查，详见[验证记录](docs/verification.md)。

## 技术与结构

前端使用 React、TypeScript、Vite、Tailwind CSS、shadcn/ui（Base UI）和 Zustand。Electron 负责窗口、原生文件选择、应用更新与 Go 服务生命周期。Go 管理本地文档、SQLite、搜索和 AI 调用。PDF 版面解析由 Node 处理器通过 ONNX Runtime 在本机完成。

```text
apps/
├── desktop/       # Electron main / preload
├── web/           # React 界面、PDF.js 与 EPUB 阅读适配器
├── server/        # Go 本地服务
├── processor/     # PDF 版面解析与本地版面模型
└── connector/     # Reader Connector Chrome 扩展
packages/
├── ui/            # shadcn/ui + Base UI 组件
├── reader-core/   # Document、Location、TOC、Annotation、ReaderAdapter
└── api-client/    # OpenAPI 类型与 API 客户端
docs/              # 范围、路线图、接口与验证记录
website/           # 项目官网静态页面与 README 截图
assets/            # Logo 源文件与应用图标
```

业务模型围绕 `Document` 组织。PDF 用页码和坐标定位；EPUB 使用章节资源、段落 ID 和字符范围定位。阅读界面通过 `ReaderAdapter` 调用各自的引擎。项目使用 pnpm workspace，不依赖 Nx 或 Turborepo。

## 当前限制与后续计划

当前主要面向无 DRM、横排从左到右的可重排 EPUB 与含文本的 PDF。尚未支持 OCR、密码 PDF 输入、PDF 缩略图、后台 PDF 全文索引、跨文档 AI 检索、独立多会话管理、Ollama 和阅读统计。复杂跨页 PDF 选区暂不创建高亮。

固定版式 EPUB、竖排、RTL、复杂脚注和大文件仍需更多真实样本验证。桌面端已接入 macOS 文件打开事件，但尚未注册系统文件关联；安装包由 CI 构建，尚未提供受系统信任的开发者签名或 macOS 公证。应用内更新的条件见[发版与更新说明](docs/releasing.md)。

2026 年 10 月计划更新：

- **Reader 命令行工具**：在终端中检索、阅读和导入书库文档，供 Claude Code、Codex 等 Agent 和脚本使用。
- **RAG 支持**：AI 问答全面优化，基于检索为回答提供跨章节、跨文档的原文依据。
- **EPUB 大部头翻译优化**：改善大型图书的按章翻译速度、任务调度与续译体验。

更长期的计划见[路线图](docs/roadmap.md)。

## Star History

<a href="https://www.star-history.com/?repos=cynicalight%2Freader&amp;type=date&amp;legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=cynicalight/reader&amp;type=date&amp;legend=top-left&amp;theme=dark" />
    <img src="https://api.star-history.com/svg?repos=cynicalight/reader&amp;type=date&amp;legend=top-left" alt="Reader 的 GitHub Star 增长历史" />
  </picture>
</a>

## 致谢

感谢 [Readium](https://github.com/readium)、[PDF.js](https://github.com/mozilla/pdf.js)、[shadcn/ui](https://github.com/shadcn-ui/ui) 和 [Base UI](https://github.com/mui/base-ui)。shadcn 组件保留在 `packages/ui`，相关许可见 [packages/ui/LICENSE.md](packages/ui/LICENSE.md)。更多技术来源与归属见[第三方来源](docs/sources.md)。

[项目范围](docs/spec.md) · [路线图](docs/roadmap.md) · [OpenAPI](docs/openapi.yaml) · [验证记录](docs/verification.md)
