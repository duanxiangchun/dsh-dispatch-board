# 双看板（右栏本工作区 / 左栏平台）浏览器验证报告

- 时间：2026-11-11 12:30 ~ 12:38（Asia/Shanghai）
- 实例：http://127.0.0.1:3099（dsh 0.2.2-rc.1，profile=taskboard；client.js 12:29:02 双看板版，host index.js 12:20:06）
- 视口 1600×1000；只写 .dev/e2e/
- 结论：**6/6 PASS**

| # | 项目 | 结果 | 证据 |
|---|------|------|------|
| 1 | 右栏只显示本工作区任务 + 副标题带工作区名 | **PASS** | `dual-01-right-scope.png` |
| 2 | 左侧栏平台看板入口 + 角标 + 必选工作区（未选禁用+提示） | **PASS** | `dual-02-platform.png`、`dual-03-required.png`、`dual-08-platform-badge.png` |
| 3 | 平台看板新建（选工作区 B）→ 卡片 tag / board.json cwd | **PASS** | `dual-04-created.png` |
| 4 | 自动派发到同工作区会话（无会话时 workspace-offline） | **PASS** | `dual-05-offline.png`、`dual-05b-doing.png`、`dual-05c-done.png` |
| 5 | 工作区过滤 + 卡片工作区 tag | **PASS** | `dual-06-filter-all.png`、`dual-06-filter.png` |
| 6 | 右栏新建任务与平台看板互通 + console 无错 | **PASS** | `dual-07-right-add.png`、`dual-07-both.png`、`dual-consol.json` |

---

## 1) 右栏 = 本工作区看板 —— PASS

- 打开「日常问答」工作区会话（WS 绑定自检）→ header「任务看板」按钮 → 右栏看板：
  - 副标题显示 **`· 日常问答`**（`board.workspaceSuffix` 生效）
  - 右栏只出现 `t-39`（cwd=日常问答）的任务；平台看板里另外建的 `t-40`（cwd=plinto）**不出现**
- 证据：`shots/dual-01-right-scope.png`（副标题「· 日常问答」，进行中只有 t-39）、`shots/dual-data.json.rightCards`

## 2) 左侧栏平台看板入口 + 角标 + 必选工作区 —— PASS

- 左侧菜单 `.panelRow` 出现 **「平台任务看板」**（与 插件/自动化任务/更多 并列），点开为整页平台看板：
  - 头部：标题「平台任务看板」、共 N 条、轮询状态/间隔/暂停轮询/立即刷新/一键归档已完成
  - 新建行：标题输入 + 「加备注」+ **「选择工作区」下拉（aria=任务所属工作区，必选）** + 「添加到待开始」
  - 过滤：`工作区` 下拉（全部工作区 + 各工作区）
- 未选工作区时「添加到待开始」**disabled**（空标题、填了标题都 disabled），并显示提示 **「先选择任务所属的工作区」**
- 角标：`[aria-label="平台任务看板"] .tb-badge` 按 **todo+doing** 计数——实测 badge=1 时 snapshot todo+doing=1；任务完成后 badge=null（计数 0 时消失）
- 证据：`shots/dual-02-platform.png`（空态+已选工作区控件）、`shots/dual-03-required.png`（未选工作区：按钮 disabled+提示）、`shots/dual-08-platform-badge.png`、`dual-data.json.addDisabled`

## 3) 平台看板新建（必选工作区）—— PASS

- 平台看板选工作区 **plinto**，加任务「DUAL 验证：在 .dev/e2e/dual-b.txt 写入一行 dualb」（备注写验收标准）→ 待开始出现卡片，卡片 meta 带 **「工作区 plinto」tag**
- board.json：`t-40` → `cwd=C:\\Users\\duan\\Code\\plinto`、`sessionId=null`（平台任务不绑定会话，符合设计）
- 同批还建了 A 任务 `t-39`（cwd=日常问答），两条 tag 均正确
- 证据：`shots/dual-04-created.png`、board.json 摘录

