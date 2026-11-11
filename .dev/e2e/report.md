# dsh-taskboard 端到端验收报告

- 验收时间：2026-11-11 10:46 ~ 11:00（Asia/Shanghai）
- 测试实例：http://127.0.0.1:3099 （dsh 0.2.2-rc.1，profile=taskboard，PID 28344，从 `C:\Users\duan\Code\dsh-taskboard` link 安装；token 查询参数取自启动 URL/lead）
- 插件：dsh-taskboard v0.1.0；模式声明 `presets/taskboard.patch.yml`；宿主 `lib/index.js`（RPC 前缀 `/taskboard`）
- 看板数据：`C:\Users\duan\.dsh\storages\dsh-taskboard\board.json`
- 浏览器：Playwright（Chromium，headless），脚本在本目录，截图在 `shots/`
- 未改动 `lib/`、`presets/`、`package.json`、`docs/`；未触碰 3080 用户实例；3099 服务未重启（复用 lead 已启动的实例）
- 结论：**6 项全部 PASS**（核心第 5 项完整闭环通过）

## 总结

| # | 项目 | 结果 |
|---|------|------|
| 1 | 带 token 首页 → 侧栏出现「任务看板」图标 | **PASS** |
| 2 | 看板页四列 + 新建输入框 + 轮询状态 | **PASS** |
| 3 | UI 新建任务 → 待开始出现卡片 + board.json 落盘 | **PASS** |
| 4 | 模式选择器出现「派单看板模式」「派单看板模式 · 执行者」并可选中 | **PASS** |
| 5 | 派单闭环：轮询投递 → 主 Agent 派子 Agent → 子 Agent 完成 → 主 Agent 审核 → 已完成 + result 非空 | **PASS**（t-3，10:53:44 投递，10:55:01 完成，约 77 秒） |
| 6 | 失败诊断 | 无阻塞项；附 2 条非阻塞观察 |

---

## 1) 侧栏「任务看板」图标 —— PASS

- 打开 `http://127.0.0.1:3099/?token=...`，页面标题 `DeepSeek Harness`，加载正常；先点「继续」关掉预览版说明弹窗。
- 侧栏按钮列表中出现 `aria-label="任务看板"`（class `hHd-Xa_panelRow`），与「插件」「自动化任务」「更多」并列。
- 证据：`shots/step1-home-sidebar.png`（左栏可见「任务看板」图标与文字）

## 2) 看板页渲染 —— PASS

点击侧栏「任务看板」后渲染：

- 四列：待开始 / 进行中 / 已完成 / 已归档（含每列计数）
- 新建输入框：placeholder「一句话说清要做什么，回车添加…」+「添加到待开始」按钮 + 「加备注」+「派发给」下拉
- 轮询状态：「每 15s 轮询 · 上次检查 10:47:59」，间隔选择 `5s/15s/30s/1min` + 「暂停轮询」+「刷新」
- 脚注数据文件路径 `C:\Users\duan\.dsh\storages\dsh-taskboard\board.json`，版本 v0.1.0
- 证据：`shots/step2-board-page.png`；DOM 文本见本报告附录命令输出（每列 class `tb-col[data-status=...]`）

## 3) UI 新建任务 + board.json 落盘 —— PASS

- 通过 UI 填写：标题「E2E 冒烟：在 .dev/e2e/hello.txt 写入一行 hello」，备注写清验收标准（绝对路径、恰好一行 hello、回报文件路径与内容、审核通过后置 done 并写 result）。
- 点「添加到待开始」后，「待开始」列出现卡片（卡片含标题、备注、t-3、时间、开始/立即派发/编辑/删除按钮）。
- board.json 中确有该任务：`id=t-3`、`status=todo`、`source=user`、`note` 完整（见下方摘录）。
- 证据：
  - `shots/step3a-composer-filled.png`（填写中的输入框 + 备注）
  - `shots/step3b-task-added.png`（待开始列出现 t-3 卡片）
  - board.json 摘录（02:49:29 落盘，revision 11）：
    ```json
    { "id": "t-3", "title": "E2E 冒烟：在 .dev/e2e/hello.txt 写入一行 hello",
      "status": "todo", "source": "user", "sessionId": null, "notificationCount": 1,
      "createdAt": "2026-11-11T02:49:26.473Z" }
    ```
- 补充（重要，见「观察 1」）：该任务创建后 4 秒内被轮询自动派发到「最近活跃的空闲 roots」——当时是打开 Web UI 时自动产生的一个空白标准模式会话（session-e5d594dd…）。因此第 5 项改用「派单看板模式」新建会话并显式指定目标会话，做可复现的闭环验证。

## 4) 模式选择器 —— PASS

- 新会话输入框上方的模式 seat（title「选择新任务使用的 Agent 预设」）点开后，菜单中同时出现：
  - 「派单看板模式」——主 Agent 只拆解、派单、审核与汇报…
  - 「派单看板模式 · 执行者」——由「派单看板模式」派发的子 Agent 专用…
