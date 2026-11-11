# 验证记录（v0.1.0）

本文件记录 dsh-taskboard 1.0 交付前的真实设备验证。所有产物在 `.dev/e2e/`（脚本 + 截图 + transcript）。

- 运行时：dsh 0.2.2-rc.1（全局安装 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`）
- 测试 profile：`~/.dsh/profiles/taskboard`（`dsh --from-default-profile web` 生成后 `dsh plugin add` 本仓库）
- 旁路实例：`http://127.0.0.1:3099`（不动用户在跑的 3080）
- 模型：ollama `deepseek-v4.1-flash:1017`，权限 danger-full-access

## 1. 自动化测试

| 项 | 结果 |
| --- | --- |
| `node --check lib/index.js` / `lib/client.js` | PASS |
| `node --test` | **40/40 PASS**（host 22 + client 4 + 渲染 14） |
| `.dev/verify-rpc.mjs http://127.0.0.1:3099` | **33/33 PASS**（信封/全部端点/错误分支/loopback 拒绝） |

## 2. 端到端验收（verifier，Playwright）

报告：`.dev/e2e/report.md`｜截图：`.dev/e2e/shots/`

| # | 项目 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 首页侧栏出现「任务看板」图标（带待开始角标） | PASS | `step1-home-sidebar.png` / `regress-badge.png` |
| 2 | 看板页四列 + 新建输入框 + 轮询状态，列高撑满 | PASS | `step2-board-page.png` / `regress-board.png` |
| 3 | UI 建任务 → 待开始卡片 + board.json 落盘 | PASS | `step3b-task-added.png` + board.json |
| 4 | 模式选择器出现「派单看板模式」「派单看板模式 · 执行者」 | PASS | `step4b-mode-menu.png` |
| 5 | **派单闭环**：轮询投递 → 主 Agent 置 doing → subagent(taskboard-worker) → 子 Agent 写文件 → 主 Agent read 复核 → done + result（**77 秒**） | PASS | `step5-01..03.png`、`step6-board-final.png`、`transcript-0a81.txt`、`transcript-worker-af04b22a.jsonl` |
| 6 | 回归：派发给下拉带模式名、头部派发对象可读、角标出现/消失、console 无错 | PASS | `regress-target-select-value.png`、`regress-board-header.png`、`regress-console.json` |

关键对账（e2e）：

```
board.json t-3: todo → poll.lastDispatchSessionId=session-0a81… → 会话出现【任务看板 · 待开始】
transcript-0a81: taskboard_update(doing) → subagent(prompt=…) → read 复核 → taskboard_update(done, result)
transcript-worker-af04b22a: header.agentPreset=taskboard-worker, header.parentSession=0a81…
文件证据: .dev/e2e/hello.txt = 6 字节 68 65 6c 6c 6f 0a（"hello\n"）
```

## 2.1 右侧栏改版验证（verifier，Playwright）

报告：`.dev/e2e/rightbar-report.md`｜截图：`.dev/e2e/shots/rb-*.png`

需求变更：看板从「左侧菜单面板」迁到**右侧栏**。左侧 `sidebar.panellist`/`main` 已删除，
改为右栏 tab 类型（`sidebarRightTabs` + `sidebar.right.pane.tab`）+ 会话 header 入口按钮。

| # | 项目 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 会话 header 出现「任务看板」按钮（带待开始角标），点击后右栏打开看板 tab；默认宽 719px → medium 两列网格 | PASS | `rb-01-header-entry.png`、`rb-02-panel-default.png` |
| 2 | 面板内新建/删除任务（先暂停轮询，避免触发真实派发） | PASS | `rb-03-task-added.png`、`rb-04-task-deleted.png` |
| 3 | 三档布局：全屏 → wide 四列（381.75px×4）；退出 → medium 两列；拖窄到 398px → narrow 四个纵向 lane | PASS | `rb-05-fullscreen.png`、`rb-06-after-fullscreen.png`、`rb-07-narrow-lane.png` |
| 4 | 右栏引导页出现「任务看板」入口卡片，点击可打开 | PASS | `rb-08-guide.png`、`rb-09-guide-open-board.png` |
| 5 | 左侧菜单不再有看板入口（`.panelRow` 只有 插件 / 自动化任务 / 更多） | PASS | `rb-report.md` |
| 6 | console 无报错（三轮浏览器会话 total=0/errors=[]/warnings=[]/pageerror=0） | PASS | `rb-console.json` |

> 探针卫生：`.dev/verify-rpc.mjs` 现在会在跑之前 `set-config pollEnabled:false`、finally 恢复，
> 避免 add-task → dispatch-now → delete-task 被轮询当成真任务派给主 Agent（幽灵任务）。

## 2.2 产品简化：「派发给」选择器移除（后续修订）

用户反馈「派发给很多余，完全就是主 Agent 全自动」。已按此调整：

- 看板新建区删掉会话选择器，只留「加备注」+ 一句「加进『待开始』后由主 Agent 自动接手」；
- 宿主 `resolveTargetAgent` 不再需要用户选会话，按「派单模式空闲会话 → 任意空闲会话」自动挑目标；
- `add-task` RPC 不需要 sessionId；测试相应改为「无目标选择器也能派发」。

## 2.3 工作区绑定（后续修订，回答「是不是当前对话的工作区」）

