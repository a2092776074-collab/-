## 插件信息

- **GitHub 仓库地址**：https://github.com/a2092776074-collab/-
- **插件类型**：cordis-plugin
- **一句话简介**：文件式 AI 记忆：四层、FSRS-5 衰减、冷归档、分区与自动注入。
- **作者自述简介**：把记忆做成普通文件：会忘、能找回、可迁移。给想让 AI 长期记住、又不想被上下文淹没的人。
- **是否已打 dsh-plugin 相关 topic**：暂未打；仓库根目录已有 `cordis.patch.yml` 和 `dsh.bundle`，可按特征检测收录。

## 补充说明（可选）

- npm：`dsh-memory-system@0.1.0`（https://www.npmjs.com/package/dsh-memory-system）
- 安装：`dsh plugin --profile desktop add dsh-memory-system`
- 不需要额外 API key；数据全部在用户工作区，不联网。
- 功能：5 个工具（init/status/recall/review/archive）、5 个分区、自动注入（relation/task/reference）、FSRS-5 冻结与冷归档。