- 选择「派单看板模式」后 seat 文案变为「派单看板模式」，随后发首条消息创建会话（会话标题「派单模式自检」，模型回复「派发模式已就绪」）。
- 证据：`shots/step4b-mode-menu.png`（菜单含两项）、`shots/step4c-mode-selected.png`（已选「派单看板模式」）、`shots/step4e-turn-done.png`（会话创建成功）

## 5) 派单闭环（核心）—— PASS

目标会话：`session-0a81f6b1-4214-4730-b5d6-563b74ba36fd`（经 UI 新建的「派单看板模式」会话，标题「派单模式自检」）。看板任务：`t-3`。

### 时间线（board.json / snapshot / transcript 三方可对账）

| 时间 | 事件 | 证据 |
|------|------|------|
| 10:53:39 | 通过看板 RPC 把 t-3 置回 `todo` 并显式指定目标会话 0a81（清空上次 result/计数） | `shots/step5-01-queued.json` |
| 10:53:44.923 | 轮询命中并投递：snapshot `poll.lastDispatchAt=...02:53:44.923Z`、`lastDispatchSessionId=session-0a81…`；会话 transcript 出现 `INBOX SPLICED` 的【任务看板 · 待开始】t-3 消息；页面出现该消息（t+30s 截图） | `shots/step5-01.png`、`shots/transcript-0a81.txt` |
| 10:54:14 | 主 Agent 调 `taskboard_update {id:t-3,status:doing}` | transcript-0a81.txt；board `startedAt=02:54:14.949Z` |
| 10:54:15 | 主 Agent 调 `subagent`（spawn，描述「E2E 冒烟写 hello.txt」，prompt 含目标/验收标准/回报格式）；子会话 `af04b22a…`，`agentPreset=taskboard-worker`、`parentSession=session-0a81…`、`delegationDepth=1` | transcript-0a81.txt（SUBAGENT CATALOG）、transcript-worker-af04b22a.jsonl 首行 |
| 10:54:18~10:54:21 | 子 Agent 用 pwsh 写文件并自验（`WriteAllText("hello\n")`、Get-Content、hex 校验）；hello.txt 生成（6 字节 `68 65 6c 6c 6f 0a`，10:54:21） | transcript-worker-af04b22a.txt |
| 10:54:5x | 主 Agent 收到「Background subagent … finished」通知，先 `read` 文件独立取证，再 `taskboard_update {id:t-3,status:done,result:"已核验：…6 字节 … 验收通过。"}` | transcript-0a81.txt |
| 10:55:01.220 | board.json：`status=done`、`result` 非空、`finishedAt=02:55:01.220Z` | `shots/step5-final-snapshot.json` |
| 10:55:09 | 页面显示「已完成 / 1 个子智能体」；看板「已完成」列卡片带「结论: 已核验…」 | `shots/step5-03.png`、`shots/step6-board-final.png` |

### 判定要点

- **轮询投递**：是（poll.lastDispatchAt + lastDispatchSessionId + 会话里可看到【任务看板 · 待开始】用户消息，页面与 transcript 双证据）。
- **主 Agent 派发子 Agent**：是（transcript 里 `subagent` 工具调用；子会话 header `agentPreset=taskboard-worker`、`origin=subagent`）。
- **子 Agent 完成**：是（worker 写 hello.txt 并自验；主 Agent 收到 subagent-settled 通知）。
- **主 Agent 审核 + 改看板为已完成/result 非空**：是（主 Agent 先 read 文件复核再 done + result；board.json 与 UI 卡片均体现）。
- **耗时**：投递到 done 约 77 秒（模型 ollama-deepseek-v4.1-flash:1017），远低于 10 分钟上限；监控脚本每 30s 截图见 `shots/step5-01..03.png`。

### 关键证据文件

- `shots/step5-01.png`（t+30s：投递消息已到会话，含看板时间戳；任务仍 todo）
- `shots/step5-02.png`（t+60s：进行中、出现「1 个子智能体」、子 Agent 已回报、主 Agent 正在 read 复核）
- `shots/step5-03.png`（t+90s：已完成，顶部「1 个子智能体」，正文为审核结论）
- `shots/step6-board-final.png`（看板：已完成 1，卡片显示「结论: 已核验…」；顶部「上次派发 10:53:44 → session-」）
- `shots/step5-03-body.txt`、`shots/step5-final-body.txt`（页面文本快照）
- `shots/step5-final-snapshot.json`（快照含 tasks/poll/preset/agents）
- `shots/transcript-0a81.txt`（主会话完整可读 transcript：INBOX SPLICED、taskboard_update、subagent、审核、done）
- `shots/transcript-worker-af04b22a.jsonl/.txt`（worker 子会话，首行含 `"agentPreset":"taskboard-worker"`、`parentSession`）
- `shots/step5-00-session-open.txt`（会话页打开即显示「派单看板模式」）

### 旁证：自动派发路径也跑通了完整闭环

