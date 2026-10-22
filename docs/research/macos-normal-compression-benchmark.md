# macOS normal ZIP 压缩实测

日期：2026-10-21。配置变更仅为 `mac.compression: "normal"`。Windows 继续使用 maximum；DMG 保持 UDRO → ULMO。

## 方法

在 Apple M3 Pro、macOS 27.0.1 上，下载 [v0.8.7 发布 ZIP](https://github.com/cynicalight/reader/releases/tag/v0.8.7)，核对 SHA256SUMS.txt，再使用 ditto 解压为同一份已签名 Reader.app。

原始 ZIP SHA-256：`6ef91cd9f1c6cea1d6950097f8937f4eed9e773a8974872ce89ff9786e04328d`。

调用工作树安装的 app-builder-lib 26.17.0 `out/targets/archive.js` 的 `archive("zip", output, source, {compression, withoutDir: false, preserveSymlinks: true})`。使用其自带的 7zip@1.0.0 工具；没有压缩等级环境变量覆盖。输出分别写入全新文件，避免增量归档。下载工具、解压、编译和签名检查均不计入压缩时间。测试、构建先结束，归档按 normal → maximum → normal 顺序串行执行。

normal 使用 Deflate `-mx=7`；maximum 使用 Deflate `-mx=9 -mfb=258 -mpass=15`。两者都保留符号链接。用 performance.now() 测量 archive 调用墙钟时间。

## 结果

| 配置 | 压缩耗时 | ZIP 字节数 | 十进制 MB |
| --- | ---: | ---: | ---: |
| normal，第 1 次 | 41.08 秒 | 286,219,609 | 286.22 |
| maximum | 348.52 秒 | 285,361,798 | 285.36 |
| normal，第 2 次 | 45.64 秒 | 286,219,609 | 286.22 |

normal 相比 maximum 节省约 303–307 秒（5 分 3 秒至 5 分 7 秒），减少约 86.9%–88.2% 的压缩时间。ZIP 增加 857,811 字节，约 0.86 MB / 0.30%。两次 normal 输出大小一致，maximum 输出大小与原发布 ZIP 一致。

## 验证与边界

原始应用、两种配置生成的 ZIP 解压后，以及 normal 重复测量产物均通过 `codesign --verify --deep --strict`。首轮两个 ZIP 解压后分别与源应用比较，18,486 个条目的文件 SHA-256、权限、目录与符号链接目标全部一致。

本次通过 pnpm typecheck、pnpm test（Go 通过；Vitest 1072 passed / 5 skipped）、pnpm build，以及配置断言和 git diff --check。

这是本机对同一份发布应用的归档对比，maximum 测量一次、normal 两次，不是统计学基准。没有重新触发 GitHub Actions、发布安装包或执行端到端自动更新。CI 硬件、并行 DMG 任务和负载不同，不能把本机节省秒数直接当作 CI 整体节省值。既有 CI 中 ZIP 归档约 13 分 16 秒，调整后实际耗时仍需下一次 CI 验证。

原始计时 JSON 和临时实验脚本位于本机 `/tmp/reader-compression-benchmark-20261021/`，不纳入 Git。
