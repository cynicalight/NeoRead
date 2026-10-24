# Word / WPS 引用插件调研与设计

调研日期：2026-10-13。目标：为 Word 和 WPS 提供与 Zotero 文字处理器插件功能对齐的引用插件，引用数据来自 Reader 论文库。本文区分 Zotero 的事实（来自其文档与源码）和 Reader 的设计建议；尚未实现，也未做真实 Word/WPS 验证。

已确定的范围：

- 不兼容 Zotero 的域代码。Reader 使用自己的前缀，文档中的 Zotero 引注不识别、不转换。
- 同时支持 Microsoft Word（Windows、macOS 桌面版）和 WPS 文字。
- 支持全部 CSL 样式，分阶段交付。

## Zotero 插件的功能

以 Zotero 中文社区的使用说明为准，[使用说明][zc-word]、[常见问题][zc-faq]：

| 功能 | 行为 |
| --- | --- |
| 添加/编辑引注 | 光标处打开引注对话框。按标题、作者、年份搜索，或切换到文库模式按分类浏览；默认列出 Zotero 中选中或正在阅读的条目。同一处可依次加入多篇后一次插入。样式要求排序时自动排序，可关闭“保持自动排序”后拖动 |
| 自定义引注 | 每篇可设定位符（页、章节等，可直接输入 `p.34`、`34`）、前缀、后缀（支持 `<i>` `<b>` `<sub>` `<sup>`）、省略作者 |
| 添加/编辑参考文献表 | 在光标处插入；编辑窗口可加入未引用条目、移除条目；不建议在此改文字。段落格式由 Word 的“书目”样式控制 |
| 文档首选项 | 引用样式、语言；注释类样式选择脚注或尾注；自动更新引注；高级：存为域或书签、MEDLINE 期刊缩写 |
| 刷新 | 更新全文引注和参考文献表 |
| 取消链接引注 | 删除域代码，转成纯文本，不可撤销 |
| 添加笔记 | 插入 Zotero 笔记，使用较少 |
| 隐含行为 | 手动改过的引注询问是否保留（`dontUpdate`），保留后不再自动更新；条目不在文库中时用文档内嵌的元数据继续排版（孤立条目，不能编辑题录）；引注多时提示延迟更新；可导出文档后转到 LibreOffice/Google Docs |

## Zotero 的实现

**Word 端很薄。** 安装到 Word 启动目录的 `Zotero.dotm` 只提供功能区和宏，点按钮时把命令名（如 `addEditCitation`）交给 Zotero。Windows 用 SendMessage 发给 Zotero 进程，Zotero 再通过 js-ctypes 调用 C++ 库，以 OLE 自动化操作 Word。[Windows 集成][zt-win] macOS 的宏往 `.zoteroIntegrationPipe` 管道文件写命令，Zotero 通过 Objective-C 库以 ScriptingBridge 操作 Word。[macOS 集成][zt-mac]

**逻辑全在 Zotero。** `integration.js` 定义与文字处理器无关的接口，各平台实现同一组方法。[集成源码][zt-integration]

- Document：`getFields`、`insertField`、`canInsertField`、`cursorInField`、`getDocumentData`、`setDocumentData`、`setBibliographyStyle`、`convert`、`cleanup`、`complete`、`activate`、`displayAlert`
- Field：`getCode`、`setCode`、`getText`、`setText`、`getNoteIndex`、`select`、`delete`、`removeCode`、`equals`、`isAdjacentToNextField`

**HTTP 版本的同一协议。** Google Docs 和第三方 WPS 插件使用 `POST /connector/document/execCommand` 发起命令，Zotero 的响应是下一项要执行的操作（例如 `Application.getDocument`）；客户端执行后把结果 `POST /connector/document/respond`，再取得下一项，直到 `Document.complete`。同一时刻只允许一个事务，否则返回 503。[HTTP 端点源码][zt-http]

**文档中保存的数据。**

- 引注域：`ADDIN ZOTERO_ITEM CSL_CITATION {json}`。JSON 遵循 [csl-citation schema][csl-citation]：`citationID`、`properties`（`formattedCitation`、`plainCitation`、`noteIndex`、`dontUpdate`）、`citationItems`（`id`、`uris`、完整 CSL-JSON `itemData`、`locator`、`label`、`prefix`、`suffix`、`suppress-author`）。
- 参考文献表域：`ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY`。
- 文档首选项：文档自定义属性 `ZOTERO_PREF_n`，内容为 XML（`data-version` 3）或 JSON（`dataVersion` 4），记录样式 ID、locale、`hasBibliography`，以及 `fieldType`、`noteType`、`automaticJournalAbbreviations`、`delayCitationUpdates` 等偏好。

