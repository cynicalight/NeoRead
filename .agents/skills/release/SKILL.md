---
name: release
description: NeoRead 公仓的发版入口说明。正式版本只从 NeoRead Pro 私仓发起；公仓自动接收同版本安装包镜像，不独立打包或发布。用于发版请求、查询镜像状态和排查缺失附件。
---

# NeoRead 公仓 Release 镜像

收到明确的发版请求时，在有维护权限的 NeoRead Pro 私仓 checkout 中使用 `neoread-release`。如果只有公仓访问权限，请发布维护者从私仓发起；不要在公仓手工建 tag、建草稿、运行打包或补传附件。仅询问流程或修改文档不触发发布。

私仓签名并发布后，镜像流程会在公仓创建同名版本，上传原始安装包和 `SHA256SUMS.txt`。公仓标签只指向公仓历史，GitHub 自动提供的源码归档只含开源代码；附件是官方 Pro 构建，不是公仓源码的构建结果。公仓不配置访问私仓的凭据。

核对镜像时，在公仓运行 `gh release view <tag> --repo cynicalight/NeoRead`，检查附件、校验清单和发布状态。新的最新正式版应成为 Latest，预发布不应成为 Latest。若镜像缺失、摘要不符或同名版本冲突，交由私仓发布流程恢复，不覆盖已有公开附件。完整约定见[公开发版说明](../../../docs/releasing.md)。
