# 看板任务「绑定创建对话与工作区」验证报告

- 时间：2026-11-11 11:42 ~ 11:49（Asia/Shanghai）
- 实例：http://127.0.0.1:3099 （dsh 0.2.2-rc.1，profile=taskboard，重启后新 token；新 host+client：client.js 11:28:24 / index.js 11:28:31 之后又随本次重启加载）
- 视口 1600×1000；只写 .dev/e2e/，未改代码
- 结论：**6/6 PASS**（另有 1 个「历史会话未激活」的边界发现，见 5b）

| # | 项目 | 结果 | 证据 |
|---|------|------|------|
| 1 | 提示里显示工作区名 | **PASS** | `rs2-01-hint.png` |
| 2 | 卡片出现「工作区 日常问答」tag | **PASS** | `rs2-02-task.png` |
| 3 | board.json 记录 sessionId + cwd | **PASS** | 见下方摘录 |
| 4 | 自动派发回到同一个会话 → doing → done | **PASS** | `rs2-03-doing.png`、`rs2-04-done.png` |
| 5 | 两条任务分别回各自对话（sessionId 不同） | **PASS** | `rs2-05b-second.png`、`rs2-07b-second-done.png` |
| 6 | console 无报错 | **PASS** | `rs2-console.json`、`rs2b-console.json` |

---

## 1) 新建区提示显示工作区名 —— PASS

打开会话「看板任务自动派发执行」（工作区 `C:\Users\duan\Code\demo\demo\日常问答`），从会话 header 打开右栏看板，新建区提示实测：

> 加到「待开始」后由主 Agent 自动接手；**任务会回到本对话执行（工作区：日常问答）。**

- 截图：`shots/rs2-01-hint.png`

## 2) 卡片工作区 tag —— PASS

添加「WS 验证：在 .dev/e2e/ws-demo.txt 写入一行 demo」（备注写验收标准）后，待开始卡片 meta 行出现：

`t-26  工作区 日常问答  刚刚`

- tag 的 `title` 属性即完整 cwd（`C:\Users\duan\Code\demo\demo\日常问答`）
- 截图：`shots/rs2-02-task.png`（可见卡片上的「工作区 日常问答」）

## 3) board.json 记录 sessionId / cwd —— PASS

添加后立即读取 board.json（revision 134）：

```json
{ "id": "t-26",
  "title": "WS 验证：在 .dev/e2e/ws-demo.txt 写入一行 demo",
  "status": "todo",
  "sessionId": "session-09b87550-e892-48de-a1ec-29833e9ef73c",
  "cwd": "C:\\Users\\duan\\Code\\demo\\demo\\日常问答" }
```

- `sessionId` = 当前会话「看板任务自动派发执行」的 id
- `cwd` = 该会话的工作区路径（由 host `resolveSessionCwd` 解析）

## 4) 自动派发回到同一个会话 → doing → done —— PASS

未暂停轮询、未手动派发：

- t+15s：轮询自动派发，`poll.lastDispatchSessionId = session-09b87550-e892-48de-a1ec-29833e9ef73c`，**与 t-26.sessionId 完全一致**（不是页面上另一个空闲会话）
- t+45s：任务变 `doing`（截图 `shots/rs2-03-doing.png`）
- t+85s（约 1 分 25 秒，< 4 分钟）：变 `done`，result 非空：
  「审核通过（主 Agent 独立复核…）。文件 …\ws-demo.txt 存在；ReadAllBytes：length=5，hex=64656D6F0A（d e m o + LF）…无 BOM、恰好一行。子 Agent 33e3ed1c 执行，主 Agent 复核通过。」
- 产物：`ws-demo.txt` = `demo\n`（5 字节）
- 截图：`shots/rs2-04-done.png`（已完成列 + 结论 + 顶部「上次派发 11:42:37 → 3e9ef73c」）

## 5) 两条任务分别回各自对话 —— PASS（修正测试）

第二个会话用「同工作区新建会话」方式（新建会话 → 标准模式 → 发一句「WS 绑定自检：只回复 ok」建出 live 会话），其 agent `session-de0ba888-9daa-498d-8169-0b35920b356e`、cwd 日常问答：

