# dsh-dispatch-board — 内部契约 v1（Host ⇄ Client ⇄ Preset 单一事实来源）

本文件是 Host 半（`lib/index.js`）、Client 半（`lib/client.js`）与「派单模式」预设
（`presets/taskboard.patch.yml`）之间的**唯一契约**。任何一方想改字段/端点/状态机，先改本文件，再改代码。

- 插件包名（= Client bundle id）：`dsh-dispatch-board`
- 运行时内部标识保持 `taskboard`：存储 `~/.dsh/storages/dsh-taskboard/`、RPC `/taskboard`、右栏 tab 类型 `dsh-taskboard`、预设 `taskboard-dispatch`/`taskboard-worker`、工具 `taskboard_*`（改包名不影响老数据）
- RPC 通道前缀：`/taskboard`
- Host loader row id：`taskboard`
- 模式声明：`presets/taskboard.patch.yml`（bundle patch 里的两条 `@deepseek-ai/dsh-agent-preset` 行，
  id 分别是 `taskboard-dispatch` 与 `taskboard-worker`；0.2.2 起 preset **不是**目录）
- 目标运行时：dsh 0.2.2-rc.1（Web profile）

---

## 0. 目录与文件职责

```
package.json            Lead：manifest（dsh.bundle.patch / dsh.client / exports / files）
cordis.patch.yml        Lead：插入一行 Host loader row（id: taskboard）
lib/index.js            host-core：Cordis 插件（ESM；路由 / 轮询 / 工具 / 存储 / 模式状态读取）
lib/client.js           client-ui：浏览器 bundle（window.__ModuleLoader__.load）
presets/taskboard.patch.yml  preset-dev：两个模式的声明行（persona + 工具 + 委派 + agentPreset）
locale/zh.json,en.json  Lead：插件元数据
icon.svg / icon 变体     Lead：原创图标
test/*.test.mjs         host-core：node:test 纯函数单测
docs/architecture.md    本文件（契约）
README.md               Lead：安装 / 使用 / 排障
```

禁止：Client 半 `require` 任何 `@deepseek-ai/*`（只允许 `react`）；Host 半 import 任何
`@deepseek-ai/*`（profile node_modules 里没有）；写 `$DSH_HOME` 之外的路径。

---

## 1. 概念与状态机

### 1.1 任务（Task）

一条看板任务。**四个状态，单向 + 可回退**：

| status | 中文列 | 含义 | 谁改成它 |
| --- | --- | --- | --- |
| `todo` | 待开始 | 用户/主 Agent 新建，尚未派发 | 用户新建；主 Agent 打回重做 |
| `doing` | 进行中 | 已派发，子 Agent 在干 | 主 Agent 派发后自己更新（`taskboard_update`） |
| `done` | 已完成 | 主 Agent 审核通过 | 主 Agent `taskboard_update` |
| `archived` | 已归档 | 用户/主 Agent 归档，不再参与轮询 | 用户点归档；主 Agent `taskboard_update` |

合法迁移：`todo→doing`、`doing→done|todo`（打回）、`done→archived|doing`（返工）、
`archived→todo`（重新打开）。**轮询只扫 `todo`。**

### 1.2 派单闭环（本插件存在的理由）

1. 用户在侧栏「待开始」列加任务（或主 Agent 用 `taskboard_add`）。
2. Host 轮询器每 `pollIntervalMs` 扫 `todo`；命中且目标 Agent 空闲 → 用 `agent.followup()`
   推一条「【任务看板】…」的用户消息（`source.kind='user'`），给该任务打 `notifiedAt`。
3. 主 Agent（派单模式）收到后 `taskboard_update` 把任务改成 `doing`，然后用 `subagent` 派发子 Agent，
   自己结束本轮，**不自己干活**。
4. 子 Agent 干完 → 运行时把 settling notice 送回主 Agent → 主 Agent 开新一轮审核：
   - 通过：`taskboard_update status=done result=…`，并向用户汇报一行结果；
   - 不通过：`send_message` 打回同一个子 Agent 重做（`doing` 不变），或 `taskboard_update status=todo` 重新排队。
5. 用户把 `done` 归档（`taskboard_update status=archived` 或 UI 按钮），看板收敛。

### 1.3 轮询器的边界

- 只在 **目标 Agent 空闲**（`agent.status === 'idle'`）时投递；运行中不打扰（下次轮询再试）。
  **投递成功即自动把任务置为 `doing`**（写 `startedAt`、清 `lastError`）：看板立刻反映「已派发」，
  不再依赖主 Agent 记得调 `taskboard_update`（它再调一次 doing 也合法）。
- 每个任务同一时刻最多一条未失效通知：`notifiedAt` 之后 `min(2×intervalMs, 120s)` 内不重复投递；
  超过冷却且仍未变化则重投（`notificationCount++`），`notificationCount >= 5` 后停手并在 UI 标「派发超时」。
- 每轮最多投递 1 条，避免一次把 10 个任务糊到主 Agent 脸上。
- `pollEnabled=false` 时完全不动（UI 顶部开关）。