**排版引擎**是 citeproc-js 的文档会话：按全文引注顺序计算编号、同名区分、“同上”、注释序号，因此每次刷新都要读取全部引注。

**WPS 的做法。** Zotero 官方不支持 WPS。社区的 WPS-Zotero 是 WPS 文字 JS 加载项，经 Zotero 的 HTTP 协议工作，域格式与 Word 相同；因 Zotero 的端点不提供 CORS，需要额外运行 Python 代理。加载项通过 `jsaddons` 目录中的 `publish.xml`、`jsplugins.xml` 注册，入口地址为 `http://127.0.0.1:3889/`，Windows 目录 `%APPDATA%\kingsoft\wps\jsaddons`，Linux `~/.local/share/Kingsoft/wps/jsaddons`。[WPS-Zotero][wps-zotero] [安装脚本][wps-zotero-install] 另一条路线是把 `Zotero.dotm` 放进 WPS 启动目录走 VBA，但需要付费版 WPS 的 VBA 环境。[WPS 说明][zc-wps]

## Reader 的设计

### 结构

```
Word (Reader.dotm 宏)  ─┐
                        ├─ HTTP 127.0.0.1:17841 /v1/cite/* ─ Go 服务（鉴权、事务队列）
WPS (JS 加载项)        ─┘                                       │ SSE
                                                                 ▼
                                    Reader 窗口：引用会话（citeproc-js）+ 引注对话框
```

沿用 Zotero 的分工：客户端只执行文档操作，排版和交互都在 Reader。

1. **客户端。** Word 端是 `Reader.dotm`（功能区 + VBA），Windows 与 macOS 共用同一份 VBA，自己实现 Document/Field 操作，不需要原生库。WPS 端是 JS 加载项，用 WPS 的 JS API 实现同一组操作。两端只是同一协议的两个执行器。
2. **传输。** Windows VBA 用 `MSXML2.XMLHTTP` 直连。macOS Word 在沙盒内，VBA 通过 `AppleScriptTask` 调用 `~/Library/Application Scripts/com.microsoft.Word/` 下的脚本发请求。WPS 加载项由 Reader 在同一端口直接提供（`/wps/`），页面与 API 同源，不需要代理和 CORS。
3. **Go 服务**复用连接器端口 17841，新增 `/v1/cite/execCommand`、`/v1/cite/respond`。它只做鉴权、单事务控制和消息转发；通过新增的 SSE 通道把命令推给 Reader 窗口，再把窗口给出的下一项操作作为 HTTP 响应返回客户端。
4. **引用会话在 Reader 窗口内。** 窗口里已有 citation-js、论文库数据和 shadcn 组件，对话框与 citeproc-js 放在一起，不需要在 Go 或 Electron 主进程里再嵌入一个 JS 引擎。命令到达时窗口置前，完成后把焦点还给 Word/WPS。代价是 Reader 必须在运行；未运行时客户端提示启动 Reader。

### 协议

与 Zotero 的 HTTP 协议同构，便于对照，但字段名和端点是 Reader 自己的：

```
POST /v1/cite/execCommand {command, documentId, client} → {op: "Document.getState", transaction}
POST /v1/cite/respond     {transaction, result | error} → {op: ...} … → {op: "Document.complete"}
POST /v1/cite/next        {transaction}                 → 收到 Document.wait 后继续等待
```

- 命令（M1）：`addEditCitation`、`addEditBibliography`、`setDocPrefs`、`refresh`、`removeCodes`。
- 操作（M1）：`Document.getState`（全部 Reader 域的代码、文字、注释序号，光标所在域，光标前的域数，文档数据，能否插入）、`Document.insertField`、`Document.updateFields`（批量）、`Document.removeFields`、`Document.setData`。粒度比 Zotero 粗，减少 VBA/AppleScript 的往返次数。实现见 `apps/web/src/cite/protocol.ts`。
- Reader 窗口一侧：`GET /api/cite/events`（SSE）收到命令，`POST /api/cite/transactions/{id}/call` 发出一项操作并等待结果，`…/complete` 结束。
- 文本写入不传 RTF/HTML，传格式片段 `[{text, i, b, sup, sub, sc}]`，由宏或 JS 逐段设置字体。Word 宏插入富文本在两个平台上行为不一致，片段方式更可控。
- Word 的 VBA 没有 JSON 解析（macOS 上也没有 Dictionary），发给 Word 的操作另附一份按行、制表符分隔的编码（`vba` 字段，`apps/web/src/cite/vba.ts`）；WPS 端直接读 JSON。VBA 回复时自己拼 JSON。
- 对话框可能开很久，而 Windows 的 XMLHTTP、macOS 的 curl 都有超时，所以请求不长时间挂起：20 秒内没有下一项操作时返回 `Document.wait`，客户端再请求 `/v1/cite/next`。Windows 上等待期间执行 `DoEvents`，Word 仍可响应；macOS 的 `AppleScriptTask` 是同步的，Word 会等待。Reader 窗口关闭或客户端断开时结束事务。
- 一个事务进行中时，新的 `execCommand` 返回 409 并把对话框置前。

