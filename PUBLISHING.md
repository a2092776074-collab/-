# 发布到 npm / DSH 插件市场

> 这份文件是给维护者的；普通用户看 README 即可。
> 当前包名 `dsh-memory-system` 在 npm 上**可用**（2026-11-05 查，`dsh-memory-layers` 已被占用）。

## 0. 前置

1. npm 账号（`npm login`）；
2. GitHub 仓库：把 `package.json` 里三处 `CHANGE-ME` 换成真实仓库地址；
3. 决定包名是否就叫 `dsh-memory-system`（已查可用）。

## 1. 发布前检查

```bash
npm test
npm pack --dry-run
```

确认 `lib/`、`cordis.patch.yml`、`manifest.json`、`locale/`、`config.schema.json`、`template/`、`scripts/`、`test/`、`README.md`、`LICENSE` 都在包里。

## 2. npm 发布

```bash
npm login
npm publish --access public
```

## 3. GitHub

- 新建仓库，push；
- 给仓库打 topic：`dsh-plugin`；
- 仓库里保留 `PUBLISHING.md` 和 `README.md`，市场来源审计要求仓库可达。

## 4. 提交到 DSH 市场

DSH 市场（[dsh.market](https://dsh.market/)）的数据源是 npm/GitHub 插件索引；常见做法：

1. 包已发布到 npm，且 GitHub 仓库带 `dsh-plugin` topic；
2. 到市场仓库 [2BingLing/dsh-market](https://github.com/2BingLing/dsh-market) 看最新的提交说明（issue/PR/索引格式），按当前说明提交；
3. 市场索引 `plugins.json` 更新后，在 DSH 侧边栏市场里能搜到。

> 市场规则会变；以仓库当前 README / CONTRIBUTING 为准，不要照旧教程硬套。

## 5. 干净 profile 验证

```bash
dsh plugin --profile demo add dsh-memory-system
dsh --profile demo --dump-config | grep -A3 memory-system
dsh --profile demo
```

打开会话，确认：

- 初始化：`memory_init`；
- 状态：`memory_status`；
- 召回：`memory_recall 关键词`；
- 复习：`memory_review <id> 3`；
- 归档：`memory_archive`（先 dry-run）。

验证完可以 `dsh plugin --profile demo remove dsh-memory-system`。

## 6. 当前阻塞（本机）

- `npm whoami`：`ENEEDAUTH`——本机没登录 npm；
- 没有 GitHub 仓库地址，`package.json` 里还是 `CHANGE-ME`；
- 因此**还不能真正 publish / 提交市场**，需要账号和仓库就位后再执行第 2–4 步。