## 4) 全自动派发（同工作区）—— PASS

- 先不加 plinto 会话：等 35s，`t-40` 保持 todo，lastError=**「这条任务所属工作区没有打开的对话：先在那个工作区开一个对话，或点「立即派发」改派」**（snapshot `poll.lastSkipReason=workspace-offline`）→ 预期行为命中
- 之后在 plinto 工作区新建会话（`session-a9c97d85-…`，cwd=plinto）并发一条自检消息：
  - 15s 内轮询把 t-40 派给该会话：`poll.lastDispatchSessionId=session-a9c97d85-…`（= plinto 会话，**不是** 日常问答的会话）
  - 任务 doing（20s）→ done（35s），result 非空；产物 `dual-b.txt` = `dualb\n`（6 字节，hex 64 75 61 6c 62 0a）
- 期间 A 任务 t-39 也按 workspace-session 派给了日常问答会话（`996d…`/99374840），验证了「不同工作区各自派各自」
- 证据：`shots/dual-05-offline.png`（workspace-offline 原因）、`shots/dual-05b-doing.png`、`shots/dual-05c-done.png`、`dual-data.json`（boundB=true/doneB=true/dualB）

## 5) 工作区过滤 —— PASS

平台看板「工作区」下拉：

- 全部工作区：**2 条**（t-39 + t-40）
- plinto：**1 条**（t-40，tag 工作区 plinto）
- 日常问答：**1 条**（t-39，tag 工作区 日常问答）
- 每张卡片工作区 tag 与 cwd 尾段一致；`cwd=null` 的老任务在「全部工作区」可见、具体工作区过滤时隐藏（按路径比较）
- 证据：`shots/dual-06-filter-all.png`、`shots/dual-06-filter.png`

## 6) 右栏新建任务互通 + console —— PASS

- 回到日常问答会话的右栏看板新建 `t-41`（DUAL 验证B2）：board.json 记录 `sessionId=session-de0ba888-…`、`cwd=日常问答`（绑定当前对话）
- 切到左栏平台看板「全部工作区」→ 能看到 `t-41`（platformSeesA2=true），两张看板数据同源
- console：全程收集 `total=0，errors=[]，warnings=[]，pageerror=0`
- 证据：`shots/dual-07-right-add.png`、`shots/dual-07-both.png`、`shots/dual-console.json`、`dual-data.json`

## board.json 摘录（revision 229）

```json
[
  { "id": "t-39", "title": "DUAL 验证A：只回复 ok，不要改任何文件",
    "status": "done", "sessionId": null, "cwd": "C:\\Users\\duan\\Code\\demo\\demo\\日常问答" },
  { "id": "t-40", "title": "DUAL 验证：在 .dev/e2e/dual-b.txt 写入一行 dualb",
    "status": "done", "sessionId": null, "cwd": "C:\\Users\\duan\\Code\\plinto" },
  { "id": "t-41", "title": "DUAL 验证B2：右栏建任务互通",
    "status": "done", "sessionId": "session-de0ba888-9daa-498d-8169-0b35920b356e",
    "cwd": "C:\\Users\\duan\\Code\\demo\\demo\\日常问答" }
]
```

## 备注

- t-42「B2探针：dualb2 文件写入互通验证」是其他协作者/lead 的探针任务，与本轮无关。
- 平台任务不写 sessionId（全自动按 workspace 派发）；右栏任务写 sessionId（绑定当前对话）——两种语义都按描述工作。

## 复跑方式

```
$env:TARGET_URL='http://127.0.0.1:3099/?token=<token>'
cd C:\Users\duan\.claude\skills\playwright-skill
node run.js C:\Users\duan\Code\dsh-taskboard\.dev\e2e\dual-01.js      # 主流程（平台建任务/右栏范围/派发/过滤/互通）
node run.js C:\Users\duan\Code\dsh-taskboard\.dev\e2e\dual-badge.js   # 平台入口角标计数
```
