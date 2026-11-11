# 右栏看板「cwd 为空任务消失」修复验证报告

- 时间：2026-11-11 13:37 ~ 13:43（Asia/Shanghai；3099 于中途重启一次，已用新 token 重跑）
- 实例：http://127.0.0.1:3099（dsh 0.2.2-rc.1，profile=taskboard）
- 视口 1600×1000；只写 .dev/e2e/
- 结论：**4/4 PASS**（修复生效）

| # | 项目 | 结果 | 证据 |
|---|------|------|------|
| 1 | 本会话 cwd=null 任务出现在右栏；别的会话 cwd=null 任务不出现 + 未绑定提示 | **PASS** | `fix-01-right-show.png` |
| 2 | 平台看板建的本工作区任务出现在右栏（带工作区 tag） | **PASS** | `fix-02-platform-task.png` |
| 3 | 别的工作区任务不在右栏（平台看板可见） | **PASS** | `fix-03-other-ws.png` |
| 4 | 清理 + 恢复轮询 + console 无报错 | **PASS** | `fix-04-cleanup.png`、`fix-console.json` |

---

## 测试方法（复现用户现场）

- 打开会话「WS 绑定自检」→ 当前会话 `session-de0ba888-9daa-498d-8169-0b35920b356e`（工作区 日常问答）
- 用 RPC 暂停轮询（`set-config {pollEnabled:false}`），然后造任务：
  - **A**：`add-task {sessionId: session-00000000-…}` 造出 cwd=null，再 `update-task {sessionId: 当前会话}` → **cwd=null + 属于本对话**（等价于用户现场里 cwd=null 的旧任务）
  - **B**：`add-task {sessionId: session-00000000-…}` → cwd=null 且属于别的（不存在的）会话

## 1) 右栏显示本会话 cwd=null 任务 + 未绑定提示 —— PASS

刷新右栏看板后：

- **A 出现**在「待开始」：`LEGACY 验证A：无 cwd 但属于本对话 | t-14`，**无工作区 tag**（cwd=null，靠 `sessionId === 当前会话` 命中）
- **B 不出现**（cwd=null 且 sessionId 不是本会话）
- 头部出现提示：**「另有 2 条任务没有绑定工作区（旧任务或别的会话创建的），在左侧栏「平台任务看板」可见。」**
  - 计数为 2 而不是 1：除 B 外，看板里还有一条**修复前就存在的真实历史任务** `t-13「测试派发任务」`（cwd=null，done），正好验证了提示会把所有未绑定工作区的任务都统计进去
- board.json 摘录：
  ```json
  { "id": "t-14", "title": "LEGACY 验证A：无 cwd 但属于本对话", "status": "todo",
    "sessionId": "session-de0ba888-9daa-498d-8169-0b35920b356e", "cwd": null },
  { "id": "t-15", "title": "LEGACY 验证B：无 cwd 且属于别的会话", "status": "todo",
    "sessionId": "session-00000000-0000-0000-0000-000000000000", "cwd": null }
  ```
- 截图：`shots/fix-01-right-show.png`

## 2) 平台看板建本工作区任务 → 右栏出现（带 tag） —— PASS

在平台任务看板选工作区「日常问答」加 `t-16「LEGACY 验证C：平台看板本工作区任务」`（cwd=日常问答），回到右栏刷新：

- 右栏「待开始」= A（无 tag）+ C（**带「工作区 日常问答」tag**）
- 截图：`shots/fix-02-platform-task.png`

## 3) 别的工作区任务不在右栏 —— PASS

平台看板另选工作区「plinto」加 `t-17「LEGACY 验证D：平台看板别的工作区任务」`（cwd=plinto）：

- 右栏不出现 D（右栏只显示 A + C）
- 平台看板「全部工作区」可见 4 条测试任务（A/B/C/D），D 卡片带「工作区 plinto」tag
- 截图：`shots/fix-03-other-ws.png`

## 4) 清理 / 恢复轮询 / console —— PASS

- 删除 A/B/C/D：board.json 回到测试前的 5 条既有任务（t-1/t-3/t-4/t-10/t-13，均为 archived/done 的 probe 或历史任务）
- `set-config {pollEnabled:true}` 恢复轮询：snapshot `poll.running=true`、`lastSkipReason=null`、config.pollEnabled=true
- console：`total=0，errors=[]，warnings=[]，pageerror=0`
- 截图：`shots/fix-04-cleanup.png`；数据：`shots/fix-data.json`、`shots/fix-console.json`

## 备注

- 本轮测试数据通过板子 RPC（add-task/update-task/set-config）构造，未改任何代码或配置文件；删除后看板已还原。
- 过程中 3099 曾掉线一次，用 lead 给的新 token 重跑，结论不变。

## 复跑方式

```
$env:TARGET_URL='http://127.0.0.1:3099/?token=<token>'
cd C:\Users\duan\.claude\skills\playwright-skill
node run.js C:\Users\duan\Code\dsh-taskboard\.dev\e2e\fix-03.js
```
