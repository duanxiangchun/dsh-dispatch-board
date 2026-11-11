# 冷会话（历史会话）加任务验证报告

- 时间：2026-11-11 11:57 ~ 12:16（Asia/Shanghai）
- 实例：http://127.0.0.1:3099（dsh 0.2.2-rc.1，profile=taskboard，重启后 pid 36272；host 修复版 index.js 11:55:53，client.js 11:39:06）
- 视口 1600×1000；只写 .dev/e2e/
- 按 lead 12:10 的时间预算要求收尾：已确证的写结论，未跑通/未覆盖的明确标注。

## 结论摘要

| # | 项目 | 结果 |
|---|------|------|
| 1 | 冷会话加任务：卡片出现「工作区 日常问答」、board.json 记录 cwd（host sessionQuery 兜底） | **PASS**（提示 composer 仍为通用文案，见备注） |
| 2 | 1~2 分钟内任务保持「待开始」、卡片显示 creator-cold 原因、poll 未改派 | **PASS** |
| 3 | 「立即派发」force 逃生口 → 派给其它空闲会话并完成 | **PASS** |
| 4 | 在该历史会话里发一条消息激活 → 任务回派该会话 → doing → done | **未覆盖**（自动化未能提交消息，见下） |
| 5 | console 无报错 | **部分覆盖**（运行片段无 pageerror/console.error；汇总文件因中途终止未落盘） |

---

## 1) 冷会话加任务：卡片/数据带工作区 —— PASS

- 打开侧栏历史会话「刷新小时会话」（PTC 模式，展开「其余会话」后可见，session-32108038-…，无 live agent）。
- 从会话 header 打开右栏看板，新建区提示（客户端）为通用文案：「…加进「待开始」后由主 Agent 自动接手，你只管加任务和看结论。」——**未显示工作区**（client 的 currentWorkspace 依赖 snapshot.agents，冷会话不在其中；这是 client 侧残留，非 host）。
- 添加任务「COLD3 验证：在 .dev/e2e/cold-demo4.txt 写入一行 cold4」后：
  - 卡片 meta 出现 **「工作区 日常问答」**（title=完整 cwd）
  - board.json：`t-36.sessionId=session-32108038-79e6-4229-9ac1-42a677e5bce2`、`cwd=C:\\Users\\duan\\Code\\demo\\demo\\日常问答`（该历史会话此前解析 cwd=null，现在由 host `sessionQuery.listSessions()` 兜底成功）
- 证据：`shots/cold5-01-task.png`、`shots/cold2-02-task.png`

## 2) 保持待开始 + creator-cold 原因 + 不改派 —— PASS

添加后轮询 90 秒不动（未暂停、未手动派发）：

- 任务状态：`todo`（不变）
- 卡片/board.json 显示原因：**「创建这条任务的对话还没激活（历史会话）：在那边发一条消息，任务就会回到该对话执行；急的话点「立即派发」」**
- snapshot：`poll.lastSkipReason="creator-cold"`；`poll.lastDispatchSessionId` 与添加前一致（未被改派到其它会话）
- 证据：`shots/cold5-02-pending.png`（90s 时状态）、`shots/cold6-01-pending.png`（更晚仍保持）、board.json 摘录：
  ```json
  { "id": "t-36", "status": "todo",
    "sessionId": "session-32108038-79e6-4229-9ac1-42a677e5bce2",
    "cwd": "C:\\Users\\duan\\Code\\demo\\demo\\日常问答",
    "lastError": "创建这条任务的对话还没激活（历史会话）：在那边发一条消息，任务就会回到该对话执行；急的话点「立即派发」" }
  ```

## 3) 「立即派发」force 逃生口 —— PASS

同一轮测试中，对另一条冷会话任务 `t-34`（creator=`session-e7a5bfc7-…`，同样是 creator-cold 状态）点卡片「立即派发」：

- 派发后 snapshot：`poll.lastDispatchSessionId = session-1aefe840-4177-42b4-b8ab-6e80c3792d32`（**≠ creator**，派给了另一个空闲会话）
- 该任务随后 `done`，result 非空；产物 `cold-demo2.txt` = `cold2\n`（5 字节）
- board.json：t-34 `status=done`、`sessionId=session-e7a5bfc7-…`（仍保留创建来源）
- 证据：`shots/cold2-04-force-dispatched.png`、board.json 摘录

## 4) 激活冷会话后回派 —— 未覆盖（自动化未能提交消息）

尝试在「刷新小时会话」里发一条消息（「继续」）把它激活，两种方式都失败：

- 点击发送按钮（aria「发送消息」）：输入框文字仍在（`shots/cold5-03-activated.png` 可见输入框里残留「继续」），未发起新一轮
- 按 Enter 提交：`cold6-01.js` 中 `composerAfterSend` 仍为「继续，请简短回复 ok。」，`bodyHasMsg` 只是输入框内容
- 交叉验证：该会话文件 `session-32108038…/session.v4.jsonl.zstd` 的 mtime 仍为 10:00:30（本轮无任何新记录）；snapshot.agents 中始终没有该 session 的 live agent，因此任务一直停在 creator-cold，没有进入「回派→doing→done」
- 判断：这是 Playwright 在 headless 下对该会话输入框的提交不可靠，**不是产品结论**；host 侧「唤醒 / 回派 / 保持待开始」的分支已由第 2、3 项间接验证。建议人工在浏览器里打开该历史会话发一句话做最终确认。
- 证据：`shots/cold5-03-activated.png`、`shots/cold6-02-sent.png`（如有）、会话文件 mtime、poll 持续 creator-cold

## 5) console —— 部分覆盖

- 各脚本均监听 `console`(error/warning) 与 `pageerror`；运行输出中**无任何 pageerror/console.error 打印**
- 因按时间预算中途终止，最终的 `cold*-console.json` 汇总未落盘，故标记「部分覆盖」。

## 旁路噪声（不影响判断）

- `t-35`（同样 creator=`e7a5bfc7`）最终变成 done：执行者是 `session-9b6f4d24-…`——这是上一轮误把「继续」发到首页新会话输入框而创建的游离会话，它自行用 taskboard_update 把 t-35 改成 done。**不是**「唤醒创建者」路径的证据。
- `COLD2 验证A`、`COLD2 验证B` 卡片上的「工作区 日常问答」tag 也一并验证了 host cwd 兜底对新旧任务都生效。

## 复跑方式

```
$env:TARGET_URL='http://127.0.0.1:3099/?token=<token>'
cd C:\Users\duan\.claude\skills\playwright-skill
node run.js C:\Users\duan\Code\dsh-taskboard\.dev\e2e\cold5-01.js   # 冷会话加任务 + 90s 待开始原因
node run.js C:\Users\duan\Code\dsh-taskboard\.dev\e2e\cold6-01.js   # 尝试发消息激活（headless 提交不可靠）
```