### 文档数据

- 引注域：`ADDIN READER_CITATION {json}`。JSON 结构沿用 csl-citation schema，`uris` 为 `reader://paper/<文档ID>`，另存 DOI、arXiv 编号用于匹配，始终内嵌完整 `itemData`。
- 参考文献表域：`ADDIN READER_BIBLIOGRAPHY {"uncited":[],"omitted":[]}`。
- 文档首选项：自定义属性 `READER_PREF_1…n`，单个属性值有长度上限，按块切分；JSON，带 `dataVersion`。
- 条目解析顺序：文档 ID → DOI → 内嵌 `itemData`（孤立条目，只能排版，不能编辑题录）。合并重复论文后的映射尚未接入。
- 生成 `itemData` 时补 `language`：用户未设置时按标题与作者是否含汉字推断 `zh-CN` / `en-US`。双语 GB/T 7714 样式依赖它选择“等”或“et al.”。
- 手动修改检测：记录 `plainCitation`，刷新时发现文本不同则询问是否保留，保留后写入 `dontUpdate`。
- 只使用域，不提供书签模式。书签模式在 Zotero 中只为 LibreOffice 协作存在，不在本次范围内。

### 样式

引擎直接使用 citeproc-js 的会话 API（`CSL.Engine`、`processCitationCluster`、`rebuildProcessorState`、`makeBibliography`），而不是 citation-js 的一次性格式化。citation-js 当前依赖的就是 citeproc-js，许可证上没有新增依赖。zotero-chinese 的样式使用 CSL-M 扩展，只有 citeproc-js 支持，这是不能换引擎的硬约束。[zotero-chinese 样式][zc-styles]

分阶段：

1. **S1 正文引注样式（已完成）。** GB/T 7714—2015、—2025 的顺序编码制、著者-出版年制和注释（zotero-chinese 双语版），APA 7、IEEE、Chicago 著者-日期与注释、MLA、Harvard、Vancouver（NLM 的 `nlm-citation-sequence`）、Nature；locale 为 zh-CN、zh-TW、en-US、en-GB。官方仓库的 GB/T 7714 样式不按条目语言切换“等/et al.”，在 Word 中整篇排版时英文条目也会变成“等”，所以改用双语版。
2. **S2 注释样式。** GB/T 7714 注释版、Chicago 注释版；脚注/尾注由客户端创建，`getNoteIndex` 返回注释序号；支持“同上”。
3. **S3 自定义样式。** 导入 `.csl` 文件，包括依赖样式（`independent-parent` 指向已安装或可下载的父样式）和 zotero-chinese 的 CSL-M 样式。导入时用 citeproc-js 试排一条示例，失败则拒绝。
4. **S4 全量样式库。** 随应用附带官方 CSL 样式库的索引（标题、ID、领域、格式），选中时下载并缓存样式文件；联网只在用户选择样式时发生，遵守现有的公开地址限制。附带样式继续离线可用。
5. **期刊缩写。** `container-title-short` 优先；MEDLINE 缩写表作为可选数据，单独评估体积与许可。

样式与 locale 文件均为 CC BY-SA 3.0，沿用 `apps/web/src/papers/csl/README.md` 的署名方式。

### 功能分期

