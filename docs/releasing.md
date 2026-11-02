# 安装包构建与发版

NeoRead 使用 GitHub Actions 和 electron-builder，发布 GitHub Release 后自动生成以下文件，并上传到 GitHub Release 和 Cloudflare R2：

| 文件                              | 运行平台                |
| --------------------------------- | ----------------------- |
| `NeoRead-<version>-mac-arm64.dmg` | Apple Silicon Mac       |
| `NeoRead-<version>-mac-arm64.zip` | Mac 应用内原地更新包    |
| `NeoRead-<version>-win-x64.exe`   | Windows x64（NSIS）     |
| `SHA256SUMS.txt`                  | 安装包的 SHA-256 校验值 |

当前工作流不构建 Intel Mac、Windows ARM64 或 Linux 安装包。Intel Mac 暂停构建：`onnxruntime-node` 自 1.24 起不再提供 darwin/x64 原生库，包内检查无法加载版面模型。`builder.config.cjs` 与更新检查仍保留 `mac-intel-x64` 命名，恢复时在 `.github/workflows/build.yml`（`macos-15-intel` runner）和 `scripts/release-assets.mjs` 中加回该目标即可。

当前没有 Apple 开发者证书。macOS 正式版使用仓库固定的自签名证书签名（见下文“macOS 签名证书”），不做 Apple 公证；Gatekeeper 不信任该证书，表现与 ad-hoc 签名相同。Windows 安装包没有 Authenticode 签名。系统可能阻止首次打开。macOS 可在确认下载来源后，在“系统设置 → 隐私与安全性”中允许该应用；Windows SmartScreen 可选择“更多信息 → 仍要运行”。组织设备策略可能禁止绕过。无需关闭系统整体安全保护。校验值用于检查文件完整性，不能替代开发者身份签名。

## macOS 签名证书

Squirrel.Mac 只安装与当前应用出自同一证书的更新。所有正式版必须使用同一张自签名证书；丢失或更换证书后，已安装的版本无法原地更新，只能手动下载 DMG 一次。

首次启用时在本机执行一次，输出目录必须不存在：

```sh
scripts/create-mac-sign-cert.sh ~/neoread-mac-sign
gh secret set NEOREAD_MAC_SIGN_P12 < ~/neoread-mac-sign/neoread-sign.p12.base64
gh secret set NEOREAD_MAC_SIGN_P12_PASSWORD < ~/neoread-mac-sign/password.txt
```

把 `neoread-sign.p12` 和 `password.txt` 离线备份后，可删除本机副本。证书有效期 20 年，CN 为 `NeoRead Self-Signed`。

`apps/desktop/mac-sign.cjs` 是 electron-builder 的 `mac.sign` 钩子：electron-builder 照常生成签名参数，钩子把证书导入临时钥匙串，替换签名身份后逐个签名嵌套二进制，结束后删除临时钥匙串，不修改登录钥匙串或信任设置。证书无人验证时间戳，签名不请求 Apple 时间戳服务。没有证书时退回 ad-hoc 签名，适用于本地构建和手动试跑；带 Release tag 的构建缺少证书会直接失败，包内检查也会确认签名者为 `NeoRead Self-Signed`。证书只传给 macOS 构建任务。

## 发版步骤

1. 在独立 worktree/分支完成修改，将根目录 `package.json` 和 `apps/desktop/package.json` 的版本同步，例如都改为 `0.2.0`。提交后 merge 到 `main`。
2. 推送 `main`，手动运行 **CI**（`gh workflow run ci.yml --ref main`），等待该提交的 Linux 和 Windows 检查全部通过。直接推送 `main` 不会自动触发 CI。首次启用时，可从 Actions 手动运行 **Release installers** 并留空 `release-tag`；它只保存安装包与校验值为 Actions artifacts，不创建或修改 Release。
3. 在所需提交上创建 tag，例如 `v0.2.0`，并发布该 tag 对应的 GitHub Release。Release 所在提交必须包含本工作流。预发布版本可用 `0.2.0-beta.1` / `v0.2.0-beta.1`。
4. **Release installers** 将 tag 解析为固定提交，核对版本、更新说明和 R2 必需配置，分别在原生 macOS ARM64 和 Windows x64 runner 上构建。同一源提交已有符合条件的成功 CI 会直接复用；没有成功记录时，先调用与日常 CI 相同的检查流程。检查通过后才构建安装包，所有平台都成功后统一上传安装包与校验值到同一个 Release，再上传 R2 并验证公开下载内容。验证通过后，将 R2 下载链接写入 Release 正文和 Actions 摘要。
5. 下载并做安装后的人工检查：打开应用，导入 EPUB/PDF，确认阅读、笔记保存及重新打开后恢复；退出后检查服务已停止。AI 功能另用已安装并登录的 CLI 检查。