原行为（本节之前）：看板全局、任务不记录工作区、派给「最近空闲会话」——**不保证**是你当前对话的工作区。
现行为：右栏 tab 是 session scope，新建任务时把 `props.sessionId` 交给 `add-task`，宿主用
`session.header.cwd` 解析出工作区写进 `task.cwd`：

- 任务**优先派回创建它的对话**（`creator-session`），子 Agent 在同一工作区干活；
- 创建它的对话**正忙** → 等（`creator-busy`），不改派；手动「立即派发」可排队；
- 创建它的对话**是历史/冷会话** → 先尝试唤醒它（`sessionController.resolveAgent`，5 分钟失败负缓存）；
  唤醒不了则任务**留在待开始**并显示 `creator-cold` 原因（不在别的工作区干活），
  只有手动「立即派发」才退化到派单模式/任意空闲会话；
- 一次轮询逐条试候选，忙会话不阻塞其它任务；
- 冷会话的 `cwd` 用 `sessionQuery.listSessions()` 兜底解析，所以历史会话的提示/卡片也能显示工作区。

验证：`.dev/e2e/workspace-binding-report.md`（6/6 PASS）。

## 2.4 冷会话（历史会话）边界

`.dev/e2e/cold-session-report.md`：冷会话加任务 → 卡片/数据带工作区（`sessionQuery` 兜底）、
90s 保持待开始且显示 `creator-cold` 原因（不改派）、「立即派发」可强制改派并完成（3 PASS）；
「在历史会话发消息激活后回派」未自动化覆盖（headless 提交消息不可靠），但该路径 = 正常
`creator-session` 分支（2.3 已覆盖）。`session-info` 端点让冷会话的 composer 提示也能显示工作区。

验证（verifier，`.dev/e2e/auto-dispatch-report.md`）：**4/4 PASS**

| # | 项目 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 新建区无「派发给」（select 数=0），只有「加备注」+「自动接手」提示 | PASS | `rs-01-composer.png` |
| 2 | 只加任务不干预 → 0.7s 自动派发 → +37s doing → +87s done（主 Agent 派子 Agent 写文件并独立复核） | PASS | `rs-01b-added.png`、`rs-02-doing.png`、`rs-03-done.png`、`rs-auto.txt` |
| 3 | `board.json` 中该任务 `sessionId=null`；`poll.lastDispatchSessionId` 指向当时在线的会话 | PASS | `rs-data.json` |
| 4 | console 无报错 | PASS | `rs-console.json` |

## 2.5 双看板（右栏本工作区 / 左栏平台）

需求：右栏看板只显示本工作区任务；左侧栏加回「平台任务看板」显示全平台任务、卡片带工作区标签、
新建必须选工作区。验证 `.dev/e2e/dual-board-report.md`：**6/6 PASS**

| # | 项目 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 右栏只显示本工作区任务，副标题「· 工作区名」 | PASS | `dual-01-right-scope.png` |
| 2 | 左栏平台看板入口 + todo+doing 角标；未选工作区时禁用添加 + 提示 | PASS | `dual-02-platform.png`、`dual-03-required.png`、`dual-08-platform-badge.png` |
| 3 | 平台新建（选 plinto）→ 卡片「工作区 plinto」tag；board.json cwd、sessionId=null | PASS | `dual-04-created.png` |
| 4 | 派发：无 plinto 会话 → `workspace-offline` 待开始；开了 plinto 会话后 15s 内派给它 → doing → done | PASS | `dual-05-offline.png`、`dual-05b-doing.png`、`dual-05c-done.png` |
| 5 | 工作区过滤（全部 2 / plinto 1 / 日常问答 1），tag 与 cwd 一致 | PASS | `dual-06-filter-all.png`、`dual-06-filter.png` |
| 6 | 右栏建任务在平台看板可见（数据同源），console 零错 | PASS | `dual-07-right-add.png`、`dual-07-both.png` |

## 2.6 右栏看板「不显示任务」修复

用户反馈：平台看板正常，右侧小看板空白。根因：右栏过滤只认 `task.cwd === 本工作区`，
而旧任务/本对话早期任务 `cwd=null`，被过滤掉且无任何提示。

修复：
- 右栏过滤改为 `cwd 匹配本工作区` **或** `sessionId === 当前会话`（本对话创建的任务不会消失）；
- 工作区未知（历史会话）时只按 `sessionId` 兜底，不再整块空白；
- 头部加「另有 N 条任务没有绑定工作区…在左侧栏平台任务看板可见」提示。

验证：`.dev/e2e/rightboard-fix-report.md`。

## 3. 复跑方式

```powershell
cd C:\Users\duan\Code\dsh-taskboard
node --test
node .dev\verify-rpc.mjs http://127.0.0.1:3099
# 端到端：.dev/e2e/ 下的 Playwright 脚本（step1~step6）按顺序跑，需 3099 实例在线
```

## 4. 已知限制

- 自动派发优先选「派单看板模式」的空闲会话，没有才退化到任意空闲会话；没有在线会话时不派发（页面顶部显示跳过原因）。
- 看板是单机单文件（`$DSH_HOME/storages/dsh-taskboard/board.json`），未做跨进程锁；同一 `$DSH_HOME` 下同时跑两个 dsh 实例会共享同一块看板。
- 轮询投递的消息以普通 user 消息进入会话（`source.kind='user'`），transcript 里会像用户发言；这是为了会话日志一定可解码。