- 从它的右栏看板添加「WS 验证 3：在 .dev/e2e/ws-demo3.txt 写入一行 demo3」
- board.json：`t-28.sessionId = session-de0ba888-…`、`cwd = C:\Users\duan\Code\demo\demo\日常问答`，卡片同样带「工作区 日常问答」tag，提示同样显示工作区名
- t+10s 派发：`poll.lastDispatchSessionId = session-de0ba888-…`（= t-28.sessionId，**不是** t-26 的会话）→ t+40s doing → t+81s done，result 非空，`ws-demo3.txt` = `demo3\n`（6 字节）
- 两条任务对比：t-26 → `session-09b87550-…`（A 对话），t-28 → `session-de0ba888-…`（B 对话），**sessionId 不同，且各自派发回各自创建对话**
- 截图：`shots/rs2-05b-second.png`（新会话 + 卡片工作区 tag + 提示）、`shots/rs2-06b-second-doing.png`、`shots/rs2-07b-second-done.png`（已完成 3 + 第二次派发 11:47:38 → 920b356e）

### 5b) 边界发现：从「未被激活的历史会话」加任务时工作区/回派会退化（建议关注）

第一次尝试第二步时用的是侧栏里的历史会话「刷新小时会话」（`session-32108038-…`，PTC 模式，仅被打开查看、没有 live agent）：

- 提示退化为通用文案（无「工作区：…」），卡片只有 `t-27` 没有工作区 tag
- board.json：`t-27.sessionId = session-32108038-…`（记录了来源），但 **`cwd = null`**
- 派发：`resolveTargetAgent` 查不到该 session 的 live agent → 按「创建者离线」退化，派给了另一个空闲会话 `session-98dd1c3e-…`（该会话被自动命名为「派发看板任务：WS 验证 2」），**没有回到用户当时查看的那个对话**
- 原因链：client 的 `currentAgent` 来自 snapshot.agents（历史会话未物化 → 拿不到 cwd → 无 tag/无工作区提示）；host 的 `resolveSessionCwd`/creator 判定也只查 live agent / live session。
- 影响：任务 sessionId 有记录，但 cwd 缺失、回派目标不是用户正在看的对话，与「从哪个对话加的就绑定那个对话与工作区」的语义有偏差。
- 证据：`shots/rs2-05-second.png`（无工作区 tag / 无工作区提示）、`shots/rs2-data.json`（task2.cwd=null、pollAfter2.lastDispatchSessionId=98dd1c3e）
- 建议（不阻塞发布）：UI 侧从会话 header/会话列表补 cwd 兜底展示；host 侧对「被打开的历史会话」做按需物化或从 sessions 服务读 header.cwd。

## 6) console —— PASS

- 两轮浏览器会话全量收集：**total=0，errors=[]，warnings=[]，pageerror=0**
- 证据：`shots/rs2-console.json`、`shots/rs2b-console.json`、`shots/rs2-data.json`、`shots/rs2b-data.json`

## board.json 摘录（最终，revision 150）

```json
[
  { "id": "t-24", "title": "[probe] RPC 验证任务", "status": "archived", "sessionId": null, "cwd": null },
  { "id": "t-26", "title": "WS 验证：在 .dev/e2e/ws-demo.txt 写入一行 demo",
    "status": "done", "sessionId": "session-09b87550-e892-48de-a1ec-29833e9ef73c",
    "cwd": "C:\\Users\\duan\\Code\\demo\\demo\\日常问答" },
  { "id": "t-27", "title": "WS 验证 2：在 .dev/e2e/ws-demo2.txt 写入一行 demo2",
    "status": "done", "sessionId": "session-32108038-79e6-4229-9ac1-42a677e5bce2", "cwd": null },
  { "id": "t-28", "title": "WS 验证 3：在 .dev/e2e/ws-demo3.txt 写入一行 demo3",
    "status": "done", "sessionId": "session-de0ba888-9daa-498d-8169-0b35920b356e",
    "cwd": "C:\\Users\\duan\\Code\\demo\\demo\\日常问答" }
]
```

## 复跑方式

```
$env:TARGET_URL='http://127.0.0.1:3099/?token=<token>'
cd C:\Users\duan\.claude\skills\playwright-skill
node run.js C:\Users\duan\Code\dsh-taskboard\.dev\e2e\rs2-01-binding.js   # 会话A：提示/tag/cwd/回派闭环
node run.js C:\Users\duan\Code\dsh-taskboard\.dev\e2e\rs2-02b-second.js   # 新会话B：两条任务各回各对话
```
