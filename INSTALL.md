# dsh-memory-system 安装与部署

> 给 DeepSeek Harness 用的**文件式记忆体系**：分层、会忘、能找回。
> 这个包是**纯插件 + 模板**，不含任何作者的私人记忆数据——装完从空白开始。

---

## 一、三种装法，选一种

### 方式 A：从 npm 装（最省事）

```bash
npx @deepseek-ai/dsh plugin --profile desktop add dsh-memory-system
```

### 方式 B：从本压缩包装

解压后，在解压出来的目录里执行：

```bash
npm pack                                  # 生成 dsh-memory-system-0.2.1.tgz
npx @deepseek-ai/dsh plugin --profile desktop add ./dsh-memory-system-0.2.1.tgz
```

### 方式 C：放进本地插件目录

把整个 `dsh-memory-system-0.2.1` 目录拷到你的工作区，然后：

```bash
npx @deepseek-ai/dsh plugin --profile desktop add ./dsh-memory-system-0.2.1
```

> 装完**重启 harness**，插件才会生效。

---

## 二、装完要做的第一件事：初始化

在会话里让 agent 调用 `memory_init`。它会在工作区里铺出这套结构：

```
数据/
  记忆单元.json        # 结构化记忆条目（zone / importance / updated / superseded_by）
  memory-decay.json    # FSRS-5 遗忘状态（R 可提取度 / S 稳定性）
  记忆单元.json        # 空数组起步
  archive/             # 冷归档
灵魂.md  自我.md  人设.md  日记.md  意向.md  状态.md  判据库.md
知识/索引.md
```

这些 md 都是**空模板**，按自己的需要填。

---

## 三、五个工具

| 工具 | 干什么 |
|---|---|
| `memory_init` | 初始化目录与模板（已存在不覆盖） |
| `memory_status` | 看单元数、冻结数、每个单元的 R/S |
| `memory_recall <关键词>` | 关键词召回：单元命中 + 原文行命中 |
| `memory_review <id> <1-4>` | 复习一次：1 又忘了 / 2 费劲 / 3 顺利 / 4 太简单 |
| `memory_archive` | 冷归档（默认 dry-run，加 apply 才真动） |

---

## 四、能配什么

看 `config.schema.json`。常用的几项：

- **自动注入**：每轮按当前消息挑几条记忆塞进提示词（只注入 `relation / task / reference`，`identity` 和 `vault` 不注入）
- **注入条数 / 字数上限**：默认 6 条 / 700 字
- **分区**：`identity` / `relation` / `task` / `reference` / `vault`

---

## 五、四层是什么

| 层 | 放什么 | 会不会忘 |
|---|---|---|
| **L3 灵魂** | 身份、锚点、自述、人设 | 不衰减，只能本人改写 |
| **L2 知识** | 判据与判例、资料、技能 | 不进遗忘曲线，用时查 |
| **L1 情节** | 事卡、日记、具体发生过的事 | **会**：可提取度低了冻结，久了冷归档（原文保留） |
| **L0 会话** | 当前上下文 | 压缩即丢，不落盘 |

设计取舍：**宁可少记，会忘，找不回来就直说没有**——不是把自己变成聊天记录仓库。

---

## 六、可选：接上语义检索

插件自带的是**关键词召回**。如果想要"意思相近也能找到"，可以自己接一层向量检索（本地 embedding 即可，不必联网），再和关键词结果融合。

作者自己的做法（仅供参考）：
1. 把 md 按 400 字切块、超长段落硬切
2. 本地小模型编码成向量
3. 检索时**向量排名 + BM25 字面排名做 RRF 融合**
4. 分数低于阈值 → 提示"大概率没有"；第一名第二名差距过小 → 提示"没有明显更贴的"

---

## 七、实测成绩（同卷可复现）

![成绩单](docs/总成绩单.png)

- 评测集：`chat-memory-benchmark` 正式卷 714 题（六个人物、约 390 轮对话/人、跨度约 6 个月）
- 判分：仓库自带的 `grading/grade.py`，官方口径
- 本系统：**622 / 714 = 87.1%**

> 说明：这个分数是在"检索层 + 作答层"完整接入后测的，不是只装插件就有；
> 但插件提供的是**同一套结构**（分层 / 遗忘 / 注入 / 召回），语义检索那层可以按上面第六节自己接。

## 八、运行示意图

![运行示意图](docs/记忆体系运行示意图.png)

---

## 九、常见问题

**Q：装完没反应？**
A：先确认重启过 harness；再确认 `memory_init` 跑过（否则没有 `数据/记忆单元.json`）。

**Q：注入太多 / 太少？**
A：改 `config.schema.json` 里的注入条数和字数上限。

**Q：会不会把我的私人记忆传出去？**
A：不会。这套东西全是本地文件，没有任何联网上传；插件本身不联网。

**Q：想关掉自动注入只手动查？**
A：把注入条数设成 0，只用 `memory_recall`。

---

MIT License · 2026