触发事件为 `release: published`，适用于正式版和预发布版。保存草稿、单独推送 tag 或修改 Release 描述不会触发。Release 页面会先发布，安装包稍后上传；任一构建失败时上传任务不会运行。GitHub 资产上传不是事务操作，上传过程中网络失败可能留下部分文件；修复后重新运行工作流会覆盖同名资产。不要移动已发布的 tag；代码修复请发布新版本。

只发布 macOS 测试版时，在创建 Release 的描述中加入 `<!-- neoread:mac-only -->`。工作流只运行 macOS 构建，并要求 Release 恰好包含 Apple Silicon 的 DMG、原地更新 ZIP 和校验值；Windows 用户不会收到这个版本的安装包。

工作流使用仓库自动提供的 `GITHUB_TOKEN`、上述两个 macOS 签名 secrets 和下述两个 R2 secrets，无需 PAT。构建任务只有 `contents: read`，上传任务才有 `contents: write`。若以后由另一个工作流创建 Release，需要注意：默认 `GITHUB_TOKEN` 产生的事件通常不会触发新的工作流；应改为显式调用构建工作流，或调整发布入口。

## Cloudflare R2 下载发布

当前配置使用 `neoread` 桶和公开域名 `https://neoread-dl.chatbox.run`。域名通过桶的 Custom Domains 提供文件访问，无需 Worker。`electron-builder` 保持 `--publish never`；集中发布任务使用 Ubuntu runner 提供的 AWS CLI，通过 R2 的 S3 兼容接口上传已经校验的产物。

`neoread-dl-test.chatbox.run` 也绑定到同一个桶，仅是另一个访问域名，并非独立测试存储。需要切换验证域名时可覆盖 `R2_PUBLIC_BASE_URL`；这不会隔离上传内容。桶从 `neoreader` 迁移到 `neoread` 后，CI 令牌必须明确拥有新桶权限，旧桶的成功测试不能代替新桶验证。

### GitHub 配置

在仓库 **Settings → Secrets and variables → Actions → Secrets** 添加：

| Secret                 | 内容                             |
| ---------------------- | -------------------------------- |
| `R2_ACCESS_KEY_ID`     | R2 S3 凭据中的 Access Key ID     |
| `R2_SECRET_ACCESS_KEY` | 与该 ID 配对的 Secret Access Key |

令牌需要目标桶的 **Object Read & Write** 权限。无需提供 Cloudflare API Token、Global API Key、管理桶或列出全部桶的权限。不要将密钥写入源码、工作流、提交或日志。R2 凭据只在发布配置预检和上传步骤注入；未指定 `release-tag` 的手动试跑无需凭据。

以下是非敏感配置，工作流已有默认值，可在 **Variables** 中覆盖：

| Variable             | 默认值                                                              |
| -------------------- | ------------------------------------------------------------------- |
| `R2_BUCKET`          | `neoread`                                                           |
| `R2_ENDPOINT_URL`    | `https://208624959c9d215edea0720162a740c1.r2.cloudflarestorage.com` |
| `R2_PUBLIC_BASE_URL` | `https://neoread-dl.chatbox.run`                                    |

两个 URL 都只填 HTTPS origin，不包含对象路径。更换桶或域名时，先在 Cloudflare 完成桶创建、授权和 Custom Domains 绑定，再修改 Variables。上传 endpoint 与公开下载域名用途不同，不能互换。首次启用前，确认域名状态为 Active，并允许普通下载客户端请求。

