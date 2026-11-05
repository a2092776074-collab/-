# dsh-memory-system

给 DeepSeek Harness 用的**文件式记忆体系**：分层、会忘、能找回。

不是向量数据库，也不是「把聊天记录全塞进上下文」。它把记忆拆成四层：

- **L3 灵魂**：身份/锚点，不衰减，只能本人改写；
- **L2 知识**：判据（我信什么）+ 外部参考（用时查）；
- **L1 情节**：日记/判例/情节单元，FSRS-5 算牢固度，会冻结、可归档；
- **L0 会话**：当前上下文，压缩即丢。

核心是**分层 + 允许忘 + 能找回来**，不是记得更多。

## 安装

```bash
dsh plugin --profile desktop add dsh-memory-system
```

或用本地 tarball：

```bash
npm pack
dsh plugin --profile desktop add ./dsh-memory-system-0.1.0.tgz
```

装完重启 DSH。插件本身不带任何人的灵魂/知识；初始化后才有模板。

## 初始化

装好后对助手说：

> 初始化记忆体系

或直接调用工具 `memory_init`。它会把模板（六件套、判据库、数据文件）和脚本复制到当前工作区，**已存在的文件不覆盖**。

## 工具

| 工具 | 作用 |
|---|---|
| `memory_init` | 初始化模板 + 脚本（不覆盖） |
| `memory_status` | 单元总数、冻结数、每个单元的 R/S |
| `memory_recall` | 按关键词找单元 + 原文；默认不列冻结 |
| `memory_review` | 复习一个单元，更新 FSRS-5（1-4） |
| `memory_archive` | 冷归档（默认 dry-run，`apply=true` 才动） |

## 分区

每个记忆单元有 `zone`，默认 `task`：

| zone | 放什么 | 自动注入 | 自动归档 |
|---|---|---|---|
| `identity` | 身份/锚点 | ❌ | ❌ |
| `relation` | 人物、关系、约定 | ✅ | ✅ |
| `task` | 手头的事、项目、待办 | ✅ | ✅ |
| `reference` | 外部参考、书摘 | ✅ | ✅ |
| `vault` | 私密仓 | ❌ | ❌ |

自动注入只读 `relation/task/reference`；`vault` 和 `identity` 要显式 `memory_recall` 才出现。

## 自动注入

插件启动后，每 3 秒检查活着的会话，挂一段 `systemPrompt.context`：

- 取当前用户消息，和单元标题/note/source 算关键词相关度；
- 再按重要度、FSRS R 排序；
- 最多 6 条、700 字；只列 `id + 标题 + zone`，不注入全文；
- 没有命中就返回空，不加噪音；
- 需要细节让模型再调 `memory_recall`。

> 这是 v0.1 的轻量版：没有向量检索，也没有 token 精算；够用就好。

## 直接跑脚本

不装插件也能用（把 `template/` 和 `scripts/` 复制到工作区）：

```bash
node scripts/memory-decay.mjs list
node scripts/memory-decay.mjs test
node scripts/memory-archive.mjs --self-test
node scripts/memory-archive.mjs                 # dry-run
node scripts/memory-archive.mjs --apply
node scripts/memory-recall.mjs 关键词 --review 3
node scripts/episode-add.mjs --kind text --title "..." --source "..." --detail "..."
```

## 结构

```
工作区/
├── 灵魂.md / 自我.md / 人设.md / 日记.md / 意向.md / 状态.md
├── 判据库.md
├── 知识/索引.md
├── 数据/记忆单元.json
├── 数据/memory-decay.json
├── 数据/archive/
└── scripts/
```

## 测试

```bash
npm test
```

`test/smoke.mjs` 会初始化一个临时工作区，验证：模板复制、分区过滤、自动注入不泄漏 vault、关键词召回、归档 dry-run。

## 设计取舍

- **文件优先**：可读、可 diff、可迁移；没有事务/并发控制。
- **忘是功能**：冻结/归档让旧细节不稀释当前判断；代价是要手动 review。
- **判据 vs 参考**：判据要案例 + 失效条件；参考用时查，不背。
- **灵魂不可外包**：外部插件可代存知识，不能代写「我是谁」。

## 边界

- 召回是关键词/子串，不是语义检索；
- 初始寿命是校准值（30/90/365/3650 天），不是验证过的效率；
- 归档是半自动，不会自己判断「这条没用了」；
- 没有内置加密：凭据不要放进这个体系，也不要进云备份。

## 许可

MIT。模板里的示例是虚构的，替换成你自己的。