### 1.4 目标 Agent 解析

**不需要用户选会话**，但**派发去处可选**（看板顶部「派发到」，`config.dispatchMode`，默认 `new`）：

| 模式 | 行为 |
| --- | --- |
| `new`（默认） | 在任务所属工作区**新建一个派单模式的对话**，任务投给它——不会挤进别人的对话。创建时先用 `workspaceIdForCwd` 把 cwd 映射成工作区 id，走 `sessionController.create({workspaceId, agentPreset:'taskboard-dispatch'})`，**新对话会落在那条工作区的分组里**（而不是「未分组」）；映射不到工作区时退回 `{cwd}` |
| `creator` | 派回**创建它的那个对话**（现在的语义：忙则等、冷会话尝试唤醒、唤醒不了就等） |
| `auto` | 忽略创建者，按「同工作区空闲 → 派单模式空闲 → 任意空闲」挑一个会话 |

`new` 模式失败（没有 sessionController、解析不到工作区、工作区创建被拒、预设不可用）会自动退回 `auto` 的挑法，不丢任务。
创建成功时还会把 `task.dispatchedSessionId` / `dispatchedSessionTitle` 记到任务上（详情里「执行对话」直接跳过去）。

任务同时**绑定创建它的对话与工作区**。解析顺序：

1. 任务带 `sessionId`（从某个对话的右栏加的）且该会话在线：
   - 会话空闲 → **派回创建它的那个对话**（`creator-session`），子 Agent 在同一个工作区里干活；
   - 会话正在跑 → 本轮跳过（`creator-busy`），**绝不改派别的会话**，等它空下来；
   - 用户手动点「立即派发」（`force`）时例外：即使它正忙，也把消息排进它的下一轮。
2. 任务带 `cwd` 但没有 `sessionId`（平台看板创建的）→ 优先找**同一工作区**的空闲 root 会话
   （`workspace-session`，路径归一化比较）；同工作区没有空闲会话 →
   `workspace-busy`（有会话在跑）/ `workspace-offline`（一个都没有），**本轮不派**，也不改派到别的工作区；
   只有手动「立即派发」（`force`）才允许退化到第 4 步的挑法；
3. 创建它的会话没有 live agent（历史/冷会话）→ 先尝试**唤醒它**：Web 端走
   `ctx.get('sessionController').resolveAgent(sessionId)`（与 UI 打开会话时的物化同一路径，带并发去重）。
   成功就按第 1 步回派；失败（实测历史会话被 UI 持有 writer 时会返回 `session/writer-held`）记 5 分钟负缓存；
4. 唤醒不成功 → **本轮不派**（`creator-cold`）：任务留在待开始并显示
   「创建这条任务的对话还没激活（历史会话）：在那边发一条消息，任务就会回到该对话执行；急的话点『立即派发』」。
   **绝不**把工作区绑定的任务偷偷派到别的会话/工作区；
5. 只有手动「立即派发」（`force`）才允许退化：优先 `session.header.agentPreset === 'taskboard-dispatch'`
   的空闲 root Agent，再退化到最近注册的空闲 root Agent；
6. 都没有（没有任何空闲会话）→ 本轮跳过，UI 显示跳过原因（`agent-busy` / `no-live-agent`）。

一次轮询会**逐条**试候选任务：某个任务的目标会话正忙时跳过它继续看下一条，
不会让「一个忙会话」挡住整列任务（每个任务按自己的创建者判断）。

`task.sessionId` = 创建这条任务的对话（右栏创建时记录，决定默认派发归属）；
`task.cwd` = 任务所属工作区（右栏创建时由会话解析；平台看板创建时由用户选择，直接取 `workspaceRegistry.list()` 的 `path`）。
三个解析时机：`add-task` 时先查 live Agent/Session 的 `header.cwd`；查不到用
`sessionQuery.listSessions()` 从会话列表兜底（冷会话也能拿到）；仍没有就在投递前从目标会话补一次。
`cwd` 会写进派发文本的「工作目录」一行，也是卡片上「工作区 X」tag 的来源。

注意：子 Agent 不是 root，`roots()` 天然不含它们，不需要额外过滤。

---

## 2. 持久化

路径：`$DSH_HOME/storages/dsh-taskboard/board.json`（`$DSH_HOME` 取 `process.env.DSH_HOME`，缺省 `~/.dsh`）。
测试/多实例可用 `DSH_TASKBOARD_PATH` 直接指定 board.json 路径（例如
`$env:DSH_TASKBOARD_PATH='C:\Users\duan\.dsh-taskboard-test\board.json'`），避免两个进程抢同一个文件。
所有读写前都会比对 revision（`reloadBoardIfStale`），盘上更新就采用盘上状态。

