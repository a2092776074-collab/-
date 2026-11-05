# Changelog

## 0.1.0 — 2026-11-05

- 首个公开版本：四层记忆（灵魂/知识/情节/会话）、FSRS-5 衰减、冷归档、关键词召回。
- 5 个工具：`memory_init` / `memory_status` / `memory_recall` / `memory_review` / `memory_archive`。
- 分区：`identity` / `relation` / `task` / `reference` / `vault`；`identity`、`vault` 不自动注入，也不自动归档。
- 自动注入：每轮按当前消息与单元相关度、重要度、R 选 3–8 条，限 700 字；只注入 `relation/task/reference`。
- 工程包装：`manifest.json`、`locale/zh.json`、`locale/en.json`、`config.schema.json`、`test/smoke.mjs`。