### 对象路径与固定入口

以 `v0.9.4` 为例，版本文件位于：

```text
neoread/releases/v0.9.4/NeoRead-0.9.4-mac-arm64.dmg
neoread/releases/v0.9.4/NeoRead-0.9.4-mac-arm64.zip
neoread/releases/v0.9.4/NeoRead-0.9.4-win-x64.exe
neoread/releases/v0.9.4/SHA256SUMS.txt
```

公开 URL 是 `R2_PUBLIC_BASE_URL + / + 对象 Key`，不包含桶名。Release 正文只列带版本的链接，使历史版本的说明始终指向该版本。工作流只替换 `<!-- neoread:r2-downloads:start -->` 与 `<!-- neoread:r2-downloads:end -->` 之间的区块，保留人工说明及 `mac-only` 标记；重复运行不会追加重复区块。

如果本次版本没有预发布后缀、GitHub Release 未标记 prerelease，且仍是 GitHub `/releases/latest` 返回的版本，则在全部版本文件验证成功后更新固定入口：

| 平台              | 固定下载地址                                         | 下载保存的文件名                  |
| ----------------- | ---------------------------------------------------- | --------------------------------- |
| Apple Silicon Mac | `https://neoread-dl.chatbox.run/neoread/install/mac` | `NeoRead-<version>-mac-arm64.dmg` |
| Windows x64       | `https://neoread-dl.chatbox.run/neoread/install/win` | `NeoRead-<version>-win-x64.exe`   |

固定入口是安装包对象的另一份副本，通过 `Content-Disposition: attachment` 设置正确的下载文件名。Mac ZIP 保留在版本目录。预发布和旧版本重跑不更新正式入口；mac-only 只更新 Mac 入口，保留已有 Windows 入口。发布任务跨 tag 串行，防止并发写入共享入口。GitHub 自身可能替换同一 concurrency group 中尚未开始的 pending job；被取消的发布可重新运行。

上传的对象均使用 `Cache-Control: no-cache`，兼容工作流重跑覆盖同名对象。域名若有缓存规则，不应忽略该设置或强制长期缓存固定入口；否则新版本验证可能持续读到旧内容而失败。

### 验证与失败恢复

每次上传后，通过公开域名流式下载文件并比较大小、SHA-256 和下载文件名，只有通过校验才继续下一个文件。请求使用 `NeoRead/<version> release-ci` User-Agent，拒绝重定向，单次下载最多 10 分钟；验证失败最多尝试 3 次，间隔 2、4 秒。AWS CLI 使用 standard 重试、最多 3 次尝试。版本校验清单最后上传，之后才更新固定入口；Release 链接区块在全部步骤成功后写入。Actions 日志包含上传、验证重试及最终成功/失败阶段，不输出凭据或远端错误正文。

两个发布目的地和多个对象之间没有事务：GitHub 已上传而 R2 失败时，GitHub 资产仍可用；R2 失败也可能留下部分版本文件，或已更新一个平台入口。修复配置/网络后重新运行原工作流会覆盖对应版本对象并继续校验，不删除历史版本或桶内其他文件。不要移动已发布 tag。固定入口只代表对应平台最后成功发布的内容；校验下载时应使用同一版本目录中的文件与 `SHA256SUMS.txt`。

手动运行 **Release installers** 并留空 `release-tag` 时仍不上传 GitHub/R2、不修改固定入口或 Release 正文，只在 Actions 摘要生成标明“未上传”的版本链接预览。发布前配置检查只检查格式和凭据是否存在，不证明云端权限；第一次真实发布仍需验证上传。

应用内更新仍通过 GitHub 获取版本、校验清单与安装包；本流程新增的 R2 链接用于公开分发，不会自动更改客户端更新源。App 内更新说明继续来自 `docs/release-notes.json`。

首次真实发布后人工检查：打开 Actions 摘要中的 Mac/Windows 固定链接，确认保存的文件名、版本及 SHA-256 与该版本清单一致；检查 Release 原有中文说明仍在、R2 下载区块只有一个。真实安装仍按本文的安装验收步骤进行。