```jsonc
{
  "version": 1,
  "nextId": 12,                 // 单调递增，任务 id = "t-<n>"
  "revision": 37,               // 每次写盘 +1（client 可用它做增量判断）
  "updatedAt": "2026-11-11T02:00:00.000Z",
  "config": {
    "pollEnabled": true,
    "pollIntervalMs": 15000,    // 5000..300000
    "maxNotifications": 5,
    "notifyCooldownMs": 120000  // 由 interval 派生，写盘只作观测
  },
  "tasks": [
    {
      "id": "t-1",
      "title": "把 X 改成 Y",
      "note": "验收标准：…",     // 可空串
      "status": "todo",          // todo | doing | done | archived
      "source": "user",          // user | agent | poller
      "sessionId": "…" | null,   // 创建这条任务的对话（决定默认派发归属）
      "cwd": "C:\\…" | null,
      "assignee": "…",           // 子 Agent 的 label / sessionId，主 Agent 填
      "result": "…",             // 审核结论 / 子 Agent 汇报摘要
      "createdAt": "…ISO…",
      "updatedAt": "…ISO…",
      "startedAt": "…ISO…" | null,
      "finishedAt": "…ISO…" | null,
      "archivedAt": "…ISO…" | null,
      "notifiedAt": "…ISO…" | null,
      "notificationCount": 0,
      "lastError": ""            // 最近一次派发/失败原因，UI 显示
    }
  ]
}
```

- 原子写：同目录 `board.json.tmp` → `rename`；失败只记 `console.warn`，内存状态不丢。
- 读坏文件：`console.warn` + 从空板开始（坏文件改名 `board.json.corrupt-<ts>` 保留现场）。
- 内存状态是唯一真源；每次变更立即落盘（任务量小，不需要节流）。

---

## 3. RPC（沿用 dsh-ollama-statistical 已实测的 0.2.x 信封）

```
POST /taskboard/<endpoint>
Content-Type: application/json
{ "type": "client-request", "rpcId": "<string>", "method": "<endpoint>", "payload": { ... } }

200 → { "type": "server-response", "rpcId": "<string>",
        "result": { "ok": true, "value": ... } }
      或 result: { "ok": false, "error": { "code": "...", "message": "...", "details": {} } }
```

- `error.details` 必须是对象（客户端解析器要求）。
- 非 POST / 非 JSON → 415/404 纯文本；非 loopback Host → 403；非法信封 → 200 + `bad-request`。
- 客户端调用：`connection.rpc.call('/taskboard', endpoint, payload)`。

### 3.1 端点表

| endpoint | payload | value | 说明 |
| --- | --- | --- | --- |
| `snapshot` | `{}` | `Snapshot` | 全量看板 + 运行时状态，client 每 2s 轮一次 |
| `add-task` | `{title, note?, sessionId?, cwd?}` | `{task}` | 新建到 `todo`，`source='user'`；右栏传 `sessionId`（宿主解析 cwd），平台看板传 `cwd`（用户选的工作区） |
| `update-task` | `{id, status?, title?, note?, result?, assignee?, lastError?}` | `{task}` | 局部更新；非法状态迁移 → `conflict` |
| `delete-task` | `{id}` | `{deleted:true,id}` | 物理删除（仅限 UI 手动） |
| `dispatch-now` | `{id}` | `{dispatched, sessionId, task}` | 立即投递一次（不等轮询、无视冷却） |
| `set-config` | `{pollEnabled?, pollIntervalMs?, dispatchMode?}` | `{config}` | 开关 / 间隔 / 派发去处（`new` / `creator` / `auto`） |
| `archive-done` | `{}` | `{archived:n}` | 一键把全部 `done` 归档 |
| `session-info` | `{sessionId}` | `{sessionId, cwd}` | 给 client 兜底：冷会话（历史会话）不在 `agents[]` 里时也能拿到工作区，用于提示文案 |
| `install-preset` | `{}` | `PresetStatus + {action:'none'}` | **兼容端点**：0.2.2 起模式随 bundle patch 声明，这里只强制刷新 registry 状态 |

### 3.2 `Snapshot` 形状

```jsonc
{
  "version": 1,
  "revision": 37,
  "updatedAt": "…ISO…",
  "config": { "pollEnabled": true, "pollIntervalMs": 15000, "maxNotifications": 5 },
  "tasks": [ Task… ],                       // 全部状态，client 自己分组
  "poll": {
    "running": true,                        // 定时器是否在跑
    "lastRunAt": "…ISO…" | null,
    "lastDispatchAt": "…ISO…" | null,
    "lastDispatchSessionId": "…" | null,     // 会话 id（展示用尾 8 位）
    "lastDispatchSessionTitle": "…" | null,  // 会话标题（有则优先展示）
    "lastSkipReason": "no-live-agent" | "agent-busy" | "cooldown" | "poll-disabled" | null
  },
  "workspaces": [                           // 工作区注册表（平台看板的新建下拉/过滤用）
    { "id": "…", "path": "C:\\work\\demo", "title": "demo", "status": "ok" }
  ],
  "agents": [                               // 在线会话快照（client 用它显示「当前工作区」提示；不提供会话选择器）
    { "sessionId": "…", "status": "idle"|"running", "cwd": "…"|null, "title": "…"|null,
      "preset": "taskboard-dispatch"|"standard"|…|null, "root": true }
  ],
  "preset": {
    "installed": true,                       // agentPresets.list() 里 taskboard-dispatch 存在且无 broken
    "version": "0.1.0",
    "path": "bundle:presets/taskboard.patch.yml",
    "restartRequired": false,                // bundle 声明的模式随启动加载，无「装完要重启」语义
    "broken": "",                            // 挂载失败诊断（非空 = 该模式不可用）
    "presets": [ { "id": "taskboard-dispatch", "name": "派单看板模式", "description": "…", "broken": "" },
                 { "id": "taskboard-worker", "name": "派单看板模式 · 执行者", "description": "…", "broken": "" } ],
    "reason": ""                             // 读不到 registry 时的原因
  },
  "boardPath": "C:\\Users\\…\\.dsh\\storages\\dsh-taskboard\\board.json",
  "now": "…ISO…"
}
```

