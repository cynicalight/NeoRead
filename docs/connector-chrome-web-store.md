# NeoRead Connector 商店更新资料（0.1.3）

依据 `apps/connector` 的 0.1.3 源码（`build.mjs`、`src/*`）、公开商店页、公开隐私页和 Chrome 官方文档整理。本文只覆盖已发布条目 `dfhdcomjdkaiajiibbkonbonjlnkdjlg` 的升级，不代替后台保存或提交，也不代替发布者对法律声明的确认。

## 0. 先看结论

| 项目 | 结论 |
| --- | --- |
| 必须做 | 在 **Package** 上传 0.1.3 ZIP；把 **Store listing → Description** 换成下文新文本；然后 **Submit for Review**。 |
| 权限、隐私字段 | 已对比 Google 官方更新服务返回的 0.1.2 CRX 与 0.1.3 ZIP：`permissions`、`host_permissions`、`optional_host_permissions` 三组一致。权限理由和已披露的数据类别可沿用。 |
| 新的审核关注点 | 公开页是 0.1.2，描述仍写 Reader 且隐私链接指向旧路径，必须更正。0.1.3 新增读取 `arxiv.org/abs/...` 的标题补全（见第 2 节），属已声明的可选主机权限范围。 |
| 账号级、需发布者自己决定 | Official URL、Verified CRX Uploads、Trader 声明、联系邮箱、发布时机、法律声明确认。 |

## 1. 0.1.3 上线前提

- 版本号必须大于已发布的 0.1.2；0.1.3 已在 `apps/connector/build.mjs` 中。
- 上传的 ZIP 必须由不带 `NEOREAD_CONNECTOR_DEV_KEY` 的正式构建生成，manifest 中不得含 `key`。
- 商店 ID 固定为 `dfhdcomjdkaiajiibbkonbonjlnkdjlg`；桌面端 `apps/server/internal/neoread/connector.go` 已接受该 ID。
- Chrome 要求上传包含全部文件（含未变化文件）的 ZIP。
- 提交审核不会影响已发布版本；如勾选自动发布，通过后才会推送给用户。想自己决定时机，提交对话框中取消“发布”勾选（审核通过后 30 天内手动发布，逾期回到草稿）。

**Verified CRX Uploads**：这是 Package 页的可选 opt-in 功能。只有发布者已 opt-in 时，更新才必须上传由发布者私钥签名的 CRX；未 opt-in 则直接上传 ZIP。是否 opt-in、私钥保管均属发布者决定，本文不假设已开启，请在后台 Package 页确认。

## 2. 0.1.3 变更与对商店字段的影响

0.1.2 → 0.1.3：

- 修复无可用查看器标题的 PDF 不能收录的问题，并纠正英文 PDF 标题中的全角冒号；
- 对 `arxiv.org/pdf/<编号>` 页面，标题缺失或仅为编号时，扩展向 `https://arxiv.org/abs/<编号>` 发一次不带凭据的请求，读取 `citation_title`，超时 4 秒，失败则退回 `arXiv:<编号>`；
- 论文含 DOI 时仍可能向 `api.crossref.org` 查询缺失书目信息，**知网页面不会向 Crossref 发送 DOI**（`prepare.ts` 对知网来源跳过此请求）。

字段影响：

| 字段 | 是否需要改 | 原因 |
| --- | --- | --- |
| 权限与理由 | 否 | manifest 权限无变化；arXiv 请求在已有的 `https://*/*` 可选主机权限内。 |
| Data usage 三类勾选 | 否 | arXiv 请求只含论文编号，不新增数据类别。 |
| 远程代码 | 否 | 仍为 **No, I am not using remote code.** |
| 隐私政策 | 非强制 | 政策已说明会向来源网站请求页面、PDF 和图片，并只向 Crossref 发送 DOI；arXiv 编号查询落在“来源网站请求”范围。若发布者希望显式写出，可自行改 Pages 文案，不属本次必改项。 |
| 描述 | **是** | 见下。 |

## 3. 当前公开页与应更新内容（据 2026-11-20 对公开页的核对）

公开页 <https://chromewebstore.google.com/detail/neoread-connector/dfhdcomjdkaiajiibbkonbonjlnkdjlg> 显示：

| 项目 | 公开页现状 | 处理 |
| --- | --- | --- |
| 版本 | 0.1.2（2026-10-29） | 上传 0.1.3 |
| Overview | 仍写 “Reader Connector”“Reader 论文库”“Reader 桌面应用”，隐私链接为旧的 `https://cynicalight.github.io/reader/privacy/`，且不含知网 | **替换为下方新描述** |
| 分类 | Tools（路径 `.../productivity/tools`） | 保留现有分类，不改 |
| 语言 | 中文（中国） | 保留 |
| Privacy 页链接 | `https://cynicalight.github.io/NeoRead/privacy/`（正确） | 保留 |
| 已披露数据 | Authentication information、Web history、Website content | 与下文第 5 节一致，保留 |
| 三项声明 | 三项均已显示 | 保留 |

