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