`agents[].title`：会话头里的标题（未命名时为空串）。
`agents[].preset`：**`ctx.get('agentPresets').presetForSession(agent.session)`**（Session 的 agentPreset 投影，
反映创建后切换过的模式；`session.header.agentPreset` 只是创建时的值，实测新建派单模式会话后仍是 `standard`，不能用作判据）。
宿主用它决定「优先派给哪个空闲会话」，client 不再展示会话选择器。

### 3.3 错误码

| code | 场景 |
| --- | --- |
| `bad-request` | 信封/端点/字段不合法（title 空、status 不在枚举、id 不存在时的格式错） |
| `not-found` | `id` 不存在 |
| `conflict` | 状态迁移非法 / 标题重复 / 并发 revision 冲突 |
| `internal` | 读写盘、未知异常 |

---

## 3.5 视觉层（Apple 风格皮肤）

- 样式集中在 `lib/client.js` 的 `CSS` 数组里，最后一段是覆盖式「皮肤」：基础规则在上，皮肤规则在下（同优先级后者胜），只改观感、不改结构。
- 皮肤令牌挂在 **`body`** 上而不是 `:root`：宿主的 `--dsw-alias-*` 定义在 body 作用域，`:root` 取不到（`var()` 会静默失效，背景变透明）。
- 画布色用 `color-mix(in srgb, var(--dsw-alias-bg-base) 94%, #000)` 派生：浅色下是浅灰、深色下是更深的灰；白卡片在两种模式下都比画布亮，深色模式自动跟随。
- 主区看板用 `@media` 做列数降级（≤1180px 两列、≤620px 一列）；右栏看板用面板宽度测量（`data-layout`）。

## 4. Host 行为细节

### 4.1 服务注入

```js
export const inject = ['timer']   // 唯一硬依赖：轮询定时器
// webServer 是 Web profile 才有的服务 → ctx.inject(['webServer'], cb) 等它就绪再注册路由；
// 缺失时插件仍加载（工具与轮询可用），不会整包 PENDING。
// agents / sessions / tools / agentPresets 全部用 ctx.get / ctx.inject 软取。
```

