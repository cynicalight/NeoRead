# NeoRead Connector（Chrome 首版）

扩展位于 `apps/connector`。本地测试时，在仓库根目录运行 `NEOREAD_CONNECTOR_DEV_KEY=1 pnpm --filter @neoread/connector build`，然后打开 Chrome 的 `chrome://extensions`，开启开发者模式，点「加载已解压的扩展程序」并选择 `apps/connector/dist`。上传 Chrome 网上应用店时，不设置 `NEOREAD_CONNECTOR_DEV_KEY`，重新构建并把 `dist` 内的文件压缩到 ZIP 根目录；商店不接受带 `key` 的清单。扩展仅在点击工具栏按钮后读取当前标签页；第一次收录时，Chrome 会询问网站访问权限，用于读取所选论文页面、PDF 和快照图片。

启动 NeoRead 桌面版后，点击扩展即可自动连接。NeoRead 的连接入口固定监听 `127.0.0.1:17841`，只接受本扩展的固定 Chrome 来源。本地测试版 ID 为 `afojfnpkeokahhniipldpdpecaljdnbe`；如果此前加载过不含固定 ID 的开发版，请在 `chrome://extensions` 移除旧版，再加载用开发密钥构建的 `dist`。商店版 ID 为 `dfhdcomjdkaiajiibbkonbonjlnkdjlg`，NeoRead 同时接受这两个来源（`apps/server/internal/neoread/connector.go`）；商店 ID 变化时须同步更新并发布桌面版。插件自动取得本机访问凭据并保存在 Chrome 本地存储，NeoRead 只保存凭据哈希。若端口被占用，设置页会显示连接不可用。连接不向 Zotero 或 NeoRead 云端发送内容。

测试开发版插件连接时，先关闭已安装的 NeoRead，再以 `NEOREAD_DEV_CONNECTOR=1 pnpm desktop` 或 `NEOREAD_DEV_CONNECTOR=1 pnpm dev` 启动开发版。

点击扩展按钮后，单篇页面会显示一篇候选论文；识别出的搜索结果页可逐篇勾选。可填分类和用逗号分隔的标签。扩展尝试用当前浏览器会话下载 PDF，将 PDF、论文信息与静态网页快照送入 NeoRead。NeoRead 继续执行 PDF 内容哈希去重、50 MB 与 150 页上限；51–150 页会询问是否继续。只有取得 PDF 并完成导入后才保存快照。论文详情中的「查看网页快照」可以离线阅读正文、表格、链接和成功嵌入的图片。单张图片限 2 MB，整个快照限 10 MB；不能离线保存的图片会在逐篇结果中提示。快照没有站点脚本、表单或远端资源。

第一批识别规则覆盖通用 `citation_*`、Dublin Core、JSON-LD 元数据，并识别 arXiv、Google Scholar、PubMed、Semantic Scholar 的部分结果列表。有 DOI 时还会尝试从 Crossref 补全缺失的信息。规则依赖站点当前页面结构；登录态、反爬限制、订阅页面及跨站 PDF 下载可能导致单篇失败，扩展会逐篇显示结果。Chrome PDF 查看器无法注入页面脚本时仍可尝试收录，上传前会校验 PDF 文件签名。没有 PDF 的页面不会创建 NeoRead 条目。扩展暂不处理 Zotero 云端、机构代理、Google Docs 引用或书目格式文件自动导入。

从 PDF 标签页收录英文论文时，Connector 会将标题中的全角冒号 `：` 转为英文冒号 `:`。含中日韩文字的标题保留原标点，不修改已收录的条目。

网页标题是可选信息，不是判断 PDF 是否可收录的依据。arXiv PDF 查看器没有提供论文标题时，扩展在收录时从摘要页读取 `citation_title`；读取失败则使用 arXiv 编号继续收录，兼容要求非空标题的旧桌面版。新版桌面端收到缺失或不可用的标题时保留 PDF 导入流程生成的标题。

## ScienceDirect PDF（Connector 0.1.7）

从论文详情页点一次「收录」，插件在后台取本篇 PDF 并提交给 NeoRead，不打开新的 PDF 标签页，也不把等待当作成功。它先使用出版商的附件入口；如果入口是普通跳转页，只跟随指向本篇官方 PDF 的静态链接。不会代做网站验证。

出版商未返回文件时，插件使用论文 DOI 向 OpenAlex 查询公开存档。目前支持 KITopen：只有仓储记录指向相同的原始 DOI，且明确标为出版版时才下载。收录结果会注明附件的公开来源，题录与快照仍来自原文章。不会拿作者稿或预印本代替出版版；两条路径都取不到文件时，直接报告未收录。NeoRead 本身的大文件确认仍然适用。

直接打开 ScienceDirect 官方 PDF 标签页也可以点「收录」，不必回详情页。插件从文件路径识别论文编号，在原标签页等待或读取本篇 PDF；不会保存临时签名地址。没有详情页题录时以论文编号作为候选标题。

手动验收：用一篇 arXiv 论文检查自动连接、单篇收录、论文信息、PDF 阅读与离线快照；在 Google Scholar 或 arXiv 搜索结果中选择两篇，核对逐篇结果与去重；打开需要登录的 PDF 验证当前会话可用性及失败提示；重启 NeoRead 后确认自动恢复连接；关闭 NeoRead 后确认扩展不能继续写入。视觉检查需要在 Chrome 和 NeoRead 桌面版中手动完成。
