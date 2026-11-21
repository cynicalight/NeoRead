# 公开发版、应用更新与本地打包

公开仓库继续维护 NeoRead 开源源码。新的 [GitHub 正式版](https://github.com/cynicalight/NeoRead/releases/latest)附带的是镜像的官方 **NeoRead Pro 安装包**，不是用本仓库源码构建的开源版安装包。

| Release 附件                    | 用途                         |
| ------------------------------- | ---------------------------- |
| `NeoRead-<version>-mac-arm64.dmg` | Apple Silicon Mac 安装       |
| `NeoRead-<version>-mac-arm64.zip` | Apple Silicon Mac 应用内更新 |
| `NeoRead-<version>-win-x64.exe`   | Windows x64 安装（NSIS）     |
| `SHA256SUMS.txt`                 | 安装包和更新包的 SHA-256     |

当前镜像尚不提供 Intel Mac 安装包或更新 ZIP，也不提供 Windows ARM64 或 Linux 安装包。仅发布 macOS 的版本不会附带 Windows 安装包。已有 Release 仍是历史版本；需要开源版的用户可以从公开源码运行或自行打包。

## 公开发版

1. 通过 PR 维护公开源码；需要验证合并后的提交时，可手动运行 **CI**（`gh workflow run ci.yml --ref main`）。直接推送 `main`、推送标签或发布 Release 都不会自动触发公开 CI。公开 Actions 不构建或上传桌面安装包。
2. 同一个版本的公开 Release 与 Pro 发布使用相同的 `v<version>` 标签名。公开标签只指向公开仓库历史中的提交，不指向 Pro 源码。GitHub 自动生成的 `Source code (zip)` 和 `Source code (tar.gz)` 只归档该标签的公开仓库内容，不包含 Pro 源码或作为附件提供的安装包。
3. 公开正式版的说明标明附件来自官方 NeoRead Pro 发布，不是该公开提交的构建结果。待适用平台的安装包和 `SHA256SUMS.txt` 均就绪后，才将该正式版设为 **Latest**，供仍查询公开 Release 的旧客户端发现。公开 CI 不需要也不配置访问非公开源码或发布系统的凭据。

维护公开源码版本时，根目录与 `apps/desktop/package.json` 的版本应保持一致，并为该版本维护开源版的 `docs/release-notes.json`；可运行 `node scripts/release-source.mjs` 校验。不要移动已经发布的标签。

## 从旧开源版升级

支持公开 GitHub Release 更新通道的旧客户端，可在“关于 NeoRead → 检查更新”中检查正式版。如果镜像版本号更新且提供当前平台的附件和对应校验值，客户端可能会提示升级到 Pro。公开镜像不强制升级，也不保证所有旧版都能应用内安装。未收到提示、更新失败或 macOS 签名不兼容时，可从正式版页面手动下载安装包。建议升级前备份书库；要继续使用开源版，可以不安装 Pro。

下载后可用 `SHA256SUMS.txt` 核对文件完整性；校验值不能替代开发者签名。以具体安装包的签名与系统提示为准，不需要关闭系统整体安全保护。

## 本地构建

在目标平台、目标架构上安装 Go（版本见 `apps/server/go.mod`）、Node.js 22 和 pnpm 10.30.3，然后执行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm package:dir  # 构建未封装应用，并检查包内运行时
pnpm package      # 构建 DMG 或 NSIS 安装包，并执行相同检查
```

产物在根目录 `release/`。脚本不上传任何文件，本地打包也不会生成官方 Pro 安装包。暂不支持交叉打包、Linux 安装包或 Windows ARM64。

安装包包含 Electron、Go 服务、Web 资源、PDF 处理器的生产依赖及约 67 MB 的 PP-DocLayoutV3 FP16 版面权重。终端用户无需安装 Node.js、Go、Python 或 PaddlePaddle；首次版面解析即可离线运行。安装包附带 Pi worker，AI 翻译需要已配置且通过文本检测的连接。

`pnpm package` 会先执行完整 `pnpm build`。PDF 处理器使用 workspace 锁文件部署为独立依赖目录，再裁剪其他平台的 ONNX 二进制；所有原生依赖必须来自当前 runner。临时 staging 和产物被 Git 忽略。

处理器构建先按 `apps/processor/model.json` 的固定 revision 获取权重，并核对 67,372,587 字节的大小和 SHA256。通过校验后才将临时文件发布到 `apps/processor/models/` 构建缓存；网络中断、大小或哈希不符会清理临时文件并停止构建；进程被强制终止时可能留下 `.part` 文件，但不会作为模型使用。已有缓存每次校验，损坏时需删除该缓存文件后重建；不静默覆盖。构建将当前模型和 `model-license/` 下的许可、来源说明复制到 `dist/models/`，打包时放入应用资源的 `processor/models/`，不放进 `app.asar`。权重、构建缓存和安装包均不进入 Git，Git 只管理模型规格、脚本与许可说明。

构建机器首次需要联网，之后可复用已校验的缓存。完全离线构建时，将环境变量 `NEOREAD_BUILD_LAYOUT_MODEL` 设为已有权重的绝对路径；该文件必须与固定模型的大小和 SHA256 一致，校验失败不会回退下载。`pnpm dev`、`pnpm desktop` 和单独的处理器构建使用同一流程；`pnpm install`、类型检查和普通单元测试不获取权重。

运行时从处理器旁的 `models/` 读取模型并核对完整性，不联网获取，也不在每个书库复制权重。缺失或损坏时解析失败，需要重新构建或安装应用。旧版书库里的模型缓存保留，但不再使用或自动删除。

### 本地 macOS 签名

本地打包默认使用 ad-hoc 签名。验证 Squirrel.Mac 原地更新时，可用 `scripts/create-mac-sign-cert.sh ~/neoread-mac-sign` 生成独立测试证书（输出目录必须不存在）；按脚本提示向本地打包进程提供证书和密码，给两次测试构建使用同一张证书。自签名不是可信开发者签名或 Apple 公证，也不能替代官方 Pro 安装包的签名。离线保管测试私钥和密码，不提交到仓库。

`apps/desktop/mac-sign.cjs` 会将提供的证书导入临时钥匙串，由 electron-builder 签名应用及嵌套二进制后删除该钥匙串，不修改登录钥匙串或信任设置。

## 代理设置与连接检测

macOS 和 Windows 桌面版在“设置 → 诊断”提供三种模式，默认“跟随系统”：

- **跟随系统**：启动时读取系统代理，传给 Go 服务和 Pi worker。
- **手动 HTTP 代理**：填写主机地址与端口，例如 `127.0.0.1` 和 `7890`；使用 Clash 的 HTTP 或 Mixed 端口，不能填写纯 SOCKS 端口。支持 IPv4、IPv6 和主机名，不支持账号密码。
- **直连**：清除 NeoRead 子进程继承的显式代理环境；系统 TUN、VPN 或透明路由仍由操作系统管理。

点击“保存代理设置”后，配置原子写入用户数据目录的 `proxy-settings.json`，与书库分开保存，不修改操作系统设置。重启后 Go 服务、Pi worker 和 Electron 应用内更新使用新配置，本机 loopback 请求始终绕过手动代理。点击“重启 NeoRead”会先照常保存阅读数据；保存失败并选择“返回阅读”会取消这次重启。保存本身不触发退出或重启。重新打开设置会等待正在进行的保存完成，显示最新配置。

“连接检测”固定访问 `https://chatgpt.com/robots.txt`。使用同域名的公开文本资源可减少首页浏览器验证对检测的干扰；它只验证网络可达性，不代表登录或模型调用可用。跟随系统模式检测当前 Go 与 Pi worker 已生效的启动配置，切换系统代理后可直接点击重启再检测；手动及直连配置可先检测草稿，再保存并重启。检测不影响正在进行的模型请求。独立的包内 Go 进程使用与 API 请求相同的环境代理规则，发出不带 API Key 或登录信息的 HEAD 请求；不跟随重定向、不读取正文、不打开书库。网络请求最多 12 秒，检测子进程有 15 秒上限；系统代理读取另有超时，Windows 不显示控制台，退出 NeoRead 时取消检测。

系统模式始终提供重启入口，运行中的请求与检测使用同一份启动配置。结果显示显式代理或直连路由、HTTP 状态及耗时；收到 401、403、405 或服务器错误说明已收到 HTTP 响应，不代表 ChatGPT 登录或模型调用可用。无法连接、证书验证失败、超时和代理 407 认证要求显示为失败，同时保留实际路由及耗时；检测进程未能返回结果时显示路由未知。检测仅证明 ChatGPT 公开资源的网络情况，不替代 Agent / API 的实际调用检测。

桌面应用启动时尝试将手动系统代理转换为 Go 服务和 Pi worker的代理环境。Windows 支持 Clash 默认绕过列表中的 IPv4 前缀通配符，例如 `127.*`、`192.168.*`、`10.*` 和 `172.16.*` 至 `172.31.*`，分别生成 CIDR 和 IP 范围写法供 Go、Node HTTP 使用；`*.local` 保留域名后缀绕过。`<local>` 加入 localhost、本机名称及其短名称；环境变量无法完整表达“任意不含点的内网主机名”，这部分仍取决于客户端运行时或额外列出的主机名。

代理读取失败、输出无效，或遇到无法转换的 PAC 时，应用保留原来的启动环境并继续启动，仅输出不含原始配置的控制台提示，不弹出启动错误窗口。Windows 在没有可用手动代理但 `autoDetect: true` 时，也会触发该回退（有手动代理时会应用手动代理）；macOS 的自动发现由系统脚本处理。该回退不保证联网请求成功；实际 模型请求失败仍由对应功能显示错误。NeoRead 不修改操作系统代理设置，也不要求开启 TUN。

系统代理绕过列表中的单条无法转换规则（如部分通配符 `172.2*`、不规范通配符 `foo*bar` 等）会被跳过，其余有效规则与代理地址仍正常应用；该行为不会在诊断中显示警告。完整回退（整份配置无法读取或包含 PAC / 需要依赖自动发现）会在”设置 → 诊断”显示提示，连接检测展示实际使用的回退结果。Electron 的”跟随系统”仍由 Chromium 处理；PAC 可能只对 Electron 有效。保存的配置损坏时回退到系统模式，并在设置里提示；可以重新保存有效配置。

人工检查：分别在 Mac 和 Windows 打开“设置 → 诊断”，填写本机 Clash 的 HTTP / Mixed 端口，检测 ChatGPT，确认状态与路由；换成未监听的端口应失败。保存后确认应用仍能阅读，点击重启后确认地址与端口保留、阅读位置恢复，再测试实际 Agent / API 功能。切回跟随系统并重启，确认 Windows Clash 默认绕过列表仍可使用；关闭代理或切换直连后再次检测。ChatGPT 可能对无登录的检测请求返回 403，需要结合页面提示及实际功能判断。

## 旧开源版的应用内更新机制

安装后的 NeoRead 会在启动 15 秒后检查是否已到每日检查时间。应用运行期间也会检查到期时间；应用关闭时不运行后台任务，下次启动会补查。检查时间保存在用户数据目录的 `update-state.json`，重启不会重置每日间隔。失败或 Release 安装包尚未上传完成时，至少间隔一小时再试。开发模式不访问 GitHub。

更新来源为 `cynicalight/NeoRead` 的最新正式 GitHub Release。客户端通过公开的 `/releases/latest` JSON 响应获取版本号，发现新版本后读取该版本的静态附件 `SHA256SUMS.txt` 来选择安装包，不调用 GitHub REST API。它只提示比当前版本更新的正式版，不提示草稿、预发布版或旧版本；也必须在校验清单中找到当前平台的安装包。网络失败或缺少匹配附件时，可打开发布页查看可用下载。在“关于 NeoRead”中可手动检查，不受每日间隔限制。

macOS 原地更新需要可写的应用目录、匹配架构的更新 ZIP，以及新旧应用的 bundle ID 和签名满足 Squirrel.Mac 的要求。兼容时，客户端在后台下载 ZIP 并校验 SHA-256，通过本机 loopback 临时交给 Electron `autoUpdater`；系统检查签名、暂存后提示“立即重启 / 稍后”。立即重启会先保存阅读数据；稍后则在下次退出时安装。当前应用为 ad-hoc 签名、ZIP 缺失、签名不兼容或下载、校验、暂存失败时，回退到 DMG 流程（如有匹配的 DMG）。

其他情况下发现更新后选择“下载安装包”，应用会通过 Electron 网络栈下载文件，使用已生效的 NeoRead 代理设置，并在本地核对 SHA-256。校验成功后：macOS 打开 DMG，请先退出 NeoRead，再将新 NeoRead 拖入 Applications 完成替换，应用不会自动退出；Windows 照常保存阅读数据并退出 NeoRead，Go 服务停止后，在 Electron `quit` 事件中以 `--updated /S --force-run` 静默运行 NSIS 安装程序。安装程序沿用上次的安装位置与安装模式（全体用户安装时会弹出 UAC），替换原安装目录后重新打开 NeoRead，书库在用户数据目录中不受影响。安装程序启动约 1.3 秒后会结束仍在运行的 NeoRead 进程，所以必须在退出流程结束后才启动它。保存失败时若选择“返回阅读”，安装会推迟到下次退出 NeoRead 时进行，安装后同样自动重新打开。Windows 静默安装不需要代码签名。下载文件保存在用户数据目录的 `updates/` 下；失败的下载会清理，进程被强制关闭可能留下 `.part` 文件。校验值确认文件与 Release 一致，不能替代开发者签名。

显示进度时，任务栏或 Dock 图标按 `Content-Length` 显示下载百分比，应用右下角的提示同时显示进度条、已下载与总大小（MB）及“开启代理加速”的提示；服务器未返回大小时进度条为不确定状态，只显示已下载大小。macOS 原地更新下载完成后，提示变为“正在准备安装”，Squirrel 暂存完成后消失。进度按整百分比（无大小时按 1 MB）推送给界面。

参见 [Electron 自动更新要求](https://www.electronjs.org/docs/latest/api/auto-updater)。

人工检查应用内升级时，用含更新功能的旧开源版在受支持平台上先打开独立测试书库，再检查高版本正式版是否被发现。验证手动下载、适用时的原地更新、升级后的版本和书库恢复；也验证缺失平台附件或断网时不会强制安装。未提供对应附件或签名不兼容的旧版本，不能视为支持自动安装。

## 自动检查的范围

公开 PR 与手动 CI 保留 Ubuntu 的 TypeScript、Go 和共享测试，以及 Windows 的代理、命令行安装、书库迁移和附件检查。CI 验证公开源码，不打包桌面应用；部分检查会构建 Go 服务以运行测试。

本地打包会将应用复制到仓库之外的临时目录，并启动包内 Electron 的 Node 模式，避免意外使用源码目录的依赖。检查 PDF.js 渲染、原生 canvas、真实 ONNX 推理，以及包内 Go 服务的 SQLite 初始化、loopback 绑定、API 鉴权和 Web 资源；macOS 还检查签名完整性。这些检查不启动 GUI，不代替 DMG 挂载、Gatekeeper、Windows 安装/卸载、SmartScreen 和真实用户文档的人工验收。

版面检查使用包内真实 PP-DocLayoutV3 权重，核对大小、SHA256 和许可文件后，在全新的临时目录中启动完整 PDF 处理器。检查通过预加载脚本禁用 Node `fetch` 和 TCP 连接，不传入 `--model`，也不提供书库模型缓存；两页原创样例必须生成非空版面区域、正文、`paper.md` 和完整 `manifest.json`，并且不创建模型缓存目录。它验证包内模型加载和离线首次解析链路，不评价其他文档的版面准确率。

## 相关文件与依据

- `.github/workflows/ci.yml`：公开 PR 与手动源码验证。
- `scripts/release-source.mjs`：本地校验公开源码版本与内置更新说明。
- `apps/desktop/builder.config.cjs`：安装包格式、资源路径和签名策略。
- `apps/desktop/mac-sign.cjs`、`scripts/create-mac-sign-cert.sh`：本地 macOS 签名与测试证书生成。
- `scripts/package.mjs`、`scripts/package-smoke.mjs`、`scripts/processor-smoke.mjs`：资源部署与包内运行验证。
- [GitHub Release 与源码归档](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。
- [electron-builder macOS 签名配置](https://www.electron.build/v26/docs/mac/)、[安装包资源配置](https://www.electron.build/v26/docs/configuration/)。