### 4.2 路由

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'prefix',
  path: '/taskboard',
  handler: (req, res) => { handleHttp(rt, req, res).catch(...) },
}), 'taskboard: rpc bridge')
```

### 4.3 轮询器

`ctx.interval(fn, pollIntervalMs)`（用 `ctx.effect` 包住，卸载自动清）。`set-config` 改间隔时
销毁并重建定时器。每次 tick 先读内存状态（不重读盘），异常只 `console.warn`。

### 4.4 工具（模型侧，全局注册）

全部用 `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })`
直接注册（**不用** `defineTool`，避免 import `@deepseek-ai/dsh-tools`；`parameters` 用标准 JSON Schema，
`required` 数组放对象层）。注册在 `ctx.get('tools')` 存在时执行，缺失则跳过并告警。

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `taskboard_list` | `{status?}` | 返回文本清单（id / 状态 / 标题 / 备注 / assignee / result）+ 结构化 `tasks[]` |
| `taskboard_add` | `{title, note?}` | 新建任务（`source='agent'`，`sessionId=exec.agent.session.id`） |
| `taskboard_update` | `{id, status?, result?, assignee?, note?}` | 更新任务；`status` 非法迁移返回错误文本 |

工具输出统一 `output.schema = { type:'object', … }`，`render` 返回 `[{type:'text', text}]`。
`execute(args, exec)` 中 `exec.agent` 可能为空（非 agent 调用）→ 直接 `throw`。

### 4.5 模式状态（预设声明 + 读回）

0.2.2 起 preset **不是目录**：`$DSH_HOME/.agent-presets/` 已没有宿主代码读取。preset 是 bundle
patch 里的一条 `@deepseek-ai/dsh-agent-preset` 声明行（config: `id/name/description/order/plugins`）。
因此本插件不写盘、不复制文件，只在 `presets/taskboard.patch.yml` 里声明两个模式：

| 模式 id | 名称 | 用途 |
| --- | --- | --- |
| `taskboard-dispatch` | 派单看板模式 | 主 Agent：只读文件工具 + 派单/审核/看板，无 shell、无写文件 |
| `taskboard-worker` | 派单看板模式 · 执行者 | 子 Agent：完整执行工具集；由 dispatch 的 `subagent` 行用 `agentPreset: taskboard-worker` 指定 |

- 子 Agent 的 preset 只能由 **spawn** provider 指定（fork 会继承父级 preset），因此派单模式只挂
  `subagent` 行，不挂 `subagent_fork`；`maxDepth: 1` 是递归硬上限。
- 宿主侧只做「读回状态」：`ctx.inject(['agentPresets'], …)` 里调用 `agentPresets.list()`，把
  `taskboard-dispatch`/`taskboard-worker` 的 `broken` 诊断放进 `Snapshot.preset`（15s 缓存，
  因为 `list()` 会重新审计挂载树）。
- 预设行激活是异步的，启动时读不到属于正常：apply 内最多重试 3 次（2.5s 间隔）再告警。
- `install-preset` 端点保留为兼容：只强制刷新状态，不做任何写入。

---

## 5. Client 半要求（两个看板）

同一个数据文件、两套视图：

| 视图 | 位置 | 范围 | 新建任务 |
| --- | --- | --- | --- |
| **本工作区看板** | 右侧栏 tab（`sidebarRightTabs` + `sidebar.right.pane.tab`）+ 会话 header 入口按钮 | `task.cwd === 当前会话工作区` **或** `task.sessionId === 当前会话` 的任务（后者兜住 cwd 为空的旧任务/早期任务，避免「任务凭空消失」）；另有「未绑定工作区的任务」提示指向平台看板 | 默认绑定当前对话/工作区（sessionId 交给宿主解析 cwd） |
| **任务看板（全部工作区）** | 左侧栏面板（`sidebar.panellist` + `main` 整页） | 全部任务（含 `cwd=null` 的老任务），每张卡带工作区 tag，可按工作区过滤 | **必须选工作区**（下拉来自 `snapshot.workspaces`），传 `cwd`、不传 sessionId |

两个视图共用同一套卡片/列组件与 RPC；左栏面板图标带 `todo+doing` 角标。

### 5.0 右栏集成契约（0.2.2-rc.1 实测）

| 用途 | API |
| --- | --- |
| 声明 tab 类型（静态） | `ctx.inject(['sidebarRightTabs'], s => s.effect(() => s.sidebarRightTabs.register({ id, kind, priority:'extension', title: () => string, guide:[…] })))` |
| tab 正文 | `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name:'sidebar.right.pane.tab', key: <定义 id> }, Body))`；`Body` 收到 slot 级 `useTabInfo` prop |
| tab chip | `sidebar.right.pane.tab.title` 同 key 注册；不注册则用打开时捕获的标题 |
| 打开 tab | `ctx.inject(['sidebarRight'], s => handle = s.sidebarRight)` → `handle.openTab(kind)` |
| 会话 header 入口 | `ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name:'conversation.session.header.actions', id:'taskboard', order:40, label }, HeaderAction))`（list 槽） |

- 本插件：`TAB_TYPE_ID='dsh-taskboard'`（= tab 系统身份，也是正文/title 的 key），`TAB_KIND='taskboard'`（openTab 参数）。
- `useTabInfo()` 返回 `{ sidebar:{expanded, fullscreen}, panel:{id,isFloating}, tab:{title,visible,navigation,actions,…} }`。
- 右栏服务缺失时（非 web-app 部署）插件不崩：header 按钮保留但点击只在 console 警告，body/title 注册由 `slots.inject` 自然等待。
- 引导页入口：类型的 `guide` 数组给右栏引导页贡献一张卡片（`{ id, order, title, description, icon }`），
  点它即 `openTab(kind)`。

### 5.1 槽位汇总

| 槽位 | 注册参数 | 内容 |
| --- | --- | --- |
| `conversation.session.header.actions` | `{ name, id:'taskboard', order:40, label: () => t('panel.label') }` | 会话 header 右侧的看板按钮（`.tb-headbtn`），带本工作区 `todo` 数量角标（`.tb-badge`，>99 显示 99+，6s 刷新） |
| `sidebar.right.pane.tab` | `{ name, key:'dsh-taskboard' }` | 本工作区看板正文 `BoardTab` |
| `sidebar.right.pane.tab.title` | `{ name, key:'dsh-taskboard' }` | chip：看板 glyph + 标题 |
| `sidebar.panellist` | `{ name:'sidebar.panellist', id:'taskboard-platform', order:25, label: () => t('platform.label'), locale }` | 左侧栏「任务看板」图标（全部工作区），带 `todo+doing` 角标 |
| `main` | `{ name:'main', key:'taskboard-platform', locale }` | 平台任务看板整页 `PlatformBoard` |

> `label` 必须是 thunk（`string | (() => string)`），语言切换后无需重注册。

### 5.1.1 平台看板页（`main`）

自上而下：

1. **头部**：标题「任务看板」+ 副标题（`共 N 条 · 轮询状态`）+ 立即刷新 + 轮询开关 + 间隔选择 +
   一键归档已完成；preset 异常 banner；页脚（数据文件路径 + 版本）。
2. **新建行**：标题输入（Enter 提交）+ 备注展开 + **工作区选择（必选）**：
   下拉 `placeholder = 选择工作区`，options 来自 `snapshot.workspaces`（title，空则路径尾段）；
   未选时「添加到待开始」禁用并提示「先选择任务所属的工作区」。提交 `add-task {title, note?, cwd: 工作区 path}`。
3. **工作区过滤**：`全部工作区`（默认）/ 单个工作区——只影响显示。
4. **四列看板**：复用 `Col`（宽度足够时四列），卡片带「工作区 X」tag；`cwd=null` 的老任务也显示（无 tag）。
5. **空态**：「没有任务。选个工作区加一条，主 Agent 会自动接手。」

派发：平台任务带 `cwd`，宿主优先找同工作区的空闲会话（`workspace-session`），找不到就等
（`workspace-offline` / `workspace-busy`），手动「立即派发」才允许改派。

### 5.2 右栏看板布局

| 条件 | 布局 |
| --- | --- |
| `useTabInfo().sidebar.fullscreen === true` 或实测宽度 ≥ **900px** | 四列网格 `.tb-board`（待开始/进行中/已完成/已归档 横排） |
| 宽度 560–900px | 两列网格 `.tb-board[data-layout="medium"]`（2×2） |
| 更窄（普通右栏） | 纵向 lane `.tb-lanes`：四个状态区块依次堆叠，根节点 `data-layout="narrow"` |

宽度用 `ResizeObserver` 量（`ResizeObserver` 不可用时按窄栏渲染，测试环境即此路径）。
窄栏下隐藏：footer 的数据路径/说明（只留版本号）、轮询间隔标签、上次派发信息（`.tb-optional`）。

自上而下内容（两种布局共用）：

1. **头部**：标题「任务看板」+ 副标题（轮询状态：`每 15s 轮询 · 上次 12:03:11` 或 `轮询已暂停`）+
   「立即刷新」按钮 + 轮询开关 + 间隔选择（5s/15s/30s/60s）。
   - `Snapshot.preset.broken` 非空 → 红色 banner 显示挂载诊断；
   - `Snapshot.preset.installed === false` → 黄色 banner 显示原因（没有 agentPresets 服务 / 名单里没有本模式）。
2. **新建任务行**：输入框（Enter 提交）+ 备注展开（可选）+ 「添加到待开始」按钮；
   下方一行只有「加备注」链接和一句提示——**没有「派发给」选择器**（派发全自动，产品决策）：
   - 本会话在 `agents[]` 里能查到 cwd（或 `session-info` 兜底）→ 「…任务会回到本对话执行（工作区：name）。」
   - 查不到（冷会话/历史会话）→ 挂载时调一次 `session-info` 拿 cwd，同样显示工作区；
   - 实在拿不到 → 通用文案「…你只管加任务和看结论。」
   新建时把 `props.sessionId` 一并交给 `add-task`，决定这条任务的归属。
3. **看板主体**（布局见上）：待开始（蓝）/ 进行中（黄）/ 已完成（绿）/ 已归档（灰）。
   - 每块头部：列名 + 计数 + 快捷动作（待开始：`全部派发`；已完成：`全部归档`）。
   - 卡片：标题（可点，打开**任务详情浮层**）、备注（两行截断）、`#t-3`、工作区 tag（`task.cwd` 尾段）、
     相对时间、assignee、result 预览（单行截断，完整版看详情）、
     `lastError`（红色小字，状态变更时自动清空）。
   - 卡片动作（按状态）：
     - todo：`开始`（→doing）、`立即派发`（`dispatch-now`）、`编辑`、`删除`
     - doing：`完成`（→done）、`打回`（→todo）、`编辑`
     - done：`归档`（→archived）、`返工`（→doing）
     - archived：`重新打开`（→todo）、`删除`
   - 编辑用行内表单（标题 + 备注），保存调 `update-task`。
   - **跳到关联对话**：卡片动作里「对话」（`task.dispatchedSessionId` 优先，其次 `task.sessionId`）；
     详情浮层「关联对话」区块里分别有「发起对话 · <尾8>」与「执行对话 · <尾8>」按钮。
     点击调用客户端服务 `ctx.get('uiWorkspace').openSession(sessionId)`（官方导航 API，同步 void），
     服务缺失/会话不存在时只 console.warn 不崩。宿主在投递时把 `dispatchedSessionId` / Title 记到任务上。
     老版本 Host 派发的进行中任务没有这个字段时，client 用 `snapshot.poll.lastDispatchSessionId` 兜底：
     仅当 `poll.lastDispatchTaskId` 命中该任务、或全局只有一条 `doing` 任务时才显示「执行对话」（避免张冠李戴）。
   - **任务详情浮层**（`Detail`，两块看板共用）：点卡片标题或「详情」按钮打开，展示完整标题 / 状态 /
     工作区 / 创建·开始·完成·归档时间 / 执行者 / 创建来源 / 提醒次数 / 任务 id / 完整备注 /
     完整结论（含 done 但没写结论时的提示）/ 最近错误，并提供按状态的主操作（开始 / 完成 / 归档 / 重新打开）
     与关闭；点遮罩或 × 关闭。
   - 空块显示空态文案（如「没有待开始的任务。加一条，主 Agent 会自动派发。」）。