依据：[Cloudflare R2 AWS CLI](https://developers.cloudflare.com/r2/examples/aws/aws-cli/)、[R2 凭据权限](https://developers.cloudflare.com/r2/api/tokens/)、[R2 自定义域名](https://developers.cloudflare.com/r2/buckets/public-buckets/)。

### 恢复已有 Release 的构建

若已发布 tag 的应用源码无需修改，只需修复构建环境，可先将工作流修复合并到 `main`，再执行 `gh workflow run release.yml --ref main -f release-tag=v0.9.5`（替换为实际标签）。工作流使用 `main` 的构建配置，检出指定 tag 的固定提交，验证版本及已发布 Release，复用该源提交的 CI，并在全部平台通过后上传附件。恢复入口构建 macOS ARM64 和 Windows x64 两个平台，并执行 R2 上传与下载验证，需要相同的 R2 Secrets。R2 发布工具从工作流的固定提交加载，因此也可恢复尚未包含 R2 脚本的旧 tag；应用源码始终来自指定 tag。不要移动已发布的 tag；应用源码需要修改时应发布新版本。

CI 为 Node 构建进程设置 4096 MiB 堆上限，避免 macOS runner 在 Vite 渲染资源块时触及默认约 2 GiB 的堆上限。该设置只属于构建环境。

## 本地构建

在目标平台、目标架构上安装 Go（版本见 `apps/server/go.mod`）、Node.js 22 和 pnpm 10.30.3，然后执行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm package:dir  # 构建未封装应用，并检查包内运行时
pnpm package      # 构建 DMG 或 NSIS 安装包，并执行相同检查
```

产物在根目录 `release/`。脚本不上传任何文件。暂不支持交叉打包、Linux 安装包或 Windows ARM64。安装包目前使用默认 Electron 图标。

安装包包含 Electron、Go 服务、Web 资源、PDF 处理器的生产依赖及约 67 MB 的 PP-DocLayoutV3 FP16 版面权重。终端用户无需安装 Node.js、Go、Python 或 PaddlePaddle；首次版面解析即可离线运行。Codex、Claude Code、Kimi Code 仍需用户自行安装及登录，AI 翻译仍需要可用连接。

`pnpm package` 会先执行完整 `pnpm build`。PDF 处理器使用 workspace 锁文件部署为独立依赖目录，再裁剪其他平台的 ONNX 二进制；所有原生依赖必须来自当前 runner。临时 staging 和产物被 Git 忽略。

处理器构建先按 `apps/processor/model.json` 的固定 revision 获取权重，并核对 67,372,587 字节的大小和 SHA256。通过校验后才将临时文件发布到 `apps/processor/models/` 构建缓存；网络中断、大小或哈希不符会清理临时文件并停止构建；进程被强制终止时可能留下 `.part` 文件，但不会作为模型使用。已有缓存每次校验，损坏时需删除该缓存文件后重建；不静默覆盖。构建将当前模型和 `model-license/` 下的许可、来源说明复制到 `dist/models/`，打包时放入应用资源的 `processor/models/`，不放进 `app.asar`。权重、构建缓存和安装包均不进入 Git，Git 只管理模型规格、脚本与许可说明。

构建机器首次需要联网，之后可复用已校验的缓存。GitHub Actions 按模型规格文件的哈希缓存权重。完全离线构建时，将环境变量 `NEOREAD_BUILD_LAYOUT_MODEL` 设为已有权重的绝对路径；该文件必须与固定模型的大小和 SHA256 一致，校验失败不会回退下载。`pnpm dev`、`pnpm desktop` 和单独的处理器构建使用同一流程；`pnpm install`、类型检查和普通单元测试不获取权重。

运行时从处理器旁的 `models/` 读取模型并核对完整性，不联网获取，也不在每个书库复制权重。缺失或损坏时解析失败，需要重新构建或安装应用。旧版书库里的模型缓存保留，但不再使用或自动删除。

## 代理设置与连接检测

macOS 和 Windows 桌面版在“设置 → 诊断”提供三种模式，默认“跟随系统”：

- **跟随系统**：启动时读取系统代理，传给 Go 服务和 Agent CLI。
- **手动 HTTP 代理**：填写主机地址与端口，例如 `127.0.0.1` 和 `7890`；使用 Clash 的 HTTP 或 Mixed 端口，不能填写纯 SOCKS 端口。支持 IPv4、IPv6 和主机名，不支持账号密码。
- **直连**：清除 NeoRead 子进程继承的显式代理环境；系统 TUN、VPN 或透明路由仍由操作系统管理。

点击“保存代理设置”后，配置原子写入用户数据目录的 `proxy-settings.json`，与书库分开保存，不修改操作系统设置。重启后 Go 服务、Agent CLI 和 Electron 应用内更新使用新配置，本机 loopback 请求始终绕过手动代理。点击“重启 NeoRead”会先照常保存阅读数据；保存失败并选择“返回阅读”会取消这次重启。保存本身不触发退出或重启。重新打开设置会等待正在进行的保存完成，显示最新配置。

“连接检测”固定访问 `https://chatgpt.com/robots.txt`。使用同域名的公开文本资源可减少首页浏览器验证对检测的干扰；它只验证网络可达性，不代表登录或模型调用可用。跟随系统模式检测当前 Go / CLI 已生效的启动配置，切换系统代理后可直接点击重启再检测；手动及直连配置可先检测草稿，再保存并重启。检测不影响正在进行的 API 或 CLI 请求。独立的包内 Go 进程使用与 API 请求相同的环境代理规则，发出不带 API Key 或登录信息的 HEAD 请求；不跟随重定向、不读取正文、不打开书库。网络请求最多 12 秒，检测子进程有 15 秒上限；系统代理读取另有超时，Windows 不显示控制台，退出 NeoRead 时取消检测。

系统模式始终提供重启入口，运行中的请求与检测使用同一份启动配置。结果显示显式代理或直连路由、HTTP 状态及耗时；收到 401、403、405 或服务器错误说明已收到 HTTP 响应，不代表 ChatGPT 登录或模型调用可用。无法连接、证书验证失败、超时和代理 407 认证要求显示为失败，同时保留实际路由及耗时；检测进程未能返回结果时显示路由未知。检测仅证明 ChatGPT 公开资源的网络情况，不替代 Agent / API 的实际调用检测。

桌面应用启动时尝试将手动系统代理转换为 Go 服务和 CLI 子进程的代理环境。Windows 支持 Clash 默认绕过列表中的 IPv4 前缀通配符，例如 `127.*`、`192.168.*`、`10.*` 和 `172.16.*` 至 `172.31.*`，分别生成 CIDR 和 IP 范围写法供 Go、Node HTTP 使用；`*.local` 保留域名后缀绕过。`<local>` 加入 localhost、本机名称及其短名称；环境变量无法完整表达“任意不含点的内网主机名”，这部分仍取决于客户端运行时或额外列出的主机名。

代理读取失败、输出无效，或遇到无法转换的 PAC 时，应用保留原来的启动环境并继续启动，仅输出不含原始配置的控制台提示，不弹出启动错误窗口。Windows 在没有可用手动代理但 `autoDetect: true` 时，也会触发该回退（有手动代理时会应用手动代理）；macOS 的自动发现由系统脚本处理。该回退不保证联网请求成功；实际 API 或 CLI 请求失败仍由对应功能显示错误。NeoRead 不修改操作系统代理设置，也不要求开启 TUN。

系统代理绕过列表中的单条无法转换规则（如部分通配符 `172.2*`、不规范通配符 `foo*bar` 等）会被跳过，其余有效规则与代理地址仍正常应用；该行为不会在诊断中显示警告。完整回退（整份配置无法读取或包含 PAC / 需要依赖自动发现）会在”设置 → 诊断”显示提示，连接检测展示实际使用的回退结果。Electron 的”跟随系统”仍由 Chromium 处理；PAC 可能只对 Electron 有效。保存的配置损坏时回退到系统模式，并在设置里提示；可以重新保存有效配置。

人工检查：分别在 Mac 和 Windows 打开“设置 → 诊断”，填写本机 Clash 的 HTTP / Mixed 端口，检测 ChatGPT，确认状态与路由；换成未监听的端口应失败。保存后确认应用仍能阅读，点击重启后确认地址与端口保留、阅读位置恢复，再测试实际 Agent / API 功能。切回跟随系统并重启，确认 Windows Clash 默认绕过列表仍可使用；关闭代理或切换直连后再次检测。ChatGPT 可能对无登录的检测请求返回 403，需要结合页面提示及实际功能判断。

## 应用内更新

安装后的 NeoRead 会在启动 15 秒后检查是否已到每日检查时间。应用运行期间也会检查到期时间；应用关闭时不运行后台任务，下次启动会补查。检查时间保存在用户数据目录的 `update-state.json`，重启不会重置每日间隔。失败或 Release 安装包尚未上传完成时，至少间隔一小时再试。开发模式不访问 GitHub。

更新来源为 `cynicalight/NeoRead` 的最新正式 GitHub Release。通过公开的 `/releases/latest` JSON 响应获取版本号，发现新版本后读取该版本的静态附件 `SHA256SUMS.txt` 来选择安装包，不调用 GitHub REST API，因此不占用匿名 REST API 每个来源 IP 每小时 60 次的查询额度。此入口仍可能遇到网络错误或 GitHub 的访问限制，手动检查失败时可打开发布页下载。仅提示比当前版本更新的正式版，不提示草稿、预发布版或旧版本。Release 必须同时提供当前平台（Apple Silicon Mac、Intel Mac 或 Windows x64）对应的安装包和 `SHA256SUMS.txt`。发布脚本先上传全部安装包，成功后再上传校验清单；清单尚未上传或缺少当前平台的安装包时稍后重试。在“关于 NeoRead”中可手动检查，手动检查不受每日间隔限制。

macOS 正式版优先原地更新：若当前应用由固定证书签名、Release 提供对应架构的 `mac-arm64.zip` 或 `mac-intel-x64.zip`，后台检查发现新版本时直接下载 zip，不弹窗、不显示进度（手动检查时显示进度；后台下载过程中手动检查也会显示剩余进度）。zip 同样核对 SHA-256，校验后在本机 loopback 上以随机路径临时提供给 Electron `autoUpdater`（Squirrel.Mac）。Squirrel 会再检查新应用的签名是否满足当前应用的指定要求（同一 bundle ID 与同一证书），通过后暂存，暂存完成后删除下载的 zip。随后提示“立即重启 / 稍后”：立即重启会照常保存阅读数据后退出并安装新版本；选择稍后时在下次退出 NeoRead 时安装。重启前再次检查同一版本不会重复下载。原地更新需要 NeoRead 所在目录可写；当前应用为 ad-hoc 签名（本地构建、旧版本）、Release 没有 zip，或下载、校验、Squirrel 任一步失败时，回退到下面的 DMG 流程。从 ad-hoc 签名的旧版本升级到首个固定证书版本，需要手动安装一次 DMG。

其他情况下发现更新后选择“下载安装包”，应用会通过 Electron 网络栈下载文件，使用已生效的 NeoRead 代理设置，并在本地核对 SHA-256。校验成功后：macOS 打开 DMG，请先退出 NeoRead，再将新 NeoRead 拖入 Applications 完成替换，应用不会自动退出；Windows 照常保存阅读数据并退出 NeoRead，Go 服务停止后，在 Electron `quit` 事件中以 `--updated /S --force-run` 静默运行 NSIS 安装程序。安装程序沿用上次的安装位置与安装模式（全体用户安装时会弹出 UAC），替换原安装目录后重新打开 NeoRead，书库在用户数据目录中不受影响。安装程序启动约 1.3 秒后会结束仍在运行的 NeoRead 进程，所以必须在退出流程结束后才启动它。保存失败时若选择“返回阅读”，安装会推迟到下次退出 NeoRead 时进行，安装后同样自动重新打开。Windows 静默安装不需要代码签名。下载文件保存在用户数据目录的 `updates/` 下；失败的下载会清理，进程被强制关闭可能留下 `.part` 文件。校验值确认文件与 Release 一致，不能替代开发者签名。

显示进度时，任务栏或 Dock 图标按 `Content-Length` 显示下载百分比，应用右下角的提示同时显示进度条、已下载与总大小（MB）及“开启代理加速”的提示；服务器未返回大小时进度条为不确定状态，只显示已下载大小。macOS 原地更新下载完成后，提示变为“正在准备安装”，Squirrel 暂存完成后消失。进度按整百分比（无大小时按 1 MB）推送给界面。

参见 [Electron 自动更新要求](https://www.electronjs.org/docs/latest/api/auto-updater)。

人工检查：安装含此功能的包，打开“关于 NeoRead → 检查更新”；确认无更新时提示当前版本。随后发布更高版本且安装包上传完成后，再检查并下载；macOS（固定证书版本，位于 Applications）确认出现“已准备就绪”，选择“立即重启”后自动以新版本启动，选择“稍后”则退出再打开后为新版本；Windows 确认 NeoRead 退出后不显示安装向导，片刻后以新版本自动重新打开，开始菜单和桌面快捷方式仍然可用；全体用户安装的版本确认出现 UAC 提示，同意后同样完成更新。安装后版本变化，原书库和阅读位置仍保留。选择“稍后”应继续阅读；断网时手动检查应提示错误。自动检查与真实系统安装仍需人工验收。

## 自动检查的范围

PR 和 `main` CI 只在 Ubuntu 上运行类型检查与 Go/前端测试，不构建应用或安装包。Release 和手动试跑固定源提交，按完整 SHA 查询本仓库 `ci.yml` 已成功的 push 检查；不复用其他提交、失败、未完成或 PR head 的记录。找不到可复用记录时先补跑同一检查流程，失败则停止发版。之后在原生 macOS ARM64 和 Windows x64 runner 上构建安装包并检查包内运行时，不重复跑整套测试。检查脚本先将整个应用复制到仓库以外的临时目录，再启动包内 Electron 的 Node 模式。这样可以避免漏装依赖时意外使用源码目录中的依赖。检查内容包括 PDF.js 渲染、原生 canvas 和真实 ONNX 推理。随后启动包内 Go 服务，检查 SQLite 初始化、loopback 绑定、API 鉴权和 Web 资源。macOS 还检查签名完整性，正式版要求签名者为固定证书。

这些检查不启动 GUI，也不代替 DMG 挂载、Gatekeeper、Windows 安装/卸载、SmartScreen 以及真实用户文档的人工验收。校验生成脚本检查 DMG、zip 与 EXE 产物的命名、数量、文件头/尾和大小，再计算哈希。

版面检查使用包内真实 PP-DocLayoutV3 权重，核对大小、SHA256 和许可文件后，在全新的临时目录中启动完整 PDF 处理器。检查通过预加载脚本禁用 Node `fetch` 和 TCP 连接，不传入 `--model`，也不提供书库模型缓存；两页原创样例必须生成非空版面区域、正文、`paper.md` 和完整 `manifest.json`，并且不创建模型缓存目录。它验证包内模型加载和离线首次解析链路，不评价其他文档的版面准确率。

## 相关文件与依据

- `.github/workflows/ci.yml`：单平台 PR/main 验证，也供发版补跑检查。
- `.github/workflows/build.yml`：Mac 与 Windows 构建任务。
- `.github/workflows/release.yml`：固定源提交、构建并上传安装包。
- `apps/desktop/builder.config.cjs`：安装包格式、资源路径和签名策略。
- `apps/desktop/mac-sign.cjs`、`scripts/create-mac-sign-cert.sh`：macOS 固定证书签名与证书生成。
- `scripts/package.mjs`、`scripts/package-smoke.mjs`、`scripts/processor-smoke.mjs`：资源部署与包内运行验证。
- [GitHub release 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)、[runner 平台](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[GITHUB_TOKEN 触发限制](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)。
- [electron-builder macOS 签名配置](https://www.electron.build/v26/docs/mac/)、[安装包资源配置](https://www.electron.build/v26/docs/configuration/)。