后台是否另有字段与公开页不同，需发布者登录后台自行核对；本文未登录后台。

## 4. Store listing（需要更新）

### Description（整段替换，可直接粘贴）

> NeoRead Connector 将网页中的 PDF 论文收录到本机 NeoRead 论文库。打开论文页面或受支持的搜索结果，点击扩展，选择要收录的论文，并可添加分类和标签。扩展会尝试使用当前浏览器会话下载 PDF，提取标题、作者、摘要等论文信息，并保存可离线阅读的网页快照。没有取得 PDF 的页面不会创建条目。
>
> 使用前请安装并启动 NeoRead 桌面应用。首次收录时，Chrome 会请求网站访问权限，用于读取所选论文页面、PDF 和快照图片。导入内容发送到同一台设备上的 NeoRead；含 DOI 的论文可能向 Crossref 查询缺失的书目信息。具体数据处理方式见隐私政策：https://cynicalight.github.io/NeoRead/privacy/
>
> 目前支持通用论文元数据、知网部分新旧详情页和搜索结果，以及 arXiv、Google Scholar、PubMed 和 Semantic Scholar 的部分结果页面。知网需要用户自行完成登录或安全验证，并具备全文下载权限；仅有 CAJ 的文献暂不支持。网站限制、登录状态或跨站下载限制可能导致单篇收录失败。

### 其他 Store listing 字段（沿用）

| 字段 | 内容 | 状态 |
| --- | --- | --- |
| Category | 保留现有（公开页为 Tools） | 已有，沿用 |
| Language | 保留现有（中文（中国）） | 已有，沿用 |
| Store icon | `apps/connector/store/icon-128.png`（128×128） | 必填，已有则沿用 |
| Screenshot | `apps/connector/store/screenshot-1280x800.jpg`（1280×800，至少 1 张） | 必填，已有则沿用；若想展示知网，需另做，非必须 |
| Promo video、Small/Marquee tile | 留空 | 可选 |
| Homepage URL | `https://cynicalight.github.io/NeoRead/` | 可选，沿用 |
| Support URL | `https://github.com/cynicalight/NeoRead/issues` | 可选，沿用 |
| Official URL | 取决于是否已在 Search Console 验证站点 | 发布者决定，默认 None |
| Mature content | 关闭 | 沿用 |

**更新说明（可选，可放在描述末尾）**：0.1.3 修复部分 arXiv PDF 因页面标题为空而无法收录的问题。收录时会尝试补全论文标题，查不到时仍可用论文编号保存。英文 PDF 标题中的全角冒号会转为英文冒号。

## 5. Privacy practices（核对，一般无需修改）

| 字段 | 填写内容 / 处理 |
| --- | --- |
| Single purpose | 将用户选择的网页 PDF 论文及其书目信息收录到本机 NeoRead 论文库。 |
| activeTab | 用户打开扩展时，读取当前标签页的网址、标题和论文页面，以显示可选择的论文；不会持续读取其他标签页。 |
| scripting | 用户打开扩展时，在当前标签页运行随扩展打包的识别代码，提取论文元数据和候选 PDF 地址。 |
| declarativeNetRequestWithHostAccess | 用户主动收录知网论文时，临时为扩展自身发起的知网请求设置文章页 Referer，以读取详情或下载 PDF。规则限定到请求目标的 origin 和扩展自身发起的 XHR/fetch，不修改普通标签页请求；请求结束后移除规则，不读取或保存 Cookie。 |
| storage | 在 Chrome 本地存储由本机 NeoRead 生成的连接凭据，以便扩展重新打开时继续连接同一台设备上的 NeoRead。 |
| Host permission | `http://127.0.0.1/*`：与同一台设备上的 NeoRead 通信，实际请求固定发往 `127.0.0.1:17841`。首次收录时另行请求 HTTP/HTTPS 网站访问权限（可选主机权限），用于读取所选论文页面、PDF 和快照图片；论文页面、PDF、图片可能分布在不同网站（例如 arXiv、知网）。 |
| Remote code | **No, I am not using remote code.** Crossref 与论文网站只返回数据、页面和 PDF，不加载或执行远程脚本。 |
| Privacy policy URL | `https://cynicalight.github.io/NeoRead/privacy/` |

**Data usage（已有，沿用）**：勾选 Website content、Web history、Authentication information（后者对应由本机 NeoRead 生成、存于 `chrome.storage.local` 的连接凭据，不是网站密码或 Cookie 值）。其他类别不勾选。

**Certifications（三项声明）**：公开页显示已确认三项。是否继续确认由发布者本人决定；本文只说明代码侧事实：没有向开发者服务器上传内容、没有广告或信用评估用途；Crossref 只接收 DOI，arXiv 只接收论文编号；知网请求只在用户主动收录时发出。