4. **页脚**：宽栏显示数据文件路径 + 「看板数据存储在本机」 + 版本号；窄栏只显示版本号。

### 5.3 数据与交互

- 挂载后立即 `snapshot`，之后每 **2000ms** 轮询一次（页面不可见时 `document.visibilityState!=='visible'`
  降频到 10s；卸载清理）。轮询失败保留旧数据，头部显示小错误条，连续 5 次失败显示「连接断开，重试中」。
- `revision` 未变化时跳过重渲染（用 `useSyncExternalStore` 或本地 `useState` + 浅比较均可，
  实现自选，但必须避免 2s 一次的全树重建）。
- 所有写操作：乐观更新不做，等 RPC 返回后用返回值替换该任务（简单、无回滚逻辑）。
- 键盘可达：按钮有 focus ring；新建输入 Enter 提交、Esc 清空；编辑表单 Enter 保存、Esc 取消。
- i18n：`ctx.get('locale')` 注册 `taskboard` 命名空间，zh/en 两套；locale 不可用则内置中文。

### 5.4 样式

- 只用 `--dsw-*` 主题变量（背景/边框/文字/圆角/字号/状态色），亮暗主题自动成立；
  状态强调色用 `--dsw-alias-state-*`；唯一允许的硬编码色是列头小圆点（4 个状态的固定色，
  见 `docs/client-notes.md` 的调色板建议）。