首次 UI 建的任务（同一 t-3）在 10:49:29 被自动派发到空白标准模式会话 `session-e5d594dd…`（`lastDispatchSessionId` 记录），该会话同样按【任务看板】指令执行了 `taskboard_list → taskboard_update(doing) → subagent → 独立 pwsh 复核 → taskboard_update(done, result)`，并写出当时的 hello.txt。可读 transcript 见 `shots/transcript-e5d.txt`（其中可见 poll 投递的【任务看板 · 待开始】消息与 subagent 调用）。该文件已保留为 `hello-from-standard-session.txt`，正式闭环测试前删除 hello.txt 重新生成（最终文件 10:54:21 由本次 worker 写入）。

## 6) 失败诊断 —— 无阻塞；2 条非阻塞观察

**观察 1（建议关注，不影响本次通过）：自动派发的「最近活跃空闲会话」会命中打开 Web UI 时产生的空白会话。**
- 现象：仅打开 3099 页面（未发消息）就会产生一个 idle root 会话（如 `session-e5d594dd…`，agentPreset=standard）。「派发给=自动（最近活跃会话）」会优先把看板任务投给它；如果它不是「派单看板模式」会话，任务就由标准模式 Agent 处理（虽然它仍按消息里的派单规则走了 subagent 闭环，见旁证）。
- 影响：用户「新建派单会话 + 看板建任务」的直觉路径里，任务可能被别的空白会话抢走；本次靠 `update-task.sessionId` 显式指定目标会话才做出确定性验证。
- 建议（不阻塞）：自动目标可优先选「派单看板模式」的会话，或跳过没有用户消息/无标题的空白会话；UI 侧也可提示「自动目标当前是 session-xxxx」。

**观察 2（UX 小问题）：** 看板「派发给」下拉对有消息但会话标题未同步的会话显示为多个相同的「session-」前缀（本次下拉出现 3 个 `session-`），无法区分。建议用 agent 的 session 标题或短 id 后缀（如 `session-0a81`）。

**诊断手段（供复跑）：**
1. `POST http://127.0.0.1:3099/taskboard/snapshot`（信封 `{type:'client-request',rpcId,method,payload}`）可实时看 `poll.lastDispatchAt / lastDispatchSessionId / lastSkipReason`、`tasks`、`agents`（含 root 状态 idle/running）、`preset.installed`；脚本 `probe-snapshot.mjs`。
2. 会话 transcript 在 `C:\Users\duan\.dsh\sessions\--C-Users-duan-Code-demo-demo-~65E5~5E38~95EE~7B54--\<sessionId>\session.v4.jsonl.zstd`，多帧 zstd，需逐帧解压：`node dump-transcript.mjs <file> <out>`，再 `node extract-transcript.mjs` 转可读；关键事件 `agent/inbox/spliced`（投递）、`tool/call`（taskboard_update/subagent）、`turn/end`。
3. 3099 启动日志在 `C:\Users\duan\.dsh\logs\startup-*.log`（本次 10:44 那份是 EADDRINUSE 失败记录；成功实例复用了 lead 已启动的进程，token 由 lead 提供）。

## 复现步骤（约 6 分钟）

1. （可选）清理看板：把待开始/已完成任务归档或删除，`hello.txt` 删除。
2. 打开 `http://127.0.0.1:3099/?token=<启动 URL 里的 token>`，点「继续」关弹窗；点侧栏「任务看板」确认四列与轮询状态（`shots/step2-board-page.png`）。
3. 在「派发给」里选目标会话（或建任务后用 `update-task` 指定 `sessionId`），标题/备注按上文填写 → 「添加到待开始」。
4. 新会话 → 模式 seat → 选「派单看板模式」→ 发一句「自检：只回复…」把会话建出来，等这一轮结束（约 30s）。
5. 把任务置 todo 并指向该会话后，等 ≤15s：页面出现【任务看板 · 待开始】；≤30s 任务变进行中并出现 subagent 调用；子 Agent 完成后主 Agent 审核 → 已完成、result 非空（看板卡片与 board.json 都能看到结论）。
6. 校验产物文件与 board.json：`node probe-snapshot.mjs http://127.0.0.1:3099`。

## 产物清单（本目录）

- `report.md`（本文件）
- 脚本：`explore-01.js`、`step2-board.js`、`step3-add-task.js`、`step4a-explore.js`、`step4-dispatch-session.js`、`probe-session.js`、`step5-monitor.js`、`step6-board-final.js`、`probe-snapshot.mjs`、`dump-transcript.mjs`、`extract-transcript.mjs`、`summarize-transcript.mjs`、`show-blocks.mjs`
- 截图：`shots/step1-home-sidebar.png`、`step2-board-page.png`、`step3a-composer-filled.png`、`step3b-task-added.png`、`step4b-mode-menu.png`、`step4c-mode-selected.png`、`step5-00…03.png`、`step5-final.png`、`step6-board-final.png`
- 数据/文本：`shots/step5-final-snapshot.json`、`shots/step5-03-body.txt`、`shots/transcript-0a81.txt`、`shots/transcript-worker-af04b22a.*`、`shots/transcript-e5d.txt`、`hello.txt`（6 字节 `68 65 6c 6c 6f 0a`）、`hello-from-standard-session.txt`
