# 冷归档（模板）

- 归档 ≠ 删除：原文 `.md` 不动，只把单元移出活跃清单。
- 生成：`node scripts/memory-archive.mjs --apply`（默认 dry-run）。
- 恢复：`node scripts/memory-archive.mjs --restore <id>`，再 `memory-recall <关键词> --include-frozen --review 3` 解冻。
- 索引：各年份目录下的 `索引.md`。
