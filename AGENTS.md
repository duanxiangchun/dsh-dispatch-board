# Agent 约定（本仓库）

## 定位

dsh-taskboard = DeepSeek Harness 的**派单模式 + 侧边栏任务看板**插件。纯手写 JS，无构建步骤，
Host 半 `lib/index.js`（ESM，Cordis 插件），Client 半 `lib/client.js`（`window.__ModuleLoader__` factory）。

## 硬约束（改代码前先读）

1. **Host 半只 import `node:` 内建模块**。不得 import 任何 `@deepseek-ai/*`（profile 的 node_modules
   里没有 dsh-llm/dsh-tools），需要的数据结构手工构造（见 `lib/index.js` 的 `newUserMessage`）。
2. **Client 半只 `require('react')`**。禁止 require 任何 `@deepseek-ai/*` Harness Client 包（会崩槽位）。
3. **不写 `$DSH_HOME` 之外的路径**（board.json / preset / 日志都在 `$DSH_HOME` 下）。
4. **协议单一事实来源 = `docs/architecture.md`**。改字段先改文档，Host 与 Client 同步改。
   **模式（preset）是 bundle patch 里的 `@deepseek-ai/dsh-agent-preset` 声明行**（`presets/taskboard.patch.yml`），
   0.2.2 起不再有 `$DSH_HOME/.agent-presets` 目录机制——别写文件安装预设。
5. 每个 RPC 端点必须在 `docs/architecture.md` 的表格里有行；错误码统一 `bad-request|not-found|conflict|internal`。

## 看板工作流约定（组长 / worker 必读）

与 `docs/architecture.md` §1.9 一致；改看板提问 / 归档行为前先读那一节。

1. **归档是终态：`needsUser` 不能挂在归档任务上**。看板「待你处理」不显示 `archived` 任务；
   `taskboard_update` / `update-task` 在归档任务上设置 `needsUser:true` 或 `question` 会被 Host 以
   `conflict` 拒绝（先于任何字段写入）。任务已完成 / 已归档但还需要用户拍板 → 用 `taskboard_add`
   新建一条 `todo` 任务（标题写清要确认什么），再在新任务上提问；同一次调用里带
   `{status:'todo', needsUser:true, question}` 重开 + 提问也允许。`needsUser:false` 取消提问在归档
   任务上仍幂等成功。
2. **问题写进看板，聊天只留一句指路**：question / questionOptions / 背景全部写进 `taskboard_update`
   的 `question` 与任务的 `note`；对用户的说明只写「已在看板提问 t-XX」，不要把问题正文只放在聊天或
   `lastError` 里（`lastError` 只写故障）。
3. **审核结论必须落看板**：直聊派活的任务由宿主自动置 `done`，组长审核后仍要用
   `taskboard_update {id, result:"…"}` 把审核结论写回该任务；写不进去就 `taskboard_add` 新建一条
   记录任务，不能只留在聊天里。
4. **无卡不得派发（0.2.4）**：组长每次 `subagent` 派发前，宿主闸门（`tools/pre-execute`）会认领 /
   新建看板卡片，写盘失败就拒绝派发（worker 不启动）。worker prompt 必须带任务 id（「任务 id：t-N」
   或「看板任务：t-N」）与标题，宿主据此复用原卡片（轮询任务的 worker 不要另立卡）；直聊派活由宿主
   自动建卡，**不要**再手动 `taskboard_add` 补记。遇到「派发已中止：没有看板卡片…」先修 `board.json`
   写权限或先建卡再重试，不要绕过闸门。

## 验证流程

```powershell
node --check lib\index.js
node --check lib\client.js
node --test            # test/*.test.mjs 纯函数单测
```

真实设备验证（verifier 负责）：安装到测试 profile → 起 3099 端口 → Playwright 打开看板 →
加任务 → 等轮询 → 观察主 Agent 是否派发 → 子 Agent 回报 → 看板状态变化。

## 发布

版本在 `package.json`；变更点记在 `docs/architecture.md` §9「变更记录」。
推 GitHub 时默认同时创建并推送 annotated tag `v<version>`（与 dsh-ollama-statistical 的约定一致）。

标准发布流程：

```powershell
# 1) 改 package.json 版本 + docs/architecture.md §9 变更记录，跑验证流程
# 2) 提交并打 annotated tag
git add -A
git commit -m "chore: release vX.Y.Z"
git tag -a vX.Y.Z -m "dsh-dispatch-board vX.Y.Z"
# 3) 分支和 tag 一起推
git push origin main vX.Y.Z
```

- tag `v*` 触发 `.github/workflows/publish.yml`：校验 tag 与 `package.json` 版本一致 → `node --test`
  → `npm publish --access public --provenance` → 建 GitHub Release；push `main` 触发 `ci.yml`（Node 20/22）。
- **发布鉴权：不需要本地 npm login，不需要 2FA，不需要 staged approve。** GitHub 仓库 Secret
  `NPM_TOKEN` 已经配好，Actions 直接用这个 key 发布，全程无人工鉴权/审批（2026-11-11 发布
  v0.1.3 实测：tag 推送后工作流 green，registry 几十秒内出现新版本）。本机 `npm whoami` 未登录
  不影响发布；`npm stage approve` 也不用跑。
- 发布后核对：`npm view dsh-dispatch-board version` 应为新版本（registry 有几十秒级延迟，
  CI 刚绿时查不到属正常，过一会儿再查，别急着判定失败）。
