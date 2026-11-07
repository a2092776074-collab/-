# Changelog

## 0.2.0 — 2026-11-07

- **自动注入带「现在」**：注入块开头加 `【现在】YYYY-MM-DD HH:MM（周X）`。此前模型不知道今天几号，「上次说的 / 隔了多久」这类问题无从算起。
- **每条记忆带相对时间**：注入行尾加 `· 3天前` / `· 18天前`，能直接分辨新旧；时间类问句时，「更新得更近」的单元权重更高。
- **判据接进注入**：新增 `<工作区>/数据/判据触发.json`（触发词 → 判据一句话），命中时在注入块最前面输出 `【判据·该响了】`（最多 2 条）。不再依赖「记得去翻判据表」。
- **召回输出分组**：`session:*`（历史会话索引）不再淹没真实单元——真单元优先列，session 只留一行汇总。
- 修复：`memory-decay` 的 ID 白名单不认 `session:`，遇到历史会话单元会直接抛错，导致 `memory_recall` 崩掉。
- 修复：`lastUserText` 只取最后一条 user 消息，而宿主会把「运行时上下文」当作另一条 user 消息追加在末尾——导致注入用的是上下文而不是用户的话。现在改为：取最后一条 assistant 之后、剥掉上下文后最长的那条。
- 修复：`cleanUserText` 现在会剥掉 `Time sampled while preparing turn…` / `Browser time zone…` / `Elapsed since…` 这类宿主注入行。

## 0.1.1 — 2026-11-05

- 修正包内 `files` 白名单，补上 `template/`、`scripts/`、`test/`。

## 0.1.0 — 2026-11-05

- 首个公开版本：四层记忆（灵魂/知识/情节/会话）、FSRS-5 衰减、冷归档、关键词召回。
- 5 个工具：`memory_init` / `memory_status` / `memory_recall` / `memory_review` / `memory_archive`。
- 分区：`identity` / `relation` / `task` / `reference` / `vault`；`identity`、`vault` 不自动注入，也不自动归档。
- 自动注入：每轮按当前消息与单元相关度、重要度、R 选 3–8 条，限 700 字；只注入 `relation/task/reference`。
- 工程包装：`manifest.json`、`locale/zh.json`、`locale/en.json`、`config.schema.json`、`test/smoke.mjs`。