- CSS 通过 `<style data-plugin-css="dsh-taskboard/client.css">` 幂等注入一次。

---

## 6. 预设（模式）要求

- 文件：`presets/taskboard.patch.yml`，`package.json` 的 `dsh.bundle.patch` 是数组：
  `["./cordis.patch.yml", "./presets/taskboard.patch.yml"]`。
- 两个声明行（`@deepseek-ai/dsh-agent-preset`）：
  - `taskboard-dispatch`（order 40）：persona（派单口径）+ agent-instructions + time-context +
    **只读** tool-fs（read/readImage=true，write/edit/applyPatch=false）+ tool-fs-search + tool-jobs +
    planning(realm: planMode，**必须给非空 section**) + compaction(realm) +
    delegation(realm: workflowEngine) = tool-subagent-control + tool-subagent(spawn, agentPreset=taskboard-worker, maxDepth=1) +
    tool-ask-user + tool-todo(**必须给 allowParallelInProgress**) + present。
  - `taskboard-worker`（order 41）：worker persona + agent-instructions + time-context + bash/pwsh（按平台 disabled）+
    完整 tool-fs + tool-fs-search + tool-jobs + skill-filesystem + tool-skill + compaction + tool-ask-user +
    tool-todo(allowParallelInProgress) + tool-web + present。**不含**任何委派工具。
- persona 必须写清：
  1. 主 Agent 不自己写文件/跑命令/做调查，一切派给子 Agent（连审核要跑命令也派验证子 Agent）；
  2. 收到【任务看板】通知 → 先 `taskboard_update` 置 `doing` → 派发 `subagent` → 结束本轮；
  3. 子 Agent 回报 → 审核（对工作区取证，不看摘要）→ 通过则 `taskboard_update status=done result=…` 并一句话汇报；
     不通过则 `send_message` 打回重做，`doing` 不变；
  4. 用户对话优先于看板；5) 结束本轮是常态，不要在轮内等或轮询。
- 不在预设里写死 `agentOptions.provider/model`（可移植性）：子 Agent 继承主 Agent 路由。
- 已知坑（都已在 patch 里修掉，改预设时别踩）：`dsh-plan-mode` 的 `section` 必填；
  `dsh-tool-todo` 的 `allowParallelInProgress` 必填；`tool-subagent` 的 `persona/toolFilter/backgroundMode`
  字段在 0.2.2 已移除（用 `agentPreset` 替代）；`dsh-tool-subagent-control/list-agents` 子路径已不存在。

---

## 7. 验证清单

1. `node --check lib/index.js`、`node --check lib/client.js`、`node --test` 全绿。
2. 安装到测试 profile（`dsh plugin --profile taskboard add C:\Users\duan\Code\dsh-taskboard`），
   `dsh --profile taskboard --port 3099 --no-open` 起服务，无启动报错；启动日志出现
   `[taskboard] 派单模式已就绪：派单看板模式(taskboard-dispatch) / …·执行者(taskboard-worker)`。
