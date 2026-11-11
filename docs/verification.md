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