公开隐私页已说明扩展向来源网站请求内容，不读取或保存 Cookie 值。后台未单独说明知网临时 Referer 规则时，可使用上表的权限理由。

## 6. 数据流（审核依据，与实现一致）

| 对象 | 发送内容 | 依据 |
| --- | --- | --- |
| 本机 NeoRead `127.0.0.1:17841` | 连接凭据、PDF、书目信息、快照、分类和标签 | `popup.tsx`、`worker.ts` |
| 论文来源网站（含 arXiv、知网等） | 页面、PDF、图片请求；可使用当前浏览器会话 | `prepare.ts`、`download.ts` |
| `arxiv.org/abs/<编号>` | 论文编号；不带凭据 | `prepare.ts`（0.1.3） |
| `api.crossref.org/works/<DOI>` | DOI；知网来源跳过 | `prepare.ts` |
| 知网 | 临时 `Referer`（文章页）；`credentials: include`；25 秒超时；不接受 HTTP 下载到 HTTPS 文章的混合场景 | `download.ts` |

## 7. Test instructions（可选，可沿用）

该标签页可选。扩展依赖本机桌面应用，建议保留以下可复现步骤；公开 arXiv 示例无需登录或提供账号。

> 1. 安装并启动最新版 NeoRead 桌面应用：https://github.com/cynicalight/NeoRead/releases/latest 。扩展仅连接同一台设备上运行的 NeoRead，无需 NeoRead 云账号。
> 2. 在 Chrome 打开 https://arxiv.org/abs/2501.01234 ，点击 NeoRead Connector 图标。扩展应显示论文候选项。
> 3. 点击“收录 1 篇到 NeoRead”，允许 Chrome 请求的网站访问权限。等待结果，再在 NeoRead 的论文库中确认 PDF、论文信息及网页快照。
> 4. 打开 https://arxiv.org/pdf/2602.03733 ，直接从 PDF 页面收录。若 arXiv 摘要页可用，书库中应显示 `RegionReasoner: Region-Grounded Multi-Round Visual Reasoning`；摘要页不可用时仍可按编号收录。
> 5. 若 NeoRead 未启动，扩展应显示连接失败提示。
> 6. 知网的全文下载取决于用户已有的访问权限；仅有 CAJ 的文献会提示不支持，不创建条目。

## 8. 提交流程（后台操作清单）

1. 登录 [Developer Dashboard](https://chrome.google.com/webstore/devconsole)，选择 NeoRead Connector。
2. **Package**：上传新包（若已 opt-in Verified CRX Uploads，则上传已签名 CRX，见第 1 节）。
3. **Store listing**：替换 Description，核对其余字段。
4. **Privacy practices**：核对权限理由、远程代码选项和数据勾选；有差异再改。
5. **Distribution**：保持原样（本次不涉及）。
6. **Test instructions**（可选）：粘贴第 7 节。
7. **Submit for Review**，在对话框中决定自动发布或延后发布。

## 9. 官方参考链接（2026-11-20 已读取）

- 更新条目：<https://developer.chrome.com/docs/webstore/update>
- 首次发布流程：<https://developer.chrome.com/docs/webstore/publish>
- Store listing 字段：<https://developer.chrome.com/docs/webstore/cws-dashboard-listing>
- Privacy practices 字段：<https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- Test instructions：<https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions>
- 审核流程：<https://developer.chrome.com/docs/webstore/review-process>
- User Data FAQ：<https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>
- Limited Use：<https://developer.chrome.com/docs/webstore/program-policies/limited-use>
- 公开商店页：<https://chromewebstore.google.com/detail/neoread-connector/dfhdcomjdkaiajiibbkonbonjlnkdjlg>
- 隐私政策：<https://cynicalight.github.io/NeoRead/privacy/>（已核对可访问，HTTP 200）

## 10. 提交前的人工验收

自动化测试不能代替带真实知网账号及机构权限的下载验收。

以下使用商店分配 ID 的安装版本验收；不要直接把未签名的商店 ZIP 解压加载来测试桌面连接，本机加载的 ID 不同。

1. 用 arXiv 摘要页和 PDF 直链各收录一篇，确认标题与 PDF 正确；网页快照仅在有可用网页内容时检查。
2. 用一份普通 PDF 收录一次。
3. 在已登录且有权限的知网详情页收录一次；仅 CAJ 文章应提示不支持。
4. 检查标签多选：至少选两个标签，取消其中一个后另一个仍选中。
5. 关闭或重新加载扩展后再次收录，临时请求规则不应残留。

本地测试需要固定 ID 时，用 `NEOREAD_CONNECTOR_DEV_KEY=1 pnpm --filter @neoread/connector build` 加载 `apps/connector/dist`；上传商店前必须重新执行不带该环境变量的正式构建。