| 阶段 | 内容 |
| --- | --- |
| M1 | 协议、鉴权、Go 事务队列、SSE；Word Windows/macOS 的 `Reader.dotm` 与安装；添加/编辑引注（搜索论文库、多篇、定位符/前后缀/省略作者、排序）；参考文献表插入与自动更新；文档首选项（样式、语言、自动更新）；刷新；取消链接；S1 样式 |
| M2 | WPS JS 加载项（Windows、Linux；macOS 先验证 WPS 是否支持 JS 加载项）；手动修改检测；孤立条目；延迟更新 |
| M3 | 注释样式与脚注/尾注（S2）；参考文献表编辑（`uncited`、`omitted`）；按分类浏览模式；快捷键；S3 |
| M4 | 添加笔记：插入论文笔记或批注原文并附引注；S4 全量样式库；期刊缩写 |

### 安装与安全

- 设置页提供“安装 Word 插件”“安装 WPS 插件”，安装、卸载、升级由 Reader 完成，并检测 Word/WPS 是否正在运行。
- 位置：Word Windows `%APPDATA%\Microsoft\Word\STARTUP`；Word macOS `~/Library/Group Containers/UBF8T346G9.Office/User Content/Startup/Word/`，另放 AppleScript 到 `~/Library/Application Scripts/com.microsoft.Word/`；WPS 写入 `jsaddons` 的注册 XML，入口为 `http://127.0.0.1:17841/wps/`。
- 鉴权：VBA 请求不带 Origin，不能沿用扩展的来源校验。占用 17841 端口的 Reader 进程每次启动生成新凭据，写入固定位置 `<用户配置目录>/Reader/cite-credential`（0600），Word 端每次请求时读取（Windows 由 VBA 读，macOS 由 AppleScript 读）。开发版和正式版共用这个位置，因为只有占用端口的进程会写。WPS 安装程序将用户专属随机密钥保存到 `Reader/cite-wps-key` 和该用户的登记文件。服务端校验 `/wps/<安装密钥>/` 路径中的密钥才提供资源；页面通过认证的 `POST /v1/cite/bootstrap` 获取当前运行令牌，不再把令牌写入 HTML。密钥文件和登记文件在 Unix 上限制为 0600，Windows 依赖当前用户 AppData 的 ACL；资源禁止缓存并设置 `Referrer-Policy: no-referrer`，日志只记录路由模板；`/v1/cite/*` 只额外接受 `http://127.0.0.1:17841` 同源请求。
- 文档内容（引注文本、域代码）只在本机传递，不联网。
- 不复制 Zotero（AGPL）和 WPS-Zotero（GPL-3.0）的代码，只参考公开协议与文档格式独立实现。

## 待验证

原型阶段需要在真实环境中确认：

1. macOS Word 中 `AppleScriptTask` 的调用延迟，以及长时间挂起的请求是否会被 Word 中断。
2. VBA 遍历大量域（≥500 处引注）的耗时，决定是否需要增量刷新。
3. WPS JS API 对域代码、脚注、文档自定义属性的支持程度，以及 macOS 版 WPS 是否支持 JS 加载项。
4. 同一份文档在 Word 与 WPS 之间来回编辑后，域代码与自定义属性是否保留。
5. Word 启动目录模板在受控企业环境中被宏策略禁用时的提示方式。

## 来源

[zc-word]: https://zotero-chinese.com/user-guide/ms-word-plugin
[zc-faq]: https://zotero-chinese.com/user-guide/faqs/word-addon
[zc-wps]: https://zotero-chinese.com/user-guide/wps-plugin
[zc-styles]: https://github.com/zotero-chinese/styles
[zt-win]: https://github.com/zotero/zotero-word-for-windows-integration
[zt-mac]: https://github.com/zotero/zotero-word-for-mac-integration
[zt-integration]: https://github.com/zotero/zotero/blob/main/chrome/content/zotero/xpcom/integration.js
[zt-http]: https://github.com/zotero/zotero/blob/main/chrome/content/zotero/xpcom/server/server_connectorIntegration.js
[csl-citation]: https://github.com/citation-style-language/schema/blob/master/schemas/input/csl-citation.json
[wps-zotero]: https://github.com/tankwyn/WPS-Zotero
[wps-zotero-install]: https://github.com/tankwyn/WPS-Zotero/blob/main/install.py

- [Zotero 中文社区：在 Word 中插入参考文献][zc-word]、[Word 常见问题][zc-faq]、[在 WPS 中使用][zc-wps]
- [Zotero Word for Windows 集成][zt-win]、[Zotero Word for Mac 集成][zt-mac]
- [Zotero integration.js][zt-integration]、[HTTP 集成端点][zt-http]、[csl-citation schema][csl-citation]
- [WPS-Zotero][wps-zotero]、[安装脚本][wps-zotero-install]、[zotero-chinese 样式][zc-styles]