3. HTTP 探针（`.dev/verify-rpc.mjs <baseUrl>`）：snapshot / add-task / update-task / dispatch-now /
   set-config / archive-done / install-preset 全通；错误分支（bad id、非法 status、空 title）返回对应错误码。
4. Playwright（右侧栏）：会话 header 出现「任务看板」按钮（带角标）→ 点击 → 右栏打开看板 tab →
   窄栏四个纵向 lane 渲染 → 加任务出现在待开始 → 切换轮询开关/间隔 → 编辑/开始/完成/归档/删除各走一遍 →
   全屏/加宽到 ≥680px 切四列 → 刷新页面状态保持 → 左侧菜单没有看板项。
5. 端到端派单（真实模型，验证核心价值）：任务加进待开始 → 轮询投递 → 主 Agent 改 doing 并派子 Agent →
   子 Agent 完成后主 Agent 审核并把任务改成 done → 看板显示 result。**这是本插件唯一不可省的验收项。**
6. 预设：`Snapshot.preset.installed === true` 且两个模式 `broken` 为空；模式选择器出现
   「派单看板模式」与「派单看板模式 · 执行者」；选中派单模式后对话一轮，确认主 Agent 只派发不自己干活，
   且子 Agent 实际能读写文件（worker preset 生效）。
7. 安全：RPC 只回 loopback；无绝对路径泄漏出 `boardPath`（允许，本机工具）。

---

## 8. 已知风险 / 待验证

| 风险 | 缓解 |
| --- | --- |
| 右栏 tab 契约（tab 类型/keyed 正文/`useTabInfo`）与官方示例不一致 | 已从安装包源码取证（`sidebar-right/lib/types/client/*`、`sidebar-right` 自身与 `ui-deliverables`/`ui-sidebar-files` 的注册实现），e2e 用真实页面复核 |
| 用户环境没启用右侧栏（非 web-app 部署 / 关闭了 ui-sidebar-right） | 服务缺失时插件不崩：header 按钮点击只在 console 警告；body 注册由 slots.inject 等待 |
| 创建任务的对话是历史会话（无 live agent），且被 UI 持有 writer 无法唤醒 | 任务留在待开始并显示 `creator-cold` 原因；用户在那边发条消息即可回派；手动「立即派发」是唯一逃生口 |
| 第三方 bundle 声明 preset 的行为与官方是否一致（无官方先例） | 已在 0.2.2-rc.1 实测：两条声明行都出现在 `agentPresets.list()`，`broken` 为空；`dsh --dump-config` 可见两行 |
| `agent.followup()` 的 UserMessage 手工构造被会话解码器拒绝（source.kind 未知） | 用 `{kind:'user'}` 构造，不发明新 kind；e2e 必须验证「重启后会话可恢复」 |
| 轮询把用户手动对话打断 | 只在 idle 投递；每轮最多 1 条；冷却 + 上限 |
| 多窗口/多会话重复派发 | 任务级 `notifiedAt` + 冷却 + `notificationCount` 上限；不做跨进程锁（单进程部署） |
| 卡片按钮「点了没反应」（归档/删除/开始/完成全失效） | 0.1.0 修过一个真实 bug：双看板重构时局部数组变量 `actions` 遮蔽了 `bind.actions`，按钮回调里 `actions.updateTask` 全是 undefined，点击直接抛异常。UI 级回归必须**真点按钮**，且点完重新查询节点再点第二次 |
| **两个 dsh 进程共用同一个 board.json**（例如同时开着正式实例和测试实例） | 每个 RPC/tick 前 `reloadBoardIfStale`：盘上 revision 更大就采用盘上状态（读也重载，否则界面显示旧内存、点归档像没生效）；测试实例用 `DSH_TASKBOARD_PATH` 指向自己的 board.json 彻底隔离。**这不是真正的并发锁**，两个进程同一毫秒写仍可能丢一次更新 |

---

## 9. 变更记录

- v0.1.0（首个版本）：看板 + 轮询派单 + 两个模式声明（dispatch / worker）+ 三个模型工具。
  预设机制已按 0.2.2 的 bundle-patch 声明式实现（`presets/taskboard.patch.yml`），不再写
  `$DSH_HOME/.agent-presets` 目录。
- v0.1.0 修订（冷会话兜底）：`session-info` 端点 + `sessionQuery` 解析冷会话 cwd；派发前尝试
  `sessionController.resolveAgent` 唤醒创建者，唤醒不了就停在待开始（`creator-cold`）不改派，
  只有「立即派发」是逃生口。
- v0.1.0 修订（工作区绑定）：任务在右栏创建时记录 `sessionId`/工作区，轮询优先派回创建它的对话
  （忙则等、关掉才退化）；一次轮询逐条试候选，忙会话不再挡住整列；卡片显示工作区 tag。
- v0.1.0 修订：看板从左侧面板（`sidebar.panellist` + `main`）迁到**右侧栏 tab**
  （`sidebarRightTabs` + `sidebar.right.pane.tab`），入口按钮放会话 header；窄栏纵向 lane、
  宽栏/全屏四列；左侧菜单不再有看板项。
