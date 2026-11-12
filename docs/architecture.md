# dsh-dispatch-board — 内部契约 v1（Host ⇄ Client ⇄ Preset 单一事实来源）

本文件是 Host 半（`lib/index.js`）、Client 半（`lib/client.js`）与预设声明
（`presets/taskboard.patch.yml`）之间的**唯一契约**。任何一方想改字段/端点/状态机，先改本文件，再改代码。
本文档当前描述 **v0.2.0「工作区组长模式」**：默认 `dispatchMode='workspace-lead'`，用户只与主会话对话，
每个工作区一个常驻工作区组长；旧模式 `new` / `creator` / `auto` 保留兼容（见 §1.7）。

- 插件包名（= Client bundle id）：`dsh-dispatch-board`
- 运行时内部标识保持 `taskboard`：存储 `~/.dsh/storages/dsh-taskboard/`、RPC `/taskboard`、右栏 tab 类型 `dsh-taskboard`、预设 `taskboard-dispatch`/`taskboard-worker`、工具 `taskboard_*`（改包名不影响老数据）
- RPC 通道前缀：`/taskboard`
- Host loader row id：`taskboard`
- 模式声明：`presets/taskboard.patch.yml`（bundle patch 里的两条 `@deepseek-ai/dsh-agent-preset` 行，
  id 分别是 `taskboard-dispatch` 与 `taskboard-worker`；0.2.2 起 preset **不是**目录）
- 目标运行时：dsh 0.2.2-rc.1（Web profile）
- 契约版本：v0.2.0（`board.json` 的 `version` 仍为 `1`，不因新增 config / 任务字段升版）

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

### 1.1 角色模型（v0.2.0 默认）

三个角色，各管一段；**看板是唯一事实源与汇报通道**，三方都只通过看板交换状态：

| 角色 | 是什么 | 职责 | 交互路径 |
| --- | --- | --- | --- |
| **主会话**（main session） | 用户正在用的**普通对话**，不绑定特殊预设 | 用全局 `taskboard_*` 工具加任务、查进度；收到完成回执后向用户汇总 | 用户 ⇄ 主会话 |
| **工作区组长**（workspace lead） | 每个工作区一个**常驻会话**，预设 `taskboard-dispatch` | 接收本工作区任务 → 置 `doing` → 派 worker → 审核 → 写回看板 | 插件轮询 → 组长 |
| **执行者**（worker） | 组长用 `subagent` 派出的子 Agent，预设 `taskboard-worker` | 后台干具体活（读写文件、跑命令），按模板回报 | 组长 ⇄ worker |

- 用户只和主会话对话；工作区组长**不直接面对用户**（用户也能在 UI 里打开它的会话，但正常汇报路径是看板 + 主会话）。
- 一个工作区最多一个组长会话，由 `config.workspaceLeads` 持久化映射、按需懒创建；**绝不**「每个任务新建一个会话」。
- 主会话绑定在 `config.mainSessionId`（UI「把当前对话设为主会话」→ `bind-main-session`，§3.1.1）；
  未绑定时不发完成回执，任务照样会被组长做完。
- 任务在哪个工作区，就投给哪个工作区的组长；跨工作区派活由主会话用 `taskboard_add` 的 `workspace` 参数指定（§4.4）。
- 旧模式（`new` / `creator` / `auto`）不使用组长，见 §1.7。

### 1.2 任务（Task）

一条看板任务。**四个状态，单向 + 可回退**：

| status | 中文列 | 含义 | 谁改成它 |
| --- | --- | --- | --- |
| `todo` | 待开始 | 用户 / 主会话 / 组长新建，尚未派发 | 用户新建；组长或主 Agent 打回重做 |
| `doing` | 进行中 | 已派发，worker 在干 | **宿主投递成功后自动置**（组长也可再调 `taskboard_update` 置 doing） |
| `done` | 已完成 | 组长（或旧模式主 Agent）审核通过 | 组长 `taskboard_update`；旧模式主 Agent 同 |
| `archived` | 已归档 | 用户 / 组长归档，不再参与轮询 | 用户点归档；组长 / 主 Agent `taskboard_update` |

合法迁移：`todo→doing`、`doing→done|todo`（打回）、`done→archived|doing`（返工）、
`archived→todo`（重新打开）。**轮询只扫 `todo`。**

**`needsUser`（v0.2.2，不新增 status）**：任务上有一个「等待用户回复」标记 `needsUser`（§1.9）。
它**不改变** `status`（仍为 `todo` / `doing`），但会让轮询跳过该任务，并在看板的「待你处理」区显示；
用户回答后宿主把回答 followup 给组长会话并清掉标记，任务继续。

**归档生命周期（30 分钟保留期）**：`archived` 任务在归档满 **30 分钟**后由宿主自动从看板删除
（从 `board.json` 的 `tasks[]` 移除），用户不必手动点「删除」。判定是纯函数
`pruneArchivedTasks(state, now, ARCHIVE_RETENTION_MS)`（`ARCHIVE_RETENTION_MS = 30 * 60 * 1000`，导出便于单测）：

1. 只处理 `status === 'archived'` 的任务；`todo` / `doing` / `done` 一律不动。
2. 归档时间优先 `archivedAt`，缺失 / 不可解析时回退 `updatedAt` → `createdAt`；三个字段都解析不出来
   则**保守保留**（宁可留一条，也不误删时间坏掉的任务）。
3. `now - 归档时间 >= 30 分钟` 即删除（满 30 分钟，边界即删）。
4. 删除后 `revision` +1（走 `commitBoard` 落盘）；`nextId` **不回退**——已删除任务的 id 不复用，
   避免旧引用指到新任务上。
5. 清理时机：每次 tick 在 `pollEnabled` 判断**之前**（暂停轮询时照常清理，§1.4），
   以及插件 `apply()` 启动时清理一次（宿主停机期间到期的归档不必等第一个 tick）。
   没有任务过期时不写盘、不改 `revision`。
6. 删除是**物理删除**：之后按该 id 调 `update-task` / 模型工具会得到 `not-found`（任务已不在看板上）。

### 1.3 派单闭环（本插件存在的理由）

v0.2.0 默认链路（`dispatchMode='workspace-lead'`）：

1. 用户对**主会话**说需求；主会话用 `taskboard_add` 加任务（跨工作区时带 `workspace`），
   或在右侧栏看板 / 平台看板手动加。任务归属一个工作区（`task.cwd`）。
2. Host 轮询器每 `pollIntervalMs` 扫 `todo`：按任务工作区解析 key，查 `config.workspaceLeads`
   复用该工作区的常驻组长；没有就懒创建（`sessionController.create({workspaceId?, cwd?, agentPreset:'taskboard-dispatch'})`）。
   组长空闲 → 用 `agent.followup()` 推一条「【任务看板 · 待开始】…」的用户消息（`source.kind='user'`），
   给任务打 `notifiedAt` 并**自动置 `doing`**。路由细节见 §1.5。
3. 工作区组长收到后：`subagent` 派一个 `taskboard-worker` 子 Agent 后台执行（prompt 带任务 id / 标题 /
   备注（验收标准）/ 工作目录 / 回报模板），然后结束本轮，**不自己干活**。
4. 子 Agent 干完 → 运行时把完成通知送回组长 → 组长开新一轮审核（对工作区取证）：
   - 通过：`taskboard_update status=done result=<Markdown 结论>`；
   - 不通过：`send_message` 打回同一个 worker 重做（任务保持 `doing`），或回退 `todo` 重新排队。
5. 任务 `done` 且 `reportedAt=null` → Host 把一批未汇报的完成任务合并成一条
   「【任务看板 · 汇报】…」followup 投给**主会话**（要求主会话 live 且 idle），成功后在每条任务上写 `reportedAt`（§1.6）。
6. 主会话收到回执 → 向用户汇总（不再执行任务本身）；主会话忙则等下一轮 / 下次 flush，不丢回执。
7. 用户在看板归档（`archived`），闭环结束；归档任务不参与轮询。

旧模式（`new` / `creator` / `auto`，§1.7）没有组长这一跳：通知直接投给主 Agent / 创建会话 / 任意空闲会话，
由那个会话自己派子 Agent 并写回看板；完成回执同样适用（回执只依赖主会话绑定，不依赖 `dispatchMode`）。

**旁路入口（用户直接对组长说话）**：用户也可以打开工作区组长会话，直接要求它派活（不经过轮询投递）。
这种情况下看板上本来没有任务，闭环会断；宿主因此加了「组长 `subagent` 派发即自动建任务」的挂钩，
见 §1.8。

### 1.4 轮询器的边界

- 只在**目标 Agent 空闲**（`agent.status === 'idle'`）时投递；运行中不打扰（下次轮询再试）。
  workspace-lead 模式下目标 Agent = 该工作区的组长；旧模式 = §1.7 解析出的会话。
  **投递成功即自动把任务置为 `doing`**（写 `startedAt`、清 `lastError`）：看板立刻反映「已派发」，
  不再依赖组长 / 主 Agent 记得调 `taskboard_update`（再调一次 doing 也合法）。
- **`needsUser` 任务不投递**（v0.2.2，§1.9）：`selectDispatchCandidates` / tick 过滤
  `needsUser === true` 的任务——问题没回答前不重复派发、也不占用「每轮 1 条」的派发名额；
  `dispatch-now` 显式指向这类任务直接 `conflict`。回答后标记清除，任务照常回到候选列表。
- 每个任务同一时刻最多一条未失效通知：`notifiedAt` 之后 `min(2×intervalMs, 120s)` 内不重复投递；
  超过冷却且仍未变化则重投（`notificationCount++`），`notificationCount >= 5` 后停手：任务留在 `todo`、
  不再自动投递（卡片与详情浮层都没有「派发超时」标记，需人工处理）。
- **每轮全局最多投递 1 条**：所有工作区共用一个 tick；多个工作区都有待派任务时按候选顺序逐条试，
  第一条投递成功即结束本轮（下一个工作区下一轮再服务）。
- **workspace-lead 模式的失败分支**：组长忙 → 任务留 `todo`、写 `lastError` 并试下一条候选；
  组长离线 / 唤醒失败 → 跳过并写「工作区组长不可用」；**绝不**新建「每任务一个」会话，也绝不跨工作区改派（§1.5）。
- 完成回执与派发共用 tick：每次 tick 末尾都尝试 flush 一次完成回执（§1.6）；回执投递不占用派发名额。
- `pollEnabled=false` 时**派发完全停止**（UI 顶部开关）；`dispatch-now`（立即派发）不受轮询开关与冷却限制。
- **完成回执 flush 不受 `pollEnabled` 限制**：tick 末尾仍会尝试 flush（§1.6）——回执是汇报不是派发，
  只在主会话已绑定、live 且 idle 时真正发送；未绑定 / 离线 / 忙时是 no-op（不抛错、不写 `lastError`）。
  这样暂停派发期间已经 done 的任务仍能汇总给用户。
- **归档清理也不受 `pollEnabled` 限制**：tick 在任何派发判断**之前**先跑 `pruneArchivedTasks()`
  （归档满 30 分钟自动删除，§1.2），有删除才落盘并 `revision` +1；轮询暂停时归档照样按时消失。

### 1.5 工作区组长路由（`dispatchMode='workspace-lead'`）

v0.2.0 的默认派发方式。目标不是「某个会话」，而是**任务所属工作区的常驻组长**（§1.1）。

1. **候选顺序**：沿用 §1.4 的候选选择（`todo`、提醒次数未达上限、冷却外、按 `createdAt` / id 排序）；
   逐个候选试路由，**一旦投递成功即结束本轮**（每轮全局最多 1 条）。
2. **解析任务工作区**：`task.cwd` 优先；缺省用创建会话的 cwd 兜底（`task.sessionId` → live agent
   `header.cwd` / live session `header.cwd` / `sessionQuery.listSessions()`）。解析出的 cwd 写回 `task.cwd`。
   仍解析不到 → 跳过并写 `lastError`（下表 `lead-no-workspace`）。
3. **计算工作区 key**：`workspaceIdForCwd(ctx, cwd)` 命中（`workspaceRegistry.list()` 的 path 归一化比较）时
   用工作区 id；否则用 `normalizePathForCompare(cwd)`。key 同时是 `config.workspaceLeads` 的键与
   `snapshot.leads.workspaces[].key`。
4. **复用已有组长**：`config.workspaceLeads[key]` 存在 → 取 `sessionId`：
   - `agents.get(sessionId)` 拿到 live agent 且 `status === 'idle'` → 投递；
   - live agent 但 `status === 'running'` → 跳过该任务（保持 `todo`、写 `lastError`、
     `poll.lastSkipReason='lead-busy'`），继续试下一条候选；
   - 没有 live agent → 尝试 `sessionController.resolveAgent(sessionId)` 唤醒：成功则按上一条判忙闲；
     失败 → 跳过（`lead-unavailable`）。**tick 里不自动重建已有映射**，修复走 `ensure-workspace-lead`（§3.1.1）。
5. **懒创建**：没有映射 → 先算 `workspaceId = workspaceIdForCwd(cwd)`，非空时
   `sessionController.create({workspaceId, agentPreset:'taskboard-dispatch'})`；**这次 create 抛错**
   （例如工作区创建被拒）就退回 `{cwd, agentPreset:'taskboard-dispatch'}` 再 create 一次；解析不到
   workspaceId 时直接按 `{cwd}` create。**两次 create 都失败、`sessionController` 不可用或拿不到
   `sessionId`** → 跳过（`lead-unavailable`），不写映射、不丢任务。
   拿到 `sessionId` 后**先尝试 `resolveAgent(sessionId)` 取 live Agent，再写映射**：
   `{sessionId,title,cwd,createdAt}` 写进 `config.workspaceLeads[key]` 并 `commitBoard`——
   `title` 取 live Agent 的会话标题，**取不到 Agent 时写 `''` 也照样写映射**（超过 32 条时按 §2
   的运行时淘汰规则，新映射不会被立刻截断）。
   - 创建后立刻拿到 live agent → 按第 4 步判忙闲投递；
   - **拿到 sessionId 但 live agent 尚未物化**（新建会话的 live agent 是异步出现的）→ 本轮记
     `lead-unavailable` 跳过，但**映射已写入（title=''）**；下一轮按第 4 步复用该 sessionId 并尝试
     `resolveAgent` 唤醒，**不会重复创建组长**。`ensure-workspace-lead` 遇到同样情况返回
     `LeadRef{live:false}`，**不算 `internal`**（`internal` 仅限 `sessionController` 不可用 /
     两次 `create` 都失败 / 连 `sessionId` 都没拿到）。
6. **投递**：与旧模式相同，`agent.followup(createBoardUserMessage(buildDispatchText(task)))` + `sessions.flush`；
   成功后任务自动置 `doing`（写 `startedAt`）、`notifiedAt` / `notificationCount++`、记录
   `dispatchedSessionId` / `dispatchedSessionTitle`、清 `lastError`、更新 `poll.lastDispatch*`；
   `followup` 失败 → `followup-failed`，任务保持 `todo`。
7. **绝不**在 workspace-lead 模式下调用「每任务新建会话」的旧 `new` 逻辑（`createDispatchSession`），
   也**绝不**把任务投到别的组长的会话里。
8. **`dispatch-now`（立即派发）**：仍按本路由；`force:true` 时组长忙也把消息排进它的下一轮（任务照常置
   `doing` 并记账），与旧模式对 `creator-busy` 的 force 语义一致；组长离线时仍先尝试唤醒，
   唤醒失败返回 `{dispatched:false, reason:'lead-unavailable'}`，不改派别的工区。
9. **跳过原因与提示**（`poll.lastSkipReason` / `task.lastError`；Client 用 `poll.skip.<reason>` 做 i18n）：

| reason | 场景 | `lastError` 文案（宿主写入，详情浮层「最近错误」显示） |
| --- | --- | --- |
| `lead-busy` | 组长会话正在跑 | `工作区组长正在运行，等它空下来再派` |
| `lead-unavailable` | 组长离线 / 唤醒失败 / 创建失败 | `工作区组长不可用：稍后重试，或在看板点「创建组长」` |
| `lead-no-workspace` | 任务解析不出工作区 | `无法解析任务的工作区：请从目标工作区的会话里重新加这条任务` |

> 提醒次数、冷却、提醒上限沿用 §1.4；`notificationCount` 在投递成功后累加，与旧模式一致。

10. **组长会话被归档（归档兜底）**：若 `config.workspaceLeads[key]` 指向的会话出现在
    `workspaceRegistry.archivedSessionIds` 里（用户把组长会话归档了），归档门会拒绝它跑模型步进，
    tick **视为失效映射**：删除该映射、把 `dispatchedSessionId` 等于该会话且仍为 `doing` 的任务
    重排回 `todo`（清 `startedAt`/`notifiedAt`/`notificationCount`/`assignee`/`dispatchedSession*`，
    写 `lastError`「工作区组长会话已归档，任务已重新排队，将投给新的组长」），然后**本轮直接走懒创建**
    换一个新组长。**绝不 unarchive**（尊重用户的归档动作）。`ensure-workspace-lead` 对归档映射做同样的
    修复替换；组长条对归档会话显示「已归档」并提供「创建组长」按钮（§5.5）。

### 1.6 完成回执（主会话汇报）

任务完成后由宿主主动把结论推给**主会话**（`config.mainSessionId`），主会话负责向用户汇总。
它与 `dispatchMode` 无关：只要绑定了主会话、任务进入 `done` 且未汇报，就会发。

- **任务字段**：`reportedAt: string|null`（ISO 时间；`null` = 尚未推送回执）。UI / 快照可见，
  **绝不进工具输出 `taskBrief`**（§4.4 封闭 schema 硬规则）。
- **候选**：`status === 'done' && reportedAt === null`；按 `updatedAt` 升序（相同按 id 数字序），
  **每批最多 10 条**，其余下一轮。
- **前置条件**：`config.mainSessionId` 非空；主会话**未被归档**（不在 `workspaceRegistry.archivedSessionIds`
  里——归档门会拒绝它跑模型步进）；`agents.get(mainSessionId)` 拿得到 live agent；
  `agent.status === 'idle'`。主会话离线或忙 → 本轮不发、不主动唤醒，任务保持 `reportedAt=null`；
  主会话被归档 → 返回 `{sent:false, reason:'main-archived'}`，不投递、不记账；未绑定主会话 → 不发
  （用户可自己看板 / 问主会话）。`snapshot.leads.main.archived=true`，组长条显示「已归档」并提示换绑。
- **投递**：合并成**一条** `agent.followup()` 用户消息（`source.kind='user'`），随后 `sessions.flush`。
  文本以 `【任务看板 · 汇报】` 开头，逐条 `- <id> <title>：<result 压成单行后的前 200 字，空结论写「（无结论）」>`，
  结尾要求主会话「向用户汇总以上结论，不要重复执行任务」，并附 `看板时间：<ISO>`。
- **记账**：`followup` 成功后，给本批每条任务写 `reportedAt=iso(now)` 并 `commitBoard` 一次；
  投递失败只 `console.warn`，不写 `reportedAt`，下一轮重试。
- **flush 时机**：每次 tick 末尾、`update-task` RPC 之后、`taskboard_update` 工具执行之后（同一 flush 函数）；
  `bind-main-session` / `clear-main-session` 之后不必立即 flush，等到上述时机即可。
- **重置（精确规则）**：只要任务**离开过 `done`** 就置 `reportedAt=null`——`done→doing`、`done→todo`，
  以及 `done→archived→todo`（`archived→todo` 时清空）。这样「再次 `done` 时 `reportedAt` 必为 `null`」，
  不会漏发回执。`done→archived` 本身不改 `reportedAt`（归档不重发历史回执）。
- **只由宿主维护**：`reportedAt` **不是** `taskboard_update` / `update-task` 的可 patch 字段，
  客户端与模型都不能直接改；只由宿主的状态迁移（上面的重置规则）和回执 flush（写时间戳）维护。

### 1.7 目标 Agent 解析（兼容模式 `new` / `creator` / `auto`）

`dispatchMode` 取 `workspace-lead`（默认）时走 §1.5；取以下兼容模式时按本节的旧路由解析目标 Agent
（看板顶部「派发到」可选全部四个值）：

| 模式 | 行为 |
| --- | --- |
| `workspace-lead`（默认，v0.2.0 起） | 不使用主 Agent 路由；按任务工作区分派给该工作区的常驻组长会话（§1.5） |
| `new` | 在任务所属工作区**新建一个派单模式的对话**，任务投给它——不会挤进别人的对话。创建时先用 `workspaceIdForCwd` 把 cwd 映射成工作区 id，走 `sessionController.create({workspaceId, agentPreset:'taskboard-dispatch'})`，**新对话会落在那条工作区的分组里**（而不是「未分组」）；映射不到工作区时退回 `{cwd}`。**旧模式下每个任务可能新建一个会话，与工作区组长模式互斥** |
| `creator` | 派回**创建它的那个对话**（忙则等、冷会话尝试唤醒、唤醒不了就等） |
| `auto` | 忽略创建者，按「同工作区空闲 → 派单模式空闲 → 任意空闲」挑一个会话 |

旧模式下：`new` 模式失败（没有 sessionController、解析不到工作区、工作区创建被拒、预设不可用）会自动退回 `auto` 的挑法，不丢任务。
创建成功时还会把 `task.dispatchedSessionId` / `dispatchedSessionTitle` 记到任务上（详情里「组长对话」直接跳过去）。

旧模式下，任务同时**绑定创建它的对话与工作区**。解析顺序：

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
`cwd` 会写进派发文本的「工作目录」一行，也是详情浮层「工作区」字段与工作区过滤的依据。

注意：子 Agent 不是 root，`roots()` 天然不含它们，不需要额外过滤。

### 1.8 组长直聊派活 → 自动建看板任务（v0.2.0 补充）

§1.3 的闭环靠轮询投递启动；但用户也可以**直接打开工作区组长会话**要求它派活（「把 X 改成 Y」），
组长直接 `subagent` 派 worker——此时看板上没有任何任务，用户看不到进度、主会话也收不到回执。
v0.2.0 起宿主把这种派发**自动补成一条看板任务**，仍走同一个看板 / 回执通道。

**挂钩点（两条，都是事件监听，不改任何工具定义）**

| 事件 | 来源 | 用途 |
| --- | --- | --- |
| `tools/result` | `@deepseek-ai/dsh-tools` 管线在每次工具调用结束后广播的**观察事件**（emit，监听器异常被宿主隔离） | 识别「组长成功派出了 worker」→ 建任务 |
| `subagent/end` | `@deepseek-ai/dsh-subagent` 生命周期事件（`{runId, provider, id, local, stopReason, lastAssistantMessage}`） | worker 结束 → 给**带标记的自动任务**写回 `done` + `result`（轮询任务交给组长审核） |

- 监听器以 `{ global: true }` 注册：不受 scope 过滤（`tools/result` 的 carrier 按调用 Agent 过滤），
  宿主插件自身在 handler 里先按预设过滤，不会误伤别的 Agent。
- **标准 tool-call 与 PTC 完全等价**：PTC（`run_code`）的程序化子调用走的是同一个
  `ToolExecutionPipeline`（`executor.dispatch(prepared.exec)` → `tools/pre-execute` / `tools/execute` /
  `tools/post-execute` / `tools/result`），因此两种模式下这条钩子命中方式一致。
- **不覆盖**：绕过 tools 管线、直接调用 `ctx.subagents.startActivation()` 的第三方插件；以及
  非 `spawn` 的 provider 若改了工具输出形状（`result.value.subagentId` 不再是字符串）。

**命中条件**

1. `tools/result`：`result.isError !== true`、`exec.name === 'subagent'`，且 `result.value` 是
   `{kind:'activation', subagentId}`（`kind` 必须严格等于 `'activation'`，`subagentId` 必须是非空字符串）。
   三个条件缺一不可：别的工具即使返回值里带 `subagentId` 也不命中。`exec.agent` 必须存在，且它的预设是
   `taskboard-dispatch`（`agentPresets.presetForSession(agent.session)` 投影，取不到退回
   `session.header.agentPreset`）。**只有工作区组长触发的派发会建任务**，普通会话（含主会话）派子 Agent
   不会污染看板。
2. `subagent/end`：按 `assignee === info.id` **且 `task.autoDispatch === 'lead-dispatch'`** 找回任务；
   找不到（或那条任务没有标记）就是无关子 Agent，直接忽略。典型的两类无关结束：
   组长审核时派去跑命令的验证子 Agent、**轮询投递任务的 worker**——后者是组长审核的范围，宿主绝不
   替组长置 `done`（否则组长来不及取证，也无法打回）。

**建任务字段**（`source='agent'`，直接落 `doing`）

| 字段 | 取值 |
| --- | --- |
| `title` | `subagent` 入参的 `description`；为空取 `prompt` 第一行（去掉行首 `# > - *`）；仍为空用 `worker <worker 会话 id 尾 8>` |
| `note` | `prompt` 原文（截 4000 字符），详情浮层能看到实际派了什么活 |
| `cwd` | 组长会话的 `session.header.cwd`（= 当前工作区）；取不到用 sessions 服务兜底，再取不到用 `subagent` 入参的 `cwd`。命中 `workspaceRegistry` 时用注册表里的规范 `path`（`workspaceIdForCwd` → `workspacePathForCwd`，看板工作区过滤与注册表一致） |
| `status` | `doing`（`startedAt` = 建任务时间；自动任务不参与轮询——轮询只扫 `todo`——`notifiedAt` 保持 `null`，`notificationCount` 为 `0`） |
| `assignee` | worker 会话 id（`subagentId`）——详情浮层「执行者」 |
| `sessionId` / `dispatchedSessionId` | 组长会话 id（「发起对话」/「组长对话」都指向它；真正执行的 worker 会话 id 另记在 `assignee`） |
| `dispatchedSessionTitle` | 组长会话标题 |
| `autoDispatch` | 持久化标记 `'lead-dispatch'`（§2）：**只有带这个标记的任务**才会被 `subagent/end` 自动置 `done`。任务回到 `todo`（人工 / 组长打回、组长归档重排）时清空——重新排队后由轮询投递、归组长审核，不再算「宿主自动任务」 |

**去重（同一 worker 只建一条）**

1. 已存在 `assignee === <worker 会话 id>` **且带 `autoDispatch` 标记**的任务 → 不新建，`leadAuto.deduped++`。
   没标记的任务不算（轮询任务的 `assignee` 也可以被组长写成 worker 会话 id，那是组长审核的对象）。
2. 该组长名下已有**轮询投递**的进行中任务（`status='doing'` 且 `dispatchedSessionId=组长会话` 且
   `notifiedAt` 非空）且**未陈旧**（`updatedAt`，缺省退 `startedAt` / `notifiedAt`，距今 < **30 分钟**，
   常量 `LEAD_IN_FLIGHT_TTL_MS`）→ 判定它正在处理看板任务（组长每轮只处理一条），**不新建、也不改那条
   任务的字段**，`leadAuto.deduped++`。这样「轮询投递 → 组长派 worker」不会变成两条任务。
   宿主自己建的自动任务 `notifiedAt` 为 `null`，因此不会挡住下一次直聊派活。
3. **陈旧边界（best-effort 去重）**：轮询任务超过 30 分钟没有任何更新（worker 长跑 / 组长卡死）就不再
   挡住直聊派活——宁可多一条可见的看板任务，也不让用户的直聊派活无声消失（`deduped++` 之后看板上
   什么都没有）。30 分钟是权衡值：短了会在长 worker 运行期间重复建任务，长了会让「卡住的轮询任务」
   长时间吞掉直聊派活。

**完成回写（`subagent/end`）**

前置：任务必须带 `autoDispatch === 'lead-dispatch'` 标记（轮询投递任务 / 人工任务恒不带标记，见下表）。
`stopReason` **只认精确的 `'completed'`**：缺字段、空串、未知值一律按非 completed 处理（绝不静默置 done）。

| 条件 | 行为 |
| --- | --- |
| `stopReason === 'completed'` 且任务 `doing` | 置 `done`、`finishedAt`；`result` = `lastAssistantMessage` 里 `text` 块拼接（截 4000 字符，空则不写）；`leadAuto.completed++`（**只算这一次真正的 `doing→done`**）；随后 `flushReceipts()`（§1.6 链路不变，主会话照常收到「【任务看板 · 汇报】」） |
| 任务已是 `done` 且 `stopReason === 'completed'`（组长先审完 / 同一 worker 再次结束） | 只更新 `result`（非空时），不改状态、**不计 `completed`**、不重发回执（`reportedAt` 不变）。注意：这会**覆盖**组长已审的 `result`——取的是最后一次回报（worker 返工后的最终结论）；组长若在 worker 完全结束前就写了结论，后续结束会以 worker 的汇报为准 |
| 其它 / 缺省 `stopReason`（`error` / `aborted` / `max-tokens` / `refusal` / 缺字段 / 未知值）且任务 `doing` | 任务**保持 `doing`**，`lastError` = `worker 结束（<stopReason>）：<结论首行或「没有返回结论」>`，交给组长 / 用户处理；**不写** `leadAuto.lastError`（那只记挂钩自身异常）。`stopReason` 缺失时文案里的 `<stopReason>` 写 `unknown` |
| 其它 / 缺省 `stopReason` 且任务已是 `done` | 不动（组长已审；worker 的失败不推翻结论），`leadAuto.skipped++` |
| 任务 `archived` / `todo` | 不动（不改状态、不写结论），`leadAuto.skipped++` |
| 任务没有 `autoDispatch === 'lead-dispatch'` 标记（= 轮询投递任务 / 人工任务，`notifiedAt` 非空） | **绝不自动置 `done`**：忽略（`reason='not-auto'` / `no-task`），组长审核后自己 `taskboard_update` |
| 找不到任务 | 忽略（无关子 Agent） |

**失败处理：不阻断派发**

整个挂钩（建任务、回写）都包在 try/catch 里：任何异常只 `console.warn` + 记
`Snapshot.leadAuto.lastError`（+ `lastErrorAt`），异常**绝不影响**
`subagent` 工具的返回值与子 Agent 的启动——`tools/result` 是 emit 观察事件，监听器异常由管线
`notifyResult` 单独捕获，`subagent/end` 的监听器异常由生命周期发射器隔离。
worker 以非 `completed` 结束时把原因写进**该任务的 `lastError`**（见上表），**不写**
`leadAuto.lastError`——`leadAuto.lastError` 只记录挂钩自身的异常（建任务 / 回写失败），
worker 的 stopReason 不会覆盖它；成功回写也**不清空**它（真实故障不会被后续成功抹掉，
排查时要看 `lastErrorAt` 判断是不是历史故障）。
写盘失败的记账口径：`handleSubagentDispatch` 检查 `commitBoard` 返回值，`saved:false` 时记
`leadAuto.lastError`（任务仍留在内存）；`handleSubagentEnd` 的写盘是 **best-effort**，**不检查**
`commitBoard` 返回值——失败只由 `commitBoard` 内部 `console.warn`，不写 `leadAuto.lastError`，内存任务保留。
只有挂钩自身抛出的异常（外层 try/catch）才记 `leadAuto.lastError`。

**运行时视图（不落盘）**：`Snapshot.leadAuto`（§3.2）暴露 `enabled` / `created` / `deduped` /
`completed` / `skipped` / `lastError` / `lastErrorAt` / `lastTaskId` / `lastWorkerSessionId`，
供排障与真实设备验证读取；UI 可以不展示。
`skipped` 只统计「handler 走到了但没有动作」的次数（非组长预设、找不到带标记的任务、状态不适用、
无变化）；`tools/result` 里**不是派发结果**的事件（别的工具、失败的 `subagent` 调用）在监听器入口
就 return，不计数——这类事件量太大，计数没有意义。

### 1.9 待你处理（`needsUser`，v0.2.2 补充）

组长在派活 / 审核过程中遇到**必须由用户决策**的问题（选方案、确认范围、补凭据……）时，
不应该把它塞进 `lastError`、也不应该只在聊天里问——聊天消息会被历史淹没，用户也看不到。
改为在任务上打 `needsUser` 标记并写 `question`：看板把这条任务提升到「待你处理」区；
用户回答后宿主把回答 followup 给组长会话，清掉标记，任务继续。**全程不新增 status。**

**闭环**

1. 组长 `taskboard_update {id, needsUser:true, question, questionOptions?, status?}`。
   - `question` 必填（trim 后非空，≤500 字符），否则 `bad-request`；
     `questionOptions` 可选，最多 4 个、每个 ≤80 字符，非法项被过滤。
   - 宿主补 `askedAt`（已是 flagged 的重复更新保留最早的 `askedAt`，用它可以按「谁等得久」排序），
     `askedBy` = 提问的会话：`taskboard_update` 工具取 `exec.agent.session.id`（拿不到为 `null`），
     正常由工具自动填。`add-task` / `update-task` 也接受可选的 `askedBy`（本机 loopback RPC；工具
     参数里没有这个字段，模型不能伪造别的会话），但**只在同一次调用里同时设置 `question` /
     `needsUser:true` 时生效**；单独传 `askedBy` 会被忽略（没有新问题就没有「谁在问」，不该改写已有
     `askedBy`）。
   - **重设问题必须重传选项**：`question` 变了但没带 `questionOptions` → 清空旧选项，避免用户看到
     与新闻题不对应的按钮；只想补/换选项而不改问题就只传 `questionOptions`。
   - 任务 `status` 不变（`todo` / `doing` 都能 flag；`done` 后返工前也可以先问）。
2. **轮询跳过**（§1.4）：`selectDispatchCandidates` / tick 过滤 `needsUser === true` 的任务；
   `dispatch-now` 也拒绝（`conflict`）。问题没回答前不重复投递，也不占用每轮 1 条的派发名额。
3. **看板派生「待你处理」**：右栏看板顶部固定条 + 平台看板最左第五列；这些任务**不重复**出现在
   普通四列（§5.1.1 / §5.2）。排序按 `askedAt` 升序（最旧优先），缺 `askedAt` 的排最后。
4. **用户回答** → RPC `answer-task {id, answer}`（§3.1）：
   宿主按 `task.dispatchedSessionId` → `task.askedBy` → `task.sessionId` 依次找目标会话（去重、
   跳过空值；已归档的候选跳过），复用 `agents.get` / `sessionController.resolveAgent`，
   followup 一条「【任务看板 · 用户回复】…」；
   `sessions.flush` **成功后才**清 `needsUser` / `question` / `questionOptions` / `askedAt` /
   `askedBy`，写 `lastAnswer` / `answeredAt` / `updatedAt`（`sessions` 服务缺失时与派发路径一致：
   只做 followup、不阻塞清标记）。
   失败（候选会话都不可用 / 投递异常）**保留标记**、把原因写进任务 `lastError`，用户可以重试。
5. 组长收到回复消息后继续原任务（任务仍在原状态）：能直接收尾的就 `taskboard_update status=done`，
   还要干的继续派 worker；用户不需要重新加任务。

**字段（§2）**：`needsUser` / `question` / `questionOptions` / `askedAt` / `askedBy` /
`lastAnswer` / `answeredAt`。`lastAnswer` / `answeredAt` 是留档：回答成功后写入，之后再次 flag
**不清空**（详情浮层能显示「最近回答」）；`needsUser:false` 只清问题相关的四个字段。
任务进入 `archived`（`update-task {status:'archived'}` 或 `archive-done`）时**同样清问题四字段**、
保留 `lastAnswer` / `answeredAt`——归档是终态，不该再留着「等待用户回答」的标记。
**归档优先**：`update-task {status:'archived', needsUser:true}` 即使漏了 `question` 也照样归档
（跳过 needsUser / question / options 校验，标记直接清空），不返回 `bad-request`；模型漏参数不该
让任务卡住无法归档。已归档任务再调 `answer-task` 直接 `conflict`（「任务已归档，不能再回答」），
不投递、不写 `lastAnswer`——正常路径走不到（归档已清标记），属纵深防御。
`requeueTasksOfLead`（组长归档、任务退回 `todo`）也清问题四字段：任务改由新组长接单，
旧的问题 / 提问者不再有效。

**与 `lastError` 的分工**：`lastError` 是故障（派发失败 / 组长不可用 / worker 异常），
`needsUser` 是待决策。组长 persona 要求决策类问题必须走 `needsUser`（§6），
不要把问题塞进 `lastError`——`lastError` 只写「为什么没做成」。

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
    "pollIntervalMs": 15000,      // 5000..300000
    "maxNotifications": 5,
    "notifyCooldownMs": 120000,   // 由 interval 派生，写盘只作观测
    "dispatchMode": "workspace-lead", // workspace-lead | new | creator | auto；v0.2.0 缺省/非法 = workspace-lead
    "mainSessionId": "…" | null,  // 主会话（完成回执收件人）；null = 未绑定
    "mainSessionTitle": "",       // 主会话展示标题（≤200 字符，可为空串）
    "workspaceLeads": {           // 工作区 key → 常驻组长映射；最多 32 条，非法条目丢弃
      "ws-1": { "sessionId": "…", "title": "…", "cwd": "C:\\work\\demo", "createdAt": "…ISO…" }
    }
  },
  "tasks": [
    {
      "id": "t-1",
      "title": "把 X 改成 Y",
      "note": "验收标准：…",     // 可空串
      "status": "todo",          // todo | doing | done | archived
      "source": "user",          // user | agent | poller
      "sessionId": "…" | null,   // 创建这条任务的对话（cwd 兜底来源；旧模式下决定派发归属）
      "cwd": "C:\\…" | null,     // 任务所属工作区（workspace-lead 路由的 key 来源）
      "dispatchedSessionId": "…" | null, // 最近一次投给哪个会话（组长 / 主 Agent）
      "dispatchedSessionTitle": "",
      "reportedAt": "…ISO…" | null,      // v0.2.0：完成回执推给主会话的时间；null = 未推送
      "autoDispatch": "lead-dispatch" | null, // v0.2.0：宿主挂钩自动建的任务标记（§1.8）；null = 普通任务
      "needsUser": false,                // v0.2.2：等待用户回复（不新增 status，§1.9）
      "question": "",                    // needsUser=true 时必填（≤500）
      "questionOptions": [],             // 可选选项（≤4 个，每个 ≤80）
      "askedAt": "…ISO…" | null,         // 提问时间（「待你处理」按它排序）
      "askedBy": "…" | null,             // 提问的组长会话 id
      "lastAnswer": "",                  // 用户最近一次回答（≤1000，留档）
      "answeredAt": "…ISO…" | null,      // 最近一次回答时间
      "assignee": "…",           // 子 Agent 的 label / sessionId，组长填
      "result": "…",             // 审核结论 / 子 Agent 汇报摘要
      "createdAt": "…ISO…",
      "updatedAt": "…ISO…",
      "startedAt": "…ISO…" | null,
      "finishedAt": "…ISO…" | null,
      "archivedAt": "…ISO…" | null,
      "notifiedAt": "…ISO…" | null,
      "notificationCount": 0,
      "lastError": ""            // 最近一次派发/失败原因，详情浮层显示
    }
  ]
}
```

**`config` 规范化（`normalizeConfig`，v0.2.0 新增字段）：**

- `dispatchMode`：合法值 `'workspace-lead' | 'new' | 'creator' | 'auto'`；缺省或非法 → `'workspace-lead'`。
  **已持久化的合法旧值（`new` / `creator` / `auto`）原样保留**，不做自动迁移。
- `mainSessionId`：仅非空字符串采用，否则 `null`；`mainSessionTitle`：trim 后截 200 字符，缺省 `''`。
- `workspaceLeads`：普通对象（非数组）；key 为工作区 id 或归一化 cwd（§1.5 第 3 步）。
  每个条目要求 `sessionId`、`cwd` 均为非空字符串；`title` trim 截 200（缺省 `''`）、`createdAt` 为字符串（缺省 `''`）。
  非法条目丢弃；**最多 32 条**。
  - 读取（`normalizeConfig`）：按对象键顺序保留前 32 条。
  - 运行时新增映射（`putWorkspaceLead`，§1.5 第 5 步 / `ensure-workspace-lead`）：超过 32 条时淘汰
    对象键顺序**末尾的旧条目**（新写入的映射必须保留）。不能反过来把新映射截掉，否则下一次
    `normalizeConfig` 会丢掉它、tick 每轮重复创建组长。
- 旧字段（`pollEnabled` / `pollIntervalMs` / `maxNotifications`）行为不变。

**任务字段 `reportedAt`**：完成回执记账（§1.6）。`null` = 未推送；离开 `done` 后再次 done 必为 `null`（§1.6）。
它不是 `taskboard_update` / `update-task` 的可 patch 字段，只由宿主维护；出现在 `board.json`、
`Snapshot.tasks`，以及返回**完整任务对象**的 UI RPC 响应（`add-task` / `update-task` /
`dispatch-now` 的 `value.task`），**绝不出现在 `taskBrief()` / 模型工具输出**（§4.4）。

**任务字段 `autoDispatch`**：§1.8 的持久化标记，合法值 `'lead-dispatch' | null`（其它值规范化成 `null`）。
只有 `tools/result` 挂钩自动建的任务带 `'lead-dispatch'`；轮询投递任务 / 人工任务恒为 `null`。
`subagent/end` 只自动收尾带标记的任务（轮询任务永远交给组长审核）。任务回到 `todo`
（`applyTaskUpdate` 的 `→todo` 迁移、`requeueTasksOfLead` 的组长归档重排）时清空——重新排队后它会
被轮询投递，归组长审核，不再是「宿主自动任务」。`done→doing`（组长打回返工）**保留**标记：返工后的
结束仍按 §1.8 自动写回（组长每次 done 后都能看到结论并决定是否再打回）。只由宿主维护，不是
`taskboard_update` / `update-task` 的可 patch 字段，也**不进 `taskBrief()`**（§4.4）。

**任务字段 `needsUser` / `question` / `questionOptions` / `askedAt` / `askedBy` / `lastAnswer` / `answeredAt`（v0.2.2，§1.9）**：
`needsUser` 只认 `true`（其它 → `false`）；`question` trim 截 500；`questionOptions` 过滤非字符串 /
空串并逐个截 80，最多保留 4 个（去重）；`askedAt` / `answeredAt` / `askedBy` 非字符串 → `null`；
`lastAnswer` trim 截 1000。**`needsUser=true` 但 `question` 为空**：写入端（`add-task` /
`update-task` / `taskboard_update`）抛 `bad-request`（不写盘）；
读盘端（`normalizeTask`）保守降级为 `needsUser=false` 并清空问题字段（不丢整条任务）。
**`status='archived'` 的旧数据**在读盘时也降级为 `needsUser=false`（归档是终态，§1.9）。
`needsUser:false` 清空 `question` / `questionOptions` / `askedAt` / `askedBy`，**保留**
`lastAnswer` / `answeredAt`；`lastAnswer` / `answeredAt` 只由 `answer-task` 写。
`askedAt` / `askedBy` 由宿主 / 工具设置：`taskboard_update` 工具固定取 `exec.agent.session.id`，
`add-task` / `update-task` 也接受可选的 `askedBy`（本机 loopback RPC；UI 不传），但它**只在同一次
调用里同时设置 `question` / `needsUser:true` 时生效**，单独传会被忽略（`applyTaskUpdate` 只在
needsTouched 分支读它）；正常由 `taskboard_update` 工具自动填当前组长会话。
`update-task` 在**未 flag** 的任务上单独传 `questionOptions`（既没有 `question` 也没有
`needsUser:true`）→ `bad-request`，不静默丢选项（已 flagged 的任务只补选项是合法更新）；
**重设 `question` 但没带 `questionOptions` → 清空旧选项**（旧按钮与新闻题无关）；显式传
`questionOptions` 才更新/保留。任务进入 `archived` 时清问题四字段（保留 `lastAnswer` /
`answeredAt`），且**归档优先**：`{status:'archived', needsUser:true}` 即使漏 `question` 也照样归档，
跳过 needsUser / question / options 校验。
`Snapshot.tasks` 与 `board.json` 都带这些字段；`taskBrief()` 只暴露 `needsUser` / `question` /
`questionOptions`（§4.4），`askedBy` / `lastAnswer` / `answeredAt` 不进模型工具输出。

**归档清理（30 分钟保留期，§1.2）**：`pruneArchivedTasks(state, now, ARCHIVE_RETENTION_MS)` 把归档满 30 分钟的
任务从 `tasks[]` 里**物理删除**并 `commitBoard()`（`revision` +1、`updatedAt` 刷新）；没有过期任务时
**不写盘、不改 revision**。`nextId` 不回退（删掉的 `t-<n>` 不复用）；`archivedAt` / `updatedAt` / `createdAt`
都不可解析的任务保守保留。清理点：tick 在 `pollEnabled` 判断之前（§1.4）+ `apply()` 启动时一次。
清理是 best-effort：纯函数异常 / 写盘失败只 `console.warn`，绝不影响派发与完成回执（§1.2 / §1.4）。

- 原子写：同目录 `board.json.tmp` → `rename`；失败只记 `console.warn`，内存状态不丢。
- 读坏文件：`console.warn` + 从空板开始（坏文件改名 `board.json.corrupt-<ts>` 保留现场）。
- 内存状态是唯一真源；每次变更立即落盘（任务量小，不需要节流）。

### 2.1 附件存储（v0.2.0 新增，粘贴图片）

- **优先复用 DSH 附件服务**：宿主软取 `ctx.attachments`（`@deepseek-ai/dsh-attachment`，Web profile 默认由
  `@deepseek-ai/dsh-attachment-local` 提供），图片经 `attachments.saveImages()` 校验 / 归一化 / 落盘
  （对象在 `$DSH_HOME/attachments/v1/`）。本插件只在 `$DSH_HOME/storages/dsh-taskboard/attachments/index.json`
  记录「随机 id → 附件服务引用（`ImageAttachmentRef`）」。**不 import 任何 `@deepseek-ai/*`**，只走 `ctx.get`。
- **服务不可用时的后退（非 Web profile / 单测）**：自建存储，文件写到
  `$DSH_HOME/storages/dsh-taskboard/attachments/<uuid>.<png|jpg|webp|gif>`；同一 `index.json` 记录
  `backend:'local'` 与文件名。读取按索引里的文件名拼路径，并做 `path.resolve` 前缀校验防穿越。
- **测试 / 多实例隔离**：`DSH_TASKBOARD_PATH` 覆盖 `board.json` 路径时，附件目录 =
  `<board.json 所在目录>/attachments/`（与 board 一起隔离，不污染真实 `$DSH_HOME`；默认路径仍严格在
  `$DSH_HOME/storages/dsh-taskboard/` 下）。
- **id 与引用**：每次上传生成 `crypto.randomUUID()`（v4，不可猜）。note 里的引用格式固定为
  `![image](attachment://<uuid>)`；客户端只存短引用，**绝不**把 base64 / data URL 写进 note——
  note 会随派单消息投给组长 / worker，原始图片数据会撑爆 prompt。
- **校验**（上传时）：仅 `image/png` / `image/jpeg` / `image/webp` / `image/gif`；解码后单张
  **≤ 5 MB**；文件头（PNG / JPEG / GIF / WebP magic bytes）必须与声明 MIME 一致；空图拒绝。
  单条任务 note 里最多 **8** 个不同附件引用（`add-task` / `update-task` RPC 与 `taskboard_add` /
  `taskboard_update` 工具都校验）；客户端一次粘贴最多 **4** 张（超出部分不读取、提示用户分次粘贴）。
  DSH 附件服务可能按部署策略归一化格式（例如带 alpha 的 PNG 转 WebP），`upload-attachment` 的
  `mime` / `size` 以服务返回的 ref 为准，读取时也用这个 MIME 生成 data URL。
- **note / result 的 4000 字符截断口径**（`add-task` / `update-task` RPC、两个工具、以及
  `subagent` 自动建任务都走同一个 `truncateNote()`）：截断**不得切出半截 `attachment://` 引用**——
  截断点落在某个引用内部（`![...](attachment://<uuid>` 没有收尾 `)`）时，退到该引用开头再截，
  宁可少保留最后一个引用，也不留坏链接（详情浮层仍能渲染其余完整引用）。没有图片语法的裸引用
  （只有 `attachment://<uuid>`）同样不切半截：UUID 不完整就整段丢掉，完整 UUID 保留。截断在附件数校验之后
  （校验用调用方传入的原文，计数只会因截断变少，不会放行超限 note）。
- **读取**（`attachment` RPC）只按索引里的随机 UUID 查：id 格式非法 → `bad-request`；格式合法但索引里
  没有 / 文件缺失 → `not-found`；索引损坏 / 读取失败 → `internal`。复用服务时读取**不经过任何用户输入
  拼出的文件路径**，只按本插件索引里的 ref 调 `attachments.readImage()`（等价于「只读本插件上传过的
  附件」）；自建后端还会校验解析后的绝对路径必须位于附件目录内（防御性检查，正常路径不依赖用户输入
  拼文件名）。
- 附件目前**不随任务删除自动回收**（可能被多条任务引用；同一内容在 DSH 存储里也只落一份），暂不提供清理端点。

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
- 非 POST → **405**、`Content-Type` 不含 `application/json` → **415**（都是纯文本）；非 loopback Host → **403**；
  非法信封 / 路径端点与信封 `method` 不一致 → 200 + `bad-request`。
- 客户端调用：`connection.rpc.call('/taskboard', endpoint, payload)`。

### 3.1 端点表

| endpoint | payload | value | 说明 |
| --- | --- | --- | --- |
| `snapshot` | `{}` | `Snapshot` | 全量看板 + 运行时状态，client 每 2s 轮一次 |
| `add-task` | `{title, note?, sessionId?, cwd?, needsUser?, question?, questionOptions?, askedBy?}` | `{task}` | 新建到 `todo`，`source='user'`；右栏传 `sessionId`（宿主解析 cwd），平台看板传 `cwd`（用户选的工作区）。v0.2.2 起也接受可选的 `needsUser` / `question` / `questionOptions`（宿主 / 测试建「待你处理」任务用；UI 新建行不传），`askedBy` 可显式指定提问会话（仅与 `needsUser:true` / `question` 同传时生效） |
| `update-task` | `{id, status?, title?, note?, result?, assignee?, lastError?, needsUser?, question?, questionOptions?, askedBy?}` | `{task}` | 局部更新；非法状态迁移 → `conflict`；`needsUser:true` 缺 `question` → `bad-request`；只传 `questionOptions` 不带 `question` / `needsUser:true` → `bad-request`；重设 `question` 不带 `questionOptions` → 清空旧选项；`askedBy` 仅在同时设置 `question` / `needsUser:true` 时生效；校验全部在写字段之前完成（失败不留部分修改）；`status:'archived'` **优先**：跳过 needsUser / question / options 校验并清问题四字段（§1.9） |
| `answer-task` | `{id, answer}` | `{task, sessionId}` | **v0.2.2**：回答 `needsUser` 问题（§1.9）。`answer` 非空 ≤1000；任务已归档 → `conflict`（「任务已归档，不能再回答」，不投递、不写回答）；目标会话按 `dispatchedSessionId` → `askedBy` → `sessionId` 依次尝试（跳过已归档 / 不在线的候选）；followup + `sessions.flush` 成功后清标记并写 `lastAnswer` / `answeredAt`；全部候选不可用 → `conflict`（错误信息列出尝试过的会话），失败**保留**标记与问题，任务 `lastError` 写原因 |
| `delete-task` | `{id}` | `{deleted:true,id}` | 物理删除（仅限 UI 手动） |
| `dispatch-now` | `{id}` | `{dispatched, sessionId, task}` | 立即投递一次（不等轮询、无视冷却）；路由按当前 `dispatchMode` |
| `set-config` | `{pollEnabled?, pollIntervalMs?, dispatchMode?}` | `{config}` | 开关 / 间隔 / 派发去处（`workspace-lead` / `new` / `creator` / `auto`）；非法 `dispatchMode` 按 `normalizeConfig` 回落默认 `workspace-lead` |
| `archive-done` | `{}` | `{archived:n}` | 一键把全部 `done` 归档 |
| `bind-main-session` | `{sessionId}` | `{main: MainSessionRef}` | **v0.2.0**：把会话绑定为主会话（完成回执收件人），持久化 `config.mainSessionId` / `mainSessionTitle` |
| `clear-main-session` | `{}` | `{ok:true}` | **v0.2.0**：解除主会话绑定（幂等，未绑定也成功） |
| `ensure-workspace-lead` | `{cwd}` | `{lead: LeadRef}` | **v0.2.0**：确保 `cwd` 所属工作区有可用常驻组长（复用 → 唤醒 → 必要时创建并修复映射） |
| `session-info` | `{sessionId}` | `{sessionId, cwd}` | 给 client 兜底：冷会话（历史会话）不在 `agents[]` 里时也能拿到工作区，用于提示文案 |
| `upload-attachment` | `{dataUrl, name?}` | `{id, ref, mime, size, name?}` | **v0.2.0**：粘贴图片上传。`dataUrl` = `data:image/<png\|jpeg\|webp\|gif>;base64,…`（解码后 ≤5 MB）；返回随机 id 与短引用 `attachment://<uuid>`（note 只存这个引用，§2.1） |
| `attachment` | `{id}` | `{id, mime, size, dataUrl}` | **v0.2.0**：按随机 UUID 读取本插件附件，返回可直接给 `<img src>` 的 data URL；错误分支见 §3.3 |
| `install-preset` | `{}` | `PresetStatus + {action:'none'}` | **兼容端点**：0.2.2 起模式随 bundle patch 声明，这里只强制刷新 registry 状态 |

### 3.1.1 主会话 / 工作区组长端点（v0.2.0）

两种返回结构：

```ts
MainSessionRef = { sessionId: string, title: string, live: boolean, busy: boolean, archived: boolean }
LeadRef        = { key: string, cwd: string, sessionId: string, title: string, live: boolean, busy: boolean, archived: boolean }
```

- `live` = `agents.get(sessionId)` 能拿到 live Agent；`busy` = `live && agent.status === 'running'`。
- `archived` = 该会话在 `workspaceRegistry.archivedSessionIds` 中（v0.2.0 归档兜底）：归档门会拒绝它跑
  模型步进，因此**归档的组长不可调度、归档的主会话收不到回执**（§1.5 第 10 条 / §1.6）。
- `title` = live Agent 的会话标题（`session.header.title`，截 200）；取不到时用持久化映射里的 title
  （主会话用 `config.mainSessionTitle`，组长用 `config.workspaceLeads[key].title`）；仍为空则 `''`。

**`bind-main-session {sessionId}`**

1. `sessionId` 必须是非空字符串，否则 `bad-request`；不要求该会话当前在线（历史会话也能先绑）。
2. 写 `config.mainSessionId=sessionId`；`config.mainSessionTitle` 尽力取 live Agent 标题（取不到保留原值 / 空串）。
3. 已有绑定直接被覆盖（换绑）；返回 `{main: MainSessionRef}`。

**`clear-main-session {}`**

1. `config.mainSessionId=null`、`config.mainSessionTitle=''`；幂等，未绑定也返回成功。
2. 返回 `{ok:true}`。

**`ensure-workspace-lead {cwd}`**

1. `cwd` 必须是非空字符串，否则 `bad-request`；按 §1.5 第 3 步算 key。
2. 已有映射且能拿到 live Agent → 直接用（顺手修复映射里为空的 `title` / `cwd`）；返回 `LeadRef`。
3. 已有映射但无 live Agent → 尝试 `sessionController.resolveAgent(sessionId)` 唤醒；成功则用。
4. 唤醒失败或没有映射 → `sessionController.create({workspaceId?, agentPreset:'taskboard-dispatch'})`：
   按 cwd 所属工作区创建；**该次 create 抛错时退回按 `{cwd}` create**，解析不到 workspaceId 时直接
   按 `{cwd}` create。成功后写映射（`createdAt=iso(now)`）并 commit——取不到 live Agent 时
   `title` 写 `''`，映射照样落盘。
5. `sessionController` 不可用、两次 `create` 都失败或拿不到 sessionId → `internal`
   （消息「无法创建工作区组长：…」）。
6. 不要求该工作区有任务；这是 UI「创建组长」按钮的修复入口。返回 `{lead: LeadRef}`。

### 3.2 `Snapshot` 形状

```jsonc
{
  "version": 1,
  "revision": 37,
  "updatedAt": "…ISO…",
  "config": {                               // = normalizeConfig(board.config)，含 v0.2.0 新字段
    "pollEnabled": true, "pollIntervalMs": 15000, "maxNotifications": 5,
    "dispatchMode": "workspace-lead",       // workspace-lead | new | creator | auto
    "mainSessionId": "…" | null,            // 主会话（完成回执收件人）；null = 未绑定
    "mainSessionTitle": "",
    "workspaceLeads": {                     // 工作区 key → 常驻组长映射（≤32 条）
      "<key>": { "sessionId": "…", "title": "…", "cwd": "C:\\work\\demo", "createdAt": "…ISO…" }
    }
  },
  "tasks": [ Task… ],                       // 全部状态，client 自己分组
  "poll": {
    "running": true,                        // 定时器是否在跑
    "lastRunAt": "…ISO…" | null,
    "lastDispatchAt": "…ISO…" | null,
    "lastDispatchTaskId": "t-3" | null,      // 最近一次成功投递的任务 id（「组长对话」兜底归属判断）
    "lastDispatchSessionId": "…" | null,     // 会话 id（展示用尾 8 位）
    "lastDispatchSessionTitle": "…" | null,  // 会话标题（有则优先展示）
    "lastSkipReason": "no-live-agent" | "agent-busy" | "creator-busy" | "creator-cold" |
                      "workspace-busy" | "workspace-offline" | "agent-offline" | "no-agents-service" |
                      "followup-failed" | "lead-busy" | "lead-unavailable" | "lead-no-workspace" |
                      "poll-disabled" | null   // 完整映射见 §1.5 / §1.7
  },
  "workspaces": [                           // 工作区注册表（平台看板的新建下拉/过滤用）
    { "id": "…", "path": "C:\\work\\demo", "title": "demo", "status": "ok" }
  ],
  "agents": [                               // 在线会话快照（client 用它显示「当前工作区」提示；不提供会话选择器）
    { "sessionId": "…", "status": "idle"|"running", "cwd": "…"|null, "title": "…"|null,
      "preset": "taskboard-dispatch"|"standard"|…|null, "root": true }
  ],
  "leads": {                                // v0.2.0：组长 / 主会话运行时视图（client 组长条用）
    "main": { "sessionId": "…", "title": "…", "live": true, "busy": false, "archived": false },  // 未绑定 = null
    "workspaces": [                         // 按 config.workspaceLeads 的对象键顺序
      { "key": "<key>", "label": "demo", "cwd": "C:\\work\\demo",
        "sessionId": "…", "title": "…", "live": true, "busy": false, "archived": false }
    ]
  },
  "preset": {
    "installed": true,                       // agentPresets.list() 里 taskboard-dispatch 存在且无 broken
    "version": "0.1.0",
    "path": "bundle:presets/taskboard.patch.yml",
    "restartRequired": false,                // bundle 声明的模式随启动加载，无「装完要重启」语义
    "broken": "",                            // 挂载失败诊断（非空 = 该模式不可用）
    "presets": [ { "id": "taskboard-dispatch", "name": "任务看板 · 工作区组长（自动）", "description": "…", "broken": "" },
                 { "id": "taskboard-worker", "name": "任务看板 · 执行者（自动派发）", "description": "…", "broken": "" } ],
    "reason": ""                             // 读不到 registry 时的原因
  },
  "leadAuto": {                              // v0.2.0：组长直聊派活自动建任务的运行时视图（不落盘，§1.8）
    "enabled": true,                         // tools/result + subagent/end 挂钩是否已注册
    "created": 1,                            // 本次运行自动建任务数
    "deduped": 0,                            // 命中去重跳过数（同一 worker / 组长正处理未陈旧的轮询任务）
    "completed": 1,                          // worker 结束把自动任务真正 doing→done 的次数（不重复计数）
    "skipped": 3,                            // handler 走到但没有动作的次数（非组长 / 找不到带 autoDispatch 标记的任务 / 状态不适用 / 无变化）；非派发结果在监听器入口就返回，不计数
    "lastError": "",                         // 最近一次**挂钩自身**的异常（建任务 / 回写失败）；worker 的 stopReason 只写任务 lastError，成功回写也不清空这里
    "lastErrorAt": null,                     // 「…ISO…」| null
    "lastTaskId": "t-7" | null,              // 最近一次自动建 / 回写的任务
    "lastWorkerSessionId": "…" | null,       // 最近一次自动建任务对应的 worker 会话 id
    "updatedAt": "…ISO…"
  },
  "boardPath": "C:\\Users\\…\\.dsh\\storages\\dsh-taskboard\\board.json",
  "pluginVersion": "0.2.0",                 // 宿主从自身 package.json 读到的版本（Client 页脚展示）
  "now": "…ISO…"
}
```

`agents[].title`：会话头里的标题（未命名时为空串）。
`agents[].preset`：**`ctx.get('agentPresets').presetForSession(agent.session)`**（Session 的 agentPreset 投影，
反映创建后切换过的模式；`session.header.agentPreset` 只是创建时的值，实测新建派单模式会话后仍是 `standard`，不能用作判据）。
宿主用它决定「优先派给哪个空闲会话」，client 不再展示会话选择器。

`Snapshot.config` 是 `normalizeConfig()` 的结果（含全部 config 字段）；`Snapshot.tasks` 是完整任务对象
（含 `reportedAt`、`dispatchedSessionId` 等 UI 字段），与工具输出的 `taskBrief` 不同。
`leads.main` 为 `null` ⇔ `config.mainSessionId` 为空；`main` / `workspaces[]` 的 `title` / `live` / `busy`
定义见 §3.1.1。`leads.workspaces` 来自 `config.workspaceLeads`，按对象键顺序；`label` = 工作区注册表里
该工作区 id/path 的 `title`，取不到时用 cwd 尾段（`baseName`），best-effort 可为 `''`。
`leads` 是**运行时视图**，`revision` 不变时也会变（组长启停 / 忙闲）——Client 不能只用 `revision`
判断是否更新组长条。
`pluginVersion` = 宿主读自身 `package.json` 的 `version`（Client 页脚展示）；`poll.lastDispatchTaskId` =
最近一次成功投递的任务 id，供 Client 在任务缺 `dispatchedSessionId` 时判断
`poll.lastDispatchSessionId` 兜底是否属于该任务（§5.2）。
`leadAuto` = §1.8「组长直聊派活自动建任务」的**运行时计数与最近错误**，纯观测字段：不落盘、不影响任务
状态机、Client 可选择展示或不展示（缺字段时 Client 不应报错）。`Snapshot.tasks` 里的任务对象额外带
持久化的 `autoDispatch` 标记（`'lead-dispatch' | null`，§2），它是 `subagent/end` 能否自动收尾的唯一判据；
该标记不进 `taskBrief()`（§4.4）。

### 3.3 错误码

| code | 场景 |
| --- | --- |
| `bad-request` | 信封/端点/字段不合法（title 空、status 不在枚举、id 不存在时的格式错） |
| `not-found` | `id` 不存在 |
| `conflict` | 状态迁移非法 / 标题重复 / 并发 revision 冲突 |
| `internal` | 读写盘、未知异常 |

v0.2.0 新增端点的错误分支：

- `bind-main-session`：`sessionId` 缺失 / 非字符串 / 空串 → `bad-request`。
- `clear-main-session`：无错误分支（幂等）。
- `ensure-workspace-lead`：`cwd` 缺失 / 非字符串 / 空串 → `bad-request`；创建组长优先按 cwd 所属
  `workspaceId` 调 `sessionController.create`，**这次 create 抛错时退回按 `{cwd}` create**；
  `sessionController` 不可用、两次 create 都失败或拿不到 sessionId → `internal`。
- `upload-attachment`（§2.1）：`dataUrl` 缺失 / 非字符串 / 不是标准 `data:image/...;base64,` 形式 →
  `bad-request`；MIME 不在四个白名单 → `bad-request`；解码后空图 / >5 MB / 文件头与声明 MIME 不符 →
  `bad-request`；DSH 附件服务以稳定图片准入错误码拒绝（`isImageAdmissionError`）→ `bad-request`；
  附件服务 / 索引写盘失败 → `internal`。请求体上限单独放宽到约 7 MB（base64 膨胀 + data URL 前缀），
  其它端点仍是 512 KB。
- `attachment`：`id` 缺失 / 非字符串 / 不是 UUID → `bad-request`；UUID 不在索引 / 文件缺失 → `not-found`；
  索引损坏 / 读取失败 → `internal`。
- `add-task` / `update-task`：note 中不同 `attachment://<uuid>` 引用超过 8 个 → `bad-request`（§2.1）。
- `add-task` / `update-task` / `taskboard_update` 的 `needsUser:true` 缺 `question`（或 `question`
  非法 / 空串）→ `bad-request`，不写盘（§1.9 / §2）。`update-task` / `taskboard_update` 在**未 flag**
  的任务上只给 `questionOptions`、既不 `flag` 也不带 `question` → `bad-request`（已 flagged 的任务
  只补选项合法；不静默丢选项）；`update-task` 抛错前已完成全部校验，不会留下部分字段修改。
- `answer-task`（v0.2.2，§1.9）：`answer` 缺失 / 非字符串 / trim 后为空 / 超过 1000 字符 →
  `bad-request`；`id` 不存在 → `not-found`；任务没有 `needsUser` 标记 → `conflict`；
  候选会话（`dispatchedSessionId` → `askedBy` → `sessionId`，去重）全部不可用
  （都已归档 / `agents.get` 与 `sessionController.resolveAgent` 都拿不到 live Agent / 三个字段都为空）
  → `conflict`，错误信息列出尝试过的会话；followup / `sessions.flush` 抛错 → `internal`。
  **候选不可用与投递失败这两种情况都保留标记**、把原因写进任务 `lastError`（用户可以重试）。
- `dispatch-now` 指向 `needsUser === true` 的任务 → `conflict`（等用户回答；回答后自动恢复派发）。
- 工具 `taskboard_add` 的 `workspace` 解析失败是**工具调用错误**（不是 RPC 错误码），错误文本 `未知工作区：<入参>`。

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
`dispatchMode='workspace-lead'` 的路由细节见 §1.5；完成回执的 flush 时机见 §1.6。

### 4.4 工具（模型侧，全局注册）

全部用 `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })`
直接注册（**不用** `defineTool`，避免 import `@deepseek-ai/dsh-tools`；`parameters` 用标准 JSON Schema，
`required` 数组放对象层）。注册在 `ctx.get('tools')` 存在时执行，缺失则跳过并告警。

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `taskboard_list` | `{status?}` | 返回文本清单（id / 状态 / 标题 / 备注 / assignee / result / 待回答的问题）+ 结构化 `tasks[]`；v0.2.2 起 `tasks[]` 额外带 `needsUser` / `question` / `questionOptions` |
| `taskboard_add` | `{title, note?, workspace?}` | 新建任务（`source='agent'`，`sessionId=exec.agent.session.id`）；`workspace` v0.2.0 新增，见下 |
| `taskboard_update` | `{id, status?, result?, assignee?, note?, needsUser?, question?, questionOptions?}` | 更新任务；`status` 非法迁移返回错误文本；v0.2.2 起 `needsUser:true` + `question` 用来「问用户」（§1.9），`needsUser:false` 取消提问，`askedBy` 取 `exec.agent.session.id`（工具不暴露该参数；RPC 层单独传 `askedBy` 也不生效，见 §2） |

**`taskboard_add.workspace`（v0.2.0，可选）**：工作区 id / 名称 / 绝对路径，用于主会话往任意工作区派任务。

1. 省略或空串 → 沿用原行为：`cwd` 取调用 Agent 会话的 `header.cwd`（可能为 `null`，由轮询按创建会话兜底）。
2. 绝对路径（`/`、`\`、`X:\` 开头）→ 原样作为 `cwd`，不查注册表。
3. 其它字符串 → `workspaceRegistry.list()` 依次匹配：`id` 精确、`title` 精确（大小写不敏感）、`path` 归一化比较；
   取第一个命中的 `path` 作为 `cwd`。
4. 解析不到 → 抛错 `未知工作区：<入参>`（工具调用失败，不建任务）；`workspaceRegistry` 不可用也按解析不到处理。
5. 解析成功时 `sessionId` 仍记调用会话；任务归属由 `cwd` 决定，`dispatchMode='workspace-lead'` 会投给该工作区的组长。

工具输出统一 `output.schema = { type:'object', … }`，`render` 返回 `[{type:'text', text}]`。
`execute(args, exec)` 中 `exec.agent` 可能为空（非 agent 调用）→ 直接 `throw`。

**硬规则（0.1.3 起）：工具输出是封闭契约，宿主在 `execute()` 之后才校验。**

- dsh tools 管线在 `execute()` **成功返回之后**才校验 canonical output（`validateJsonSchemaValue` →
  `ToolOutputError` / `INVALID_TOOL_OUTPUT`）。`output.schema` 的对象层都是
  `additionalProperties:false`，返回值夹带未声明字段 → 模型侧只看到调用失败，**而 `execute()` 的
  副作用（board.json 写入、状态迁移）已经生效**，表现为「看板变了但工具报错」。
- 因此 `execute()` 的返回值必须逐字段落在 `output.schema` 声明内，工具里不要返回任务完整对象。
- UI 专用字段（`dispatchedSessionId`、`sessionId`、`cwd`、`startedAt` 等）只走 `buildSnapshot()`
  里的完整任务对象（Client 的跳转读的是 snapshot，不读工具输出），**不进 `taskBrief()`**。
- 改工具输出形状的顺序：**先改本文档 / `output.schema` → 再改 `execute()` → 补
  `test/host.test.mjs` 的封闭性回归**（`TASK_LIST_OUTPUT_SCHEMA` / `TASK_ONE_OUTPUT_SCHEMA` /
  `taskBrief` 已 export 供单测）。v0.1.2 的 `dispatchedSessionId` 事故就是跳过了第一步。
- v0.2.0 新增的任务字段 `reportedAt` 是 UI / 回执记账字段：出现在 `board.json`、`Snapshot.tasks`
  与返回完整任务的 UI RPC 响应（`add-task` / `update-task` / `dispatch-now` / `answer-task`
  的 `value.task`），**绝不进 `taskBrief` / 模型工具输出**。
- v0.2.2 起 `taskBrief` 有 **10 个已声明键**：id / title / status / note / assignee / result /
  updatedAt + `needsUser` / `question` / `questionOptions`（flagged 任务必须在模型工具输出里可见，
  组长才能确认自己在等什么；`askedBy` / `askedAt` / `lastAnswer` / `answeredAt` 仍只出现在
  `board.json` 与 `Snapshot.tasks`，不进工具输出）。

### 4.5 模式状态（预设声明 + 读回）

0.2.2 起 preset **不是目录**：`$DSH_HOME/.agent-presets/` 已没有宿主代码读取。preset 是 bundle
patch 里的一条 `@deepseek-ai/dsh-agent-preset` 声明行（config: `id/name/description/order/plugins`）。
因此本插件不写盘、不复制文件，只在 `presets/taskboard.patch.yml` 里声明两个模式：

| 模式 id | 名称 | 用途 |
| --- | --- | --- |
| `taskboard-dispatch` | 任务看板 · 工作区组长（自动）（工作区组长口径） | **工作区组长**：只处理本工作区任务；只读文件工具 + 派单/审核/看板，无 shell、无写文件 |
| `taskboard-worker` | 任务看板 · 执行者（自动派发） | 子 Agent：完整执行工具集；由组长的 `subagent` 行用 `agentPreset: taskboard-worker` 指定 |

- 子 Agent 的 preset 只能由 **spawn** provider 指定（fork 会继承父级 preset），因此派单模式只挂
  `subagent` 行，不挂 `subagent_fork`；`maxDepth: 1` 是递归硬上限。
- 宿主侧只做「读回状态」：`ctx.inject(['agentPresets'], …)` 里调用 `agentPresets.list()`，把
  `taskboard-dispatch`/`taskboard-worker` 的 `broken` 诊断放进 `Snapshot.preset`（15s 缓存，
  因为 `list()` 会重新审计挂载树）。
- 预设行激活是异步的，启动时读不到属于正常：apply 内最多重试 3 次（2.5s 间隔）再告警。
- `install-preset` 端点保留为兼容：只强制刷新状态，不做任何写入。
- v0.2.0 起 `taskboard-dispatch` 在 `dispatchMode='workspace-lead'` 下由宿主**按工作区自动创建 / 维护**
  （`config.workspaceLeads`），persona 已改写为「工作区组长」口径；用户通常不需要手动选择该模式。
  旧 `new` 模式下它仍作为「每任务新建的派单会话」使用，行为按同一 persona（收到投递先置 doing 再派 worker）。

### 4.6 组长直聊派活的挂钩（§1.8 实现）

`apply()` 里在工具注册之后调用 `registerLeadAutoHooks(ctx, rt)`，只挂事件监听、不依赖任何服务就绪：

```js
// 观察事件：监听器异常被 tools 管线（notifyResult）隔离，绝不影响工具返回值。
ctx.on('tools/result', (exec, result) => { … }, { global: true })
// 生命周期：subagent/end 的监听器异常由 dsh-subagent 的发射器隔离。
ctx.on('subagent/end', (info) => { … }, { global: true })
```

- `{ global: true }` 让监听器跳过 Cordis 的 scope 过滤（`tools/result` 的 carrier 按调用 Agent 过滤，
  `subagent/*` 按委派父 Agent 过滤）；宿主插件在 handler 里先按预设 / `assignee` 过滤，
  所以看到的事件多、落到看板的少。该选项在 cordis 的 `_resolve` 里是显式读取的；
  万一将来取消，退化结果是「按 scope 过滤」，不会报错。**单测必须断言两次 `ctx.on` 的第三参都是
  `{global:true}`**：假 ctx 丢掉第三参时测试仍然会绿，真机却收不到事件。
- 命中条件收紧（§1.8）：`tools/result` 要求 `exec.name === 'subagent'`、`result.isError !== true`、
  `result.value.kind === 'activation'` 且 `subagentId` 非空；`subagent/end` 只收「带
  `autoDispatch === 'lead-dispatch'` 标记」的任务，轮询投递任务绝不被自动置 `done`。
- handler 抽成**可单测的导出函数**（`handleSubagentDispatch` / `handleSubagentEnd`），单测直接调用，
  不需要起 DSH 进程。
- 建任务走 `addTask()` + `applyTaskUpdate({status:'doing', assignee})` + 打 `autoDispatch` 标记 +
  `commitBoard()`（与 RPC / 工具同一条写盘路径，`revision` 正常递增）。
- 完成回写走 `applyTaskUpdate()` + `flushReceipts()`，与 `taskboard_update` 工具完全一致
  （flush 只在真正的 `doing→done` 时发生；任务已 `done` 的第二次结束只刷 `result`，不重发回执）；
  `stopReason` 只认精确的 `'completed'`（缺省 / 未知一律按非 completed，保持 `doing` + 写任务
  `lastError`），`leadAuto.completed` 只在真正的 `doing→done` 时 +1。

---

## 5. Client 半要求（两个看板）

同一个数据文件、两套视图：

| 视图 | 位置 | 范围 | 新建任务 |
| --- | --- | --- | --- |
| **本工作区看板** | 右侧栏 tab（`sidebarRightTabs` + `sidebar.right.pane.tab`）+ 会话 header 入口按钮 | `task.cwd === 当前会话工作区` **或** `task.sessionId === 当前会话` 的任务（后者兜住 cwd 为空的旧任务/早期任务，避免「任务凭空消失」）；另有「未绑定工作区的任务」提示指向平台看板 | 默认绑定当前对话/工作区（sessionId 交给宿主解析 cwd） |
| **任务看板（全部工作区）** | 左侧栏面板（`sidebar.panellist` + `main` 整页） | 全部任务（含 `cwd=null` 的老任务）；**卡片只显示标题 + 操作按钮**（t-33 起，工作区等信息都在详情浮层），可按工作区过滤 | **必须选工作区**（下拉来自 `snapshot.workspaces`），传 `cwd`、不传 sessionId |

两个视图共用同一套卡片/列组件与 RPC；左栏面板图标带 `todo+doing` 角标。

### 5.0 右栏集成契约（0.2.2-rc.1 实测）

| 用途 | API |
| --- | --- |
| 声明 tab 类型（静态） | `ctx.inject(['sidebarRightTabs'], s => s.effect(() => s.sidebarRightTabs.register({ id, kind, priority:'extension', title: () => string, guide:[…] })))` |
| tab 正文 | `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name:'sidebar.right.pane.tab', key: <定义 id> }, Body))`；`Body` 收到 slot 级 `useTabInfo` prop |
| tab chip | `sidebar.right.pane.tab.title` 同 key 注册；不注册则用打开时捕获的标题 |
| 打开 tab | `ctx.inject(['sidebarRight'], s => handle = s.sidebarRight)` → `handle.openTab(kind)` |
| 收起已展开的看板 | `handle.isExpanded() === true && handle.active()?.kind === TAB_KIND` → `handle.hide(handle.active().id)`：docked 折叠整列、floating 关闭浮层，tab 记录保留（下次展开还在） |
| 会话 header 入口 | `ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name:'conversation.session.header.actions', id:'taskboard', order:40, label }, HeaderAction))`（list 槽） |

- 本插件：`TAB_TYPE_ID='dsh-taskboard'`（= tab 系统身份，也是正文/title 的 key），`TAB_KIND='taskboard'`（openTab 参数）。
- `TabRecord`（`active()` 的返回）实测形状 `{ id, kind, title, contentId }`，`kind` 即 `openTab` 用的页类型。
- header 按钮是 **toggle**：看板已展开且就是活动 tab → `hide(tabId)` 收起；其它情况（没开 / 已收起 / 活动 tab 是别的）→ `openTab(TAB_KIND)` 打开并聚焦。`active` / `isExpanded` / `hide` 任一 API 缺失或抛错都退回 `openTab`，不挡打开主路径。
- `useTabInfo()` 返回 `{ sidebar:{expanded, fullscreen}, panel:{id,isFloating}, tab:{title,visible,navigation,actions,…} }`。
- 右栏服务缺失时（非 web-app 部署）插件不崩：header 按钮保留但点击只在 console 警告，body/title 注册由 `slots.inject` 自然等待。
- 引导页入口：类型的 `guide` 数组给右栏引导页贡献一张卡片（`{ id, order, title, description, icon }`），
  点它即 `openTab(kind)`。

### 5.1 槽位汇总

| 槽位 | 注册参数 | 内容 |
| --- | --- | --- |
| `conversation.session.header.actions` | `{ name, id:'taskboard', order:40, label: () => t('panel.label') }` | 会话 header 右侧的看板按钮（`.tb-headbtn`），带本工作区 `todo` 数量角标（`.tb-badge`，>99 显示 99+，6s 刷新）+ **待你处理数量角标**（`.tb-badge.tb-badge-needs`，红点样式的独立 badge，v0.2.2）。两个角标与右栏看板用**同一过滤**（`tasksForWorkspace`：cwd 属于本工作区，或任务创建于本对话），不会出现「banner 有、角标为 0」；看板已展开且是活动 tab 时**再点一次收起**（`sidebarRight.hide`） |
| `sidebar.right.pane.tab` | `{ name, key:'dsh-taskboard' }` | 本工作区看板正文 `BoardTab` |
| `sidebar.right.pane.tab.title` | `{ name, key:'dsh-taskboard' }` | chip：看板 glyph + 标题 |
| `sidebar.panellist` | `{ name:'sidebar.panellist', id:'taskboard-platform', order:25, label: () => t('platform.label'), locale }` | 左侧栏「任务看板」图标（全部工作区），带 `todo+doing` 角标 + **待你处理角标**（`.tb-badge-needs`，v0.2.2） |
| `main` | `{ name:'main', key:'taskboard-platform', locale }` | 平台任务看板整页 `PlatformBoard` |

> `label` 必须是 thunk（`string | (() => string)`），语言切换后无需重注册。

### 5.1.1 平台看板页（`main`）

自上而下：

1. **头部**：标题「任务看板」+ 副标题（`共 N 条 · 轮询状态`）+ 立即刷新 + 轮询开关 + 间隔选择 +
   一键归档已完成；preset 异常 banner；页脚（数据文件路径 + 版本）。头部还有「派发到」选择器
   （`workspace-lead` / `new` / `creator` / `auto`，默认 `workspace-lead`）与**组长条**（§5.5）。
2. **新建行**：标题输入（Enter 提交）+ 备注展开 + **工作区选择（必选）**：
   下拉 `placeholder = 选择工作区`，options 来自 `snapshot.workspaces`（title，空则路径尾段）；
   未选时「添加到待开始」禁用并提示「先选择任务所属的工作区」。提交 `add-task {title, note?, cwd: 工作区 path}`。
   **粘贴图片（v0.2.0）**：与右栏看板同一套逻辑——备注 `textarea` 的 `paste` 事件识别 `image/*` →
   `upload-attachment` → note 追加短引用 `![image](attachment://<uuid>)` + 缩略图列表；普通文本粘贴不拦截。
   上传前先按 `file.size` 预检单图 ≤5 MB（超限直接提示、**不发请求**）；`uploading` 是**计数**，
   连续粘贴时计数 > 0，提交按钮与标题 Enter 都不提交；提交前统计 note 里不同引用数，> 8 时给具体提示
   （与服务端文案同源，§2.1）。提交时 note 只带短引用，`cwd` 仍必选。
3. **工作区过滤**：`全部工作区`（默认）/ 单个工作区——只影响显示。
4. **四列看板**：复用 `Col`（宽度足够时四列）；卡片只显示标题 + 操作按钮（t-33 起，
   工作区 / 备注 / 结论 / 时间 / 组长 / 执行者都在详情浮层）；`cwd=null` 的老任务也显示（详情里工作区为空）。
   **未归档的 `needsUser` 任务不在四列里重复显示**（见下一条）；已归档的 flagged 任务照常留在「已归档」列。
5. **「待你处理」第五列（v0.2.2，§1.9）**：有 flagged 任务时在「待开始」**之前**插入第五列
   `待你处理 N`（`.tb-board[data-needs="true"]` 五列网格，`.tb-col[data-status="needsUser"]`）；
   没有 flagged 任务时**整列不渲染**（仍是四列）。列内卡片（`.tb-needs-card`）显示
   标题 + 问题**最多两行**（`.tb-needs-card-q` 的 `-webkit-line-clamp:2`，截断）+「处理」按钮：
   点标题或按钮都打开详情浮层的「需要你处理」区。
   列头带问题数量角标；列里只放 flagged 任务，按 `askedAt` 最旧优先。
6. **空态**：「没有任务。选个工作区加一条，主 Agent 会自动接手。」

派发：`workspace-lead`（默认）下平台任务按 `cwd` 投给该工作区的常驻组长（§1.5）；旧模式下
宿主优先找同工作区的空闲会话（`workspace-session`），找不到就等（`workspace-offline` / `workspace-busy`），
手动「立即派发」才允许改派（§1.7）。

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
   「立即刷新」按钮 + 轮询开关 + 间隔选择（5s/15s/30s/60s）+「派发到」选择器 + **组长条**（§5.5）。
   - 「派发到」选项：`workspace-lead`（显示「工作区组长（推荐）」，默认）/ `new`（新对话）/
     `creator`（回发起对话）/ `auto`（空闲会话）；值直接取 `snapshot.config.dispatchMode`，
     缺省回退 `'workspace-lead'`（不要回退 `new`）。
   - `Snapshot.preset.broken` 非空 → 红色 banner 显示挂载诊断；
   - `Snapshot.preset.installed === false` → 黄色 banner 显示原因（没有 agentPresets 服务 / 名单里没有本模式）。
2. **新建任务行**：输入框（Enter 提交）+ 备注展开（可选）+ 「添加到待开始」按钮；
   下方一行只有「加备注」链接和一句提示——**没有「派发给」选择器**（派发全自动，产品决策）：
   - 本会话在 `agents[]` 里能查到 cwd（或 `session-info` 兜底）→
     「…任务会交给该工作区的组长执行（工作区：name）。」（旧模式仍是「回到本对话执行」）
   - 查不到（冷会话/历史会话）→ 挂载时调一次 `session-info` 拿 cwd，同样显示工作区；
   - 实在拿不到 → 通用文案「…你只管加任务和看结论。」
   新建时把 `props.sessionId` 一并交给 `add-task`，宿主据此解析 cwd，决定任务所属工作区。
   - **粘贴图片（v0.2.0）**：备注 `textarea` 监听 `paste`；`clipboardData.items` 含 `image/*` 时
     `preventDefault`，读取为 data URL → `upload-attachment`，把短引用 `![image](attachment://<id>)`
     追加进备注；同一 `paste` 最多 4 张（超出提示分次粘贴）。**普通文本粘贴不拦截**，保持浏览器默认行为。
     粘贴前按 `file.size` 预检单图 ≤5 MB（超限提示、不发请求，避免撞 7 MB 请求体上限后只剩「网络错误」）；
     同一批里单个文件读取失败**不丢弃**已上传成功的图片（逐项 catch）。待提交图片以缩略图列表显示在
     备注下方（`img.tb-attach-thumb`），可逐张移除（同时删掉 note 里的引用）；上传中禁用提交
     （`uploading` 为计数，连续粘贴不会提前解除禁用）。提交前统计 note 里不同引用数 > 8 时给具体提示
     （与服务端同源，§2.1）。提交时只把含短引用的 note 交给 `add-task`，不传 base64。左侧栏平台看板
     用同一逻辑（§5.1.1 第 2 条）。
3. **「待你处理」条（v0.2.2，§1.9）**：右栏看板顶部固定区（头部 / 新建行之后、看板主体之前），
   **仅在 `needsUser` 任务非空时渲染**。标题「待你处理 N」+ 条目列表（`.tb-needs`）：每条显示
   任务标题 + 问题（单行截断，`title` 属性兜全文），点条目打开该任务的详情浮层。
   flagged 任务**不再出现在**下面四个 lane / 四列里（避免重复；已归档的 flagged 留在归档列，不进此条）；
   空时整块不渲染。
4. **看板主体**（布局见上）：待开始（蓝）/ 进行中（黄）/ 已完成（绿）/ 已归档（灰）。
   - 每块头部：列名 + 计数 + 快捷动作（待开始：`全部派发`；已完成：`全部归档`）。
   - 卡片（t-33 起）：**只有标题 + 操作按钮**。标题可点打开**任务详情浮层**，2 行截断、`title` 兜全文；
     备注（note）/ result / 工作区 / `#t-3` / 相对时间 / 组长 / 执行者 / `lastError` 全部收进详情浮层，
     看板上不再展示（宽度不足时靠标题辨认任务）。
   - **卡片高度 / 等高（t-42）**：整卡**没有固定高度**——`.tb-card-fixed` 不再有 `min-height:108px`
     （`--tb-card-h` 变量已删），操作行也不再 `margin-top:auto` 贴底。等高改由**标题固定 2 行高度**
     实现：`.tb-card-fixed .tb-card-title` 用 `min-height:2.8em`（12.5px × 1.4 × 2 = 35px）配合
     `-webkit-line-clamp:2`，1 行标题与 2 行标题的标题块同高；标题与操作行之间只留
     `.tb-card-fixed` 的 `gap:5px`（`.tb-card-actions` 在该类下 `padding-top:0`），不再有整块空行。
     2 行标题 + 单行按钮的卡片约 **81px**（9+35+5+22+8 + 1px 上下边框），同列同按钮行数的卡片等高。
     1 行标题的卡片里，标题文字下方仍留着第 2 行的高度（这是「1 / 2 行标题等高」的代价：文字到按钮
     约 22px = 17.5px 预留行 + 5px gap；2 行标题的卡片就是 5px，即原来那块空行已消失）。
     窄栏下按钮换 2 行时卡片会自然变高（实测 5 按钮换 2 行时 81 → 106px，按钮不裁）——
     「不裁按钮」的取舍，**不为强行等高裁掉按钮**。
   - 卡片动作（按状态）：
     - todo：`开始`（→doing）、`立即派发`（`dispatch-now`）、`编辑`、`删除`
     - doing：`完成`（→done）、`打回`（→todo）、`编辑`
     - done：`归档`（→archived）、`返工`（→doing）
     - archived：`重新打开`（→todo）、`删除`
   - **已归档列会自动淘汰**：归档满 30 分钟的任务由宿主动删除（§1.2），用户不必逐个点 `删除`；
     UI 目前没有额外的倒计时提示（删除是静默的）。
   - 编辑用行内表单（标题 + 备注），保存调 `update-task`。
   - **跳到关联对话**：卡片动作里「对话」的优先级是 **worker 子会话**（`task.assignee`，且只在它形如
     `session-…` 或 UUID 时算会话；`worker-42` / `main` 这类普通标签不算会话，不出现按钮）→ 组长会话
     （`task.dispatchedSessionId`）→ 发起对话（`task.sessionId`）；按钮 `title` 写实际跳转的会话 id。
     详情浮层「关联对话」区块分别给出且各自可点：「发起对话 · <尾8>」= `task.sessionId`、
     「执行对话 · <尾8>」= worker `task.assignee`（仅当像会话 id）、「组长对话 · <尾8>」=
     `task.dispatchedSessionId`（与 worker / 发起会话相同则不重复显示）；都没有时显示
     「（这条任务还没有关联对话）」。组长直聊派活时宿主把 worker 会话 id 记进 `assignee`（§1.8），
     所以「执行对话」指向真正干活的子会话，不再用组长会话冒充。
     点击调用客户端服务 `ctx.get('uiWorkspace').openSession(sessionId)`（官方导航 API，同步 void），
     服务缺失/会话不存在时只 console.warn 不崩。宿主在投递时把 `dispatchedSessionId` / Title 记到任务上。
     老版本 Host 派发的进行中任务没有这个字段时，client 用 `snapshot.poll.lastDispatchSessionId` 兜底：
     仅当 `poll.lastDispatchTaskId` 命中该任务、或全局只有一条 `doing` 任务时才显示「组长对话」
     （兜底会话是「派发到的会话」，语义上是组长会话，不冒充 worker，避免张冠李戴）。
   - **任务详情浮层**（`Detail`，两块看板共用）：点卡片标题或「详情」按钮打开，展示完整标题 / 状态 /
     工作区 / 创建·开始·完成·归档时间 / 组长 / 执行者 / 创建来源 / 任务 id / 完整备注 /
     完整结论（含 done 但没写结论时的提示）/ 最近错误，并提供按状态的主操作（开始 / 完成 / 归档 / 重新打开）
     与关闭；点遮罩或 × 关闭。备注 / 结论里的 `![alt](attachment://<id>)` 由 `renderRichText` 渲染为
     `<img class="tb-rich-img">`（打开浮层时按 id 调 `attachment` RPC，内存缓存，`max-width:100%;height:auto`），
     加载中 / 失败显示占位文本，不阻塞其它 Markdown 块。
   - 空块显示空态文案（如「没有待开始的任务。加一条，工作区组长会自动派发。」）。
4. **页脚**：宽栏显示数据文件路径 + 「看板数据存储在本机」 + 版本号；窄栏只显示版本号。

**任务详情浮层里的「需要你处理」区（v0.2.2，§1.9）**：`task.needsUser === true` 时，详情浮层在
「完成结论」之前插入一块回答区（`.tb-detail-needs`）：

1. 问题正文（`task.question`，自动换行）；
2. `questionOptions` 非空时先列选项按钮（点一下把该选项填入输入框，不直接提交）；
3. 自由输入 `textarea`（`needsUser.answerPlaceholder`，≤1000 字符）+「回复并继续」按钮
   （空回答禁用）；
4. 点提交 → `answer-task {id, answer}`：成功后关闭浮层并刷新（任务从「待你处理」消失、回到原列）；
   失败**不关闭、不丢输入**，浮层内显示错误（`bad-request` / `conflict` / `internal` 文案同源），
   用户可以改答案重试。

「最近回答」（`task.lastAnswer`，留档见 §1.9）**不在 flagged 分支里**：只要字段非空，
详情浮层就显示一块「最近回答」（`.tb-detail-answer` / `.tb-detail-lastanswer`）——
回答成功后 `needsUser` 已清，用户 / 组长回看任务时仍要能看到上次拍板的答案。

草稿 / 错误 / 提交中状态放在看板组件里、经 `bind` 传给浮层（浮层本身不调 hooks），
关闭浮层时清空草稿。

### 5.3 数据与交互

- 挂载后立即 `snapshot`，之后每 **2000ms** 轮询一次；页面不可见（`document.visibilityState!=='visible'`）
  时**整个 tick 直接跳过、不发请求**，回到可见后立即补一次，卸载清理（`POLL_HIDDEN_MS` 常量
  目前未使用）。轮询失败保留旧数据，头部显示小错误条，连续 5 次失败显示「连接断开，重试中」。
- Client **没有**「`revision` 未变化就跳过重渲染」的逻辑：每次 `snapshot` 成功都用返回值直接
  `setSnap` 替换看板状态（2s 一次），`revision` 只作为快照字段透传。
  - `snapshot.leads`（组长 / 主会话在线与忙闲）是运行时视图，`revision` 不变也可能变化；
    因为每次都整包替换快照，组长条天然跟随最新值——不能改成只看 `revision` 的增量渲染。
- 所有写操作：乐观更新不做，等 RPC 返回后用返回值替换该任务（简单、无回滚逻辑）。
- 键盘可达：按钮有 focus ring；新建输入 Enter 提交、Esc 清空；编辑表单 Enter 保存、Esc 取消。
- i18n：`ctx.get('locale')` 注册 `taskboard` 命名空间，zh/en 两套；locale 不可用则内置中文。
  v0.2.2 新增「待你处理」文案：`column.needsUser`（待你处理 / Needs you）、`needsUser.title` /
  `needsUser.question` / `needsUser.answerPlaceholder` / `needsUser.submit` /
  `needsUser.badge` / `needsUser.open` / `needsUser.lastAnswer` / `needsUser.answerOk` /
  `needsUser.answerFailed` / `needsUser.answerEmpty` / `needsUser.answerTooLong` /
  `needsUser.pickOption`，中英双份（没有空态文案键：条 / 列空时整块不渲染）；CSS 适配窄栏
  （「待你处理」条在窄栏也固定显示在 lane 之前）。

### 5.4 样式

- 只用 `--dsw-*` 主题变量（背景/边框/文字/圆角/字号/状态色），亮暗主题自动成立；
  状态强调色用 `--dsw-alias-state-*`；唯一允许的硬编码色是列头小圆点（4 个状态的固定色，
  见 `docs/client-notes.md` 的调色板建议）。
- CSS 通过 `<style data-plugin-css="dsh-taskboard/client.css">` 幂等注入一次。

### 5.5 组长条与主会话绑定（v0.2.0）

两个看板共用一条「组长条」，数据来自 `snapshot.leads`（§3.2），RPC 见 §3.1.1。

1. **主会话**
   - 未绑定（`leads.main === null`）：显示「未绑定主会话」+ 按钮「把当前对话设为主会话」→
     `bind-main-session {sessionId}`（当前会话 id；拿不到 → 按钮禁用并提示）→ 成功后重新拉 `snapshot`。
   - 已绑定：显示「主会话 · <title 尾 8 字符，title 空则「主会话」>」+ 状态点
     （`live=false` 灰「离线」/ `busy=true` 黄「忙」/ 否则绿「在线」）+「打开」按钮
     （复用 `openSession(leads.main.sessionId)`）+「换绑」按钮（把**当前**会话再 `bind-main-session` 一次）。
   - 「解除绑定」（`clear-main-session`）可实现（放菜单里，非契约必需）；不实现也不影响契约。
2. **工作区组长**
   - 完整看板（`main`）：列出 `leads.workspaces` 全部条目；右栏看板：只列当前看板可见任务涉及的 key
     （取 `task.cwd` 的归一化值 / 工作区 id 比对，兼容两者）。
   - 每个条目：`组长 · <label 或 cwd 尾段>` + 状态点（同 `live` / `busy` 规则；`archived=true` 时状态为
  「已归档」）+「打开」；归档条目把「打开」换成「创建组长」（`ensure-workspace-lead` 会替换失效映射）。
  主会话 `archived=true` 时同样显示「已归档」；换绑 / 重建走上面的「换绑」/工作区的「创建组长」按钮。
   - 当前工作区没有组长条目：显示「创建组长」按钮 → `ensure-workspace-lead {cwd}`（cwd = 当前会话工作区
     或该任务的 `task.cwd`）；成功后重新拉 `snapshot`。
   - 条目缺失 / 离线不阻塞看板其它功能；RPC 失败只 `console.warn` + 顶部错误条，不崩。
3. **任务卡片 / 详情**：卡片只有标题 + 操作按钮（t-33）；「组长」=
   `task.dispatchedSessionTitle || task.dispatchedSessionId`（详情里可点打开）、「执行者」= `task.assignee`
   （worker 的 label / sessionId）都在详情浮层。详情沿用 §5.2 的「发起对话 / 执行对话 / 组长对话」。
4. **「派发到」选择器**：选项 `workspace-lead`（显示「工作区组长（推荐）」，默认）/ `new` / `creator` / `auto`；
   值直接取 `snapshot.config.dispatchMode`，缺省回退 `'workspace-lead'`（不要回退 `new`）。
5. **i18n**：组长条文案、三个状态点、新 RPC 错误提示都要 zh/en 双份（`locale` 命名空间 `taskboard`）；
   skip reason 用 `poll.skip.<reason>`，新增 `lead-busy` / `lead-unavailable` / `lead-no-workspace` 三条映射。

---

## 6. 预设（模式）要求

- 文件：`presets/taskboard.patch.yml`，`package.json` 的 `dsh.bundle.patch` 是数组：
  `["./cordis.patch.yml", "./presets/taskboard.patch.yml"]`。
- 两个声明行（`@deepseek-ai/dsh-agent-preset`）：
  - `taskboard-dispatch`（order 40）：persona（**工作区组长口径**）+ agent-instructions + time-context +
    **只读** tool-fs（read/readImage=true，write/edit/applyPatch=false）+ tool-fs-search + tool-jobs +
    planning(realm: planMode，**必须给非空 section**) + compaction(realm) +
    delegation(realm: workflowEngine) = tool-subagent-control + tool-subagent(spawn, agentPreset=taskboard-worker, maxDepth=1) +
    tool-ask-user + tool-todo(**必须给 allowParallelInProgress**) + present。
  - `taskboard-worker`（order 41）：worker persona + agent-instructions + time-context + bash/pwsh（按平台 disabled）+
    完整 tool-fs + tool-fs-search + tool-jobs + skill-filesystem + tool-skill + compaction + tool-ask-user +
    tool-todo(allowParallelInProgress) + tool-web + present。**不含**任何委派工具。
- persona（`taskboard-dispatch`）必须写清「**工作区组长**」口径：
  1. 你是本工作区的常驻组长，只处理本工作区（当前工作目录）的任务；用户只和主会话对话，
     你不直接面对用户，也不做面向用户的汇报；
  2. 收到「【任务看板 · 待开始】」→ 先 `taskboard_update` 置 `doing` → `subagent` 派 worker
     （`taskboard-worker` 预设，后台；prompt 自包含任务 id / 标题 / 工作目录 / 验收标准 / 回报模板）→ 结束本轮；
  3. 子 Agent 回报 → **对工作区取证审核**（读文件、对照验收标准；要跑命令就派验证子 Agent，不看摘要）：
     通过则 `taskboard_update status=done result=<Markdown>`（插件会把完成回执汇总给主会话）；
     不通过则 `send_message` 打回同一个 worker，`doing` 不变；
  4. 不自己执行：不写文件、不跑命令、不做调查；缺工作目录 / 不属于本工作区 / 需要跨工作区拆分时，
     写 `lastError` 或回退 `todo` 说明，不臆造、不跨工作区硬做；
  5. 保留：每轮只处理投递来的一条、结束本轮不等待不轮询、`result` 用结构化 Markdown。
  6. v0.2.0 补充：用户在**直聊**里直接要求你派活时，照常先 `subagent` 派 worker 即可——宿主会自动在看板
     建一条 `doing` 任务（带 `autoDispatch` 标记），worker 结束时自动写回 `done` + `result`（§1.8）；
     **不要**为了记录再手动 `taskboard_add` 一条（会与自动任务重复）。只有真正需要另立任务（别的后续安排、
     跨工作区拆分记账）才用 `taskboard_add`。注意自动收尾**只对宿主自动建的任务生效**：轮询投递来的任务
     （`autoDispatch` 为 `null`）始终由组长 `taskboard_update` 写回 `done` / 打回 `doing`。
  7. v0.2.2 补充（需要用户决策时）：**不要**把问题写进 `lastError`、也不要只在聊天里问。改用
     `taskboard_update {id, needsUser:true, question:"…", questionOptions?:["A","B"]}` 在任务上提一个
     具体问题（`question` ≤500 字、选项 ≤4 个 / 每个 ≤80 字），任务 `status` 保持原样；
     看板会把这条任务提到「待你处理」（§1.9），用户回答后宿主把回答 followup 给你，你继续原任务。
     任务已 `done` 又被用户打回、或发现验收标准需要用户确认时同样适用。`lastError` 只写故障原因
     （派发失败 / 组长不可用 / worker 异常），**不写提问**。
- 不在预设里写死 `agentOptions.provider/model`（可移植性）：子 Agent 继承主 Agent 路由。
- 已知坑（都已在 patch 里修掉，改预设时别踩）：`dsh-plan-mode` 的 `section` 必填；
  `dsh-tool-todo` 的 `allowParallelInProgress` 必填；`tool-subagent` 的 `persona/toolFilter/backgroundMode`
  字段在 0.2.2 已移除（用 `agentPreset` 替代）；`dsh-tool-subagent-control/list-agents` 子路径已不存在。

---

## 7. 验证清单

1. `node --check lib/index.js`、`node --check lib/client.js`、`node --test` 全绿。
2. 安装到测试 profile（`dsh plugin --profile taskboard add C:\Users\duan\Code\dsh-taskboard`），
   `dsh --profile taskboard --port 3099 --no-open` 起服务，无启动报错；启动日志出现
   `[taskboard] 派单模式已就绪：任务看板 · 工作区组长（自动）(taskboard-dispatch) / 任务看板 · 执行者（自动派发）(taskboard-worker)`。
3. HTTP 探针（`.dev/verify-rpc.mjs <baseUrl>`）：snapshot / add-task / update-task / dispatch-now /
   set-config / archive-done / install-preset / **bind-main-session / clear-main-session /
   ensure-workspace-lead / upload-attachment / attachment** 全通；错误分支（bad id、非法 status、
   空 title、空 sessionId、空 cwd、非法图片 MIME、路径穿越 id、未知附件 id）返回对应错误码。
4. Playwright（右侧栏）：会话 header 出现「任务看板」按钮（带角标）→ 点击 → 右栏打开看板 tab →
   **再点一次 header 按钮 → 右栏收起**（docked 折叠整列 / floating 关闭浮层，tab 记录保留）→ 再点开仍在 →
   窄栏四个纵向 lane 渲染 → 加任务出现在待开始 → 切换轮询开关/间隔 → 编辑/开始/完成/归档/删除各走一遍 →
   全屏/加宽到 ≥680px 切四列 → 刷新页面状态保持 → 左侧菜单没有看板项。
5. 端到端派单（真实模型，v0.2.0 核心验收）：普通会话绑定主会话 → 加任务 → 插件自动创建该工作区
   组长并投递 → 组长置 doing、派 worker → worker 完成后组长审核写 done + result → 主会话收到
   「【任务看板 · 汇报】」回执并汇总。**这是本插件唯一不可省的验收项。** 旧模式（new/creator/auto）
   的「主 Agent 自己派子 Agent」链路另测一条，确认兼容。
6. 预设：`Snapshot.preset.installed === true` 且两个模式 `broken` 为空；模式选择器出现
   「任务看板 · 工作区组长（自动）」与「任务看板 · 执行者（自动派发）」；选中工作区组长模式后对话一轮，确认主 Agent 只派发不自己干活，
   且子 Agent 实际能读写文件（worker preset 生效）。
7. 安全：RPC 只回 loopback；无绝对路径泄漏出 `boardPath`（允许，本机工具）。
8. 工作区组长模式边界：第二个工作区加任务 → 各自组长独立、互不混用（绝不为第二个任务新建会话）；
   组长忙时任务留待开始、下轮再派；主会话忙时回执不投递、空闲后补投；未绑定主会话时任务仍完成但不发回执；
   `snapshot.leads` / 组长条状态点与真实会话状态一致。
9. 新端点 / 参数：`bind-main-session` / `clear-main-session` / `ensure-workspace-lead` 返回结构与
   §3.1.1 一致；`taskboard_add` 带 `workspace`（id / 名称 / 路径各一次）落到正确工作区，未知工作区报错；
   `reportedAt` 不出现在工具输出里（封闭 schema 回归测试仍绿）。
10. 组长直聊派活（§1.8，v0.2.0 补充）：`node --test` 覆盖「直聊派发 → 自动建 doing 任务」
    「worker 完成 → done + result + 回执」「建任务失败不阻断派发且记 `leadAuto.lastError`」「同一 worker 只有一条」
    「组长正处理轮询任务时不重复建」「非组长预设不建」；v0.2.0 修复后另加四条回归：
    **「组长把轮询任务的 assignee 设成 worker id，worker completed 结束后任务仍 doing、不写 result、
    不 flush 回执」**、「`exec.name` / `value.kind` / 非空 `subagentId` 三条件缺一不命中」、
    「`stopReason` 缺省 / 未知一律不置 done（保持 doing + `lastError` 写 `unknown`）」、
    「两次 `ctx.on` 的第三参都是 `{global:true}`」；in-flight 陈旧窗口与 `autoDispatch` 标记
    也有单测。真实设备上再加一条端到端：打开工作区组长会话 → 直接要求它派活 → 看板出现 `doing` 任务
    （`assignee` = worker 会话）→ worker 结束后变为 `done` + `result`，`snapshot.leadAuto.created/completed`
    递增；**同时确认轮询投递任务在 worker 结束后仍保持 `doing`**（等组长审核）。
    **标准 tool-call 与 PTC（`run_code`）各测一次**：两者都走 `tools/result`，预期行为一致。
11. 粘贴图片（v0.2.0）：两个看板的新建备注 textarea 粘贴 PNG → 出现缩略图 → 提交 → 详情浮层渲染
    `<img>`；删除待提交图片后引用消失；普通文本粘贴不受影响。Host 单测覆盖上传成功 / 非法 MIME /
    超 5 MB / 路径穿越 / 未知 id / 非 loopback 与错误码；真实设备验证需要宿主重启加载新 RPC 后进行。
12. 待你处理（v0.2.2，§1.9）：`taskboard_update {id, needsUser:true, question:"…"}` → 任务字段落盘
    （`askedAt` / `askedBy` 由宿主补）、`taskboard_list` 能看到 `needsUser` / `question`、轮询
    **不再派发**这条任务（`tick` 候选为空、`dispatch-now` 返回 `conflict`）→ 看板右栏出现
    「待你处理」条、平台看板出现第五列，且普通四列里**没有**它 → 详情浮层选选项 / 输入答案 →
    点「回复并继续」→ `answer-task` 成功：标记清空、`lastAnswer` / `answeredAt` 写入、组长会话收到
    「【任务看板 · 用户回复】」followup → 任务回到候选列表并被正常派发。
    失败分支：把目标会话关掉（无 live Agent）时回答 → `conflict`、标记**保留**、`lastError` 有原因，
    重试可成功。Host 单测覆盖字段规范化 / 缺 question 拒绝 / tick 跳过 / 清 flag 后可派发 /
    answer-task 成功与两类失败 / answer 空与超长；Client 单测覆盖「待你处理」条与第五列的渲染、
    不在普通列、回答调用与成功清空、错误提示、两处角标。

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
| 工作区组长会话被用户关掉 / 变成冷会话 / 被归档 | 冷会话：tick 里 `resolveAgent` 尝试唤醒，失败只跳过并提示（**不自动重建**已有映射）；**被归档**（在 `workspaceRegistry.archivedSessionIds` 里）：tick/`ensure-workspace-lead` 删除失效映射、把该组长名下 `doing` 任务重排 `todo`、懒创建新组长，不 unarchive 用户的归档动作（§1.5 第 10 条）。主会话被归档则回执暂停（`main-archived`），等换绑 / 取消归档 |
| 主会话离线 / 忙时完成回执堆积 | done 任务保持 `reportedAt=null`；主会话 live 且 idle 后合并补投（≤10 条/批）；未绑定则不发，不丢任务状态 |
| 工作区映射无限增长 | `workspaceLeads` 最多 32 条，超出按 key 顺序截断；非法条目在 `normalizeConfig` 丢弃 |
| 用户把工作区组长会话误绑成主会话 | 回执仍会投递，但组长 persona 不面向用户、不会主动汇总；文档建议主会话用普通会话（不做硬校验，避免误伤） |
| 手动在模式选择器里开的「任务看板 · 工作区组长（自动）」会话不会被自动接管 | 看板只认 `config.workspaceLeads`（懒创建 / `ensure-workspace-lead` 修复）；手动会话不写映射、不派任务，建议交给插件自动创建。后续版本可让懒创建优先复用同工作区空闲的该预设会话（v0.2.x 待办） |
| §1.8 的挂钩依赖 dsh 的 `subagent` 工具名/输出形状（`value = {kind:'activation', subagentId}`）与 `subagent/end` 事件字段 | 只认 `exec.name === 'subagent'` + `result.isError !== true` + `value.kind === 'activation'` + `subagentId` 是非空字符串这一组稳定形状；**形状变了就只是不再自动建任务（fail-safe），不会误建或误置 done**。`subagent/end` 缺 `lastAssistantMessage` 时 `result` 留空、任务照样置 done；缺 `stopReason` 时按非 completed 处理（保持 doing）。升级 dsh 后跑 `node --test` 的挂钩回归（`registerLeadAutoHooks` 注入假事件 + 断言 `{global:true}` 第三参）与 §7 第 10 项真实链路 |
| 组长在直聊里「先 `taskboard_add` 再 `subagent`」会造成两条任务 | persona 已写明「直聊派活不需要手动 add」（§6）；`assignee` 去重只挡同一 worker，挡不住人手建的重复任务，属预期（用户可见、可删） |

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
- v0.1.3（修复工具输出契约）：`taskBrief()` 不再返回 UI 专用的 `dispatchedSessionId`，三个模型工具
  （`taskboard_add` / `taskboard_list` / `taskboard_update`）的输出严格落在
  `TASK_LIST_OUTPUT_SCHEMA` / `TASK_ONE_OUTPUT_SCHEMA` 的封闭声明内。该字段由 v0.1.2 的
  commit ad4852c 引入工具返回值却未在 schema 声明，dsh 在 `execute()` 返回后校验时抛
  `INVALID_TOOL_OUTPUT`——看板写入已落盘、模型却看到三个工具全部失败。新增 `test/host.test.mjs`
  回归（`taskBrief` 输出键集合 ⊆ schema `properties`，含 list `items`），并在 §4.4 补
  「execute 之后再校验、副作用已生效、改输出先改 schema」的硬规则。
- v0.2.0（工作区组长模式）：新增 `dispatchMode='workspace-lead'` 并成为默认（已持久化的 `new`/`creator`/`auto`
  原样保留）；`config` 增加 `mainSessionId` / `mainSessionTitle` / `workspaceLeads`，任务增加 `reportedAt`；
  轮询按任务工作区复用 / 懒创建常驻组长（`taskboard-dispatch` 预设，persona 改写为工作区组长口径），
  组长派 `taskboard-worker` 子 Agent 干活并审核写回；任务 `done` 后把未汇报任务合并成
  「【任务看板 · 汇报】」回执投给主会话并写 `reportedAt`；`Snapshot` 增加 `leads`；
  RPC 增加 `bind-main-session` / `clear-main-session` / `ensure-workspace-lead`；
  `taskboard_add` 增加可选 `workspace` 参数；README 增加「工作区组长模式怎么用」。
- v0.2.0 补充（组长直聊派活自动建任务，§1.8 / §4.6）：宿主新增两条事件挂钩——`tools/result` 在
  `subagent` 工具成功返回 `{kind:'activation', subagentId}` 时，若调用方预设是 `taskboard-dispatch`，
  就按 `description` / `prompt` 第一行自动建一条 `doing` 任务（`assignee` = worker 会话 id，
  `dispatchedSessionId` = 组长会话，`cwd` = 组长当前工作区）；`subagent/end` 在 worker 结束后按
  `assignee` 找回任务置 `done` + `result`（`lastAssistantMessage` 的 text 块）并 `flushReceipts()`，
  非 `completed` 的结束只写 `lastError`、任务保持 `doing`。去重：同一 worker 只建一条；组长名下已有
  轮询投递的 `doing` 任务时不重复建。失败只记 `Snapshot.leadAuto.lastError`，**不阻断派发**。
  两种工具调用模式（标准 tool-call / PTC `run_code`）走同一个 `ToolExecutionPipeline`，挂钩等价命中；
  直接调 `ctx.subagents.startActivation()` 的第三方插件不覆盖。`Snapshot` 增加运行时字段 `leadAuto`
  （不落盘）。
- v0.2.0 修复（直聊派活挂钩只收尾自己的任务）：`subagent/end` 原先只按 `assignee === info.id` 找任务，
  组长把**轮询投递任务**的 assignee 写成 worker 会话 id 后，worker 一 `completed` 宿主就抢先置 `done` +
  `flushReceipts()`，组长来不及取证审核、也无法打回。改为：自动建任务带持久化标记
  `task.autoDispatch='lead-dispatch'`（`normalizeTask` 规范化；`findTaskByWorker` / `handleSubagentEnd`
  只认带标记的任务；任务回 `todo` / 组长归档重排时清空标记），轮询任务**绝不**被自动置 done。
  同时收紧命中条件（`exec.name === 'subagent'` + `result.value.kind === 'activation'`）、
  `stopReason` 缺省 / 未知一律按非 completed 处理（`unknown` 写进任务 `lastError`）、
  `leadAuto.completed` 只在真正 `doing→done` 时 +1、`leadAuto.lastError` 只记挂钩自身异常
  （worker 的 stopReason 不写、成功也不清空）、in-flight 去重加 30 分钟陈旧窗口
  （`LEAD_IN_FLIGHT_TTL_MS`，避免长期卡住的轮询任务吞掉直聊派活）、`skipped` 口径在 §3.2 写清
  （非派发结果在监听器入口返回、不计数）。单测补 `{global:true}` 第三参断言。§1.8 / §2 / §3.2 / §4.6 同步更新。
- v0.2.0 修复（会话标题常量）：`sessionTitle()` 引用了未定义的 `SESSION_TITLE_MAX` 常量（v0.1.3 遗留），
  会话标题非空时 tick（投递记账 / 快照）会抛 `ReferenceError`；本版补上常量定义（= 200，与
  `mainSessionTitle` / `workspaceLeads[].title` 的截断长度一致）。
- v0.2.0 修复（列头/卡片不平齐）：只有「已完成」列的列头带「全部归档」按钮（24px 高、外框约
  26px），其它列列头只有文字（行高 14px）。列头不固定高度时 flex 行高被按钮撑大 ~10px，于是
  「已完成」的标题比别的列低、整列卡片也跟着低一截。给 `.tb-colhead` 固定 `height:31px`
  （`box-sizing:border-box`，窄栏 29px），所有列头的标题、卡片起点同一水平线。
  本地 2x 复现实测：改前列头 20 / 27px、卡片顶 38 / 45px；改后统一 31px、卡片顶 49px。
- v0.2.0 修复（右栏 tab 标题被挡）：宿主 dockkit chrome 在 tab hover / active 时，会用标题右侧
  30px 的渐隐遮罩给关闭按钮让位；本插件 tab 默认只有内容宽（图标 + 「任务看板」≈71px，tab ≈100px），
  遮罩从标题 50px 处开始，「板」被一起吃掉、看起来像被关闭按钮挡住。修法不是拉宽 tab，而是
  **给关闭按钮让出内边距 + 关掉遮罩**：`[data-dockkit-tab]:has(.tb-tabtitle)` 设
  `min-width:0;padding-right:24px`，并给 `[data-dockkit-tab-title]` 设 `mask-image:none`。
  本地 2x 复现实测：tab 宽 100→105（只 +5px，标题区不变），标题内容右缘 81、关闭按钮左缘 81，
  不再重叠（改前是 81 vs 76，重叠 5px）。
- v0.2.0 修复（看板页底部错乱）：`.tb-page` 是唯一的滚动容器（`height:100%;overflow-y:auto`），
  但看板/ lane 子项沿用 `flex:1 1 auto`，内容超高时 flex 先把它们压到 `min-height`，卡片从容器里
  溢出、盖住页脚（页面自身反而没有滚动条）。改为 `.tb-page > *{flex-shrink:0}` +
  `.tb-board`/`.tb-lanes` 用 `flex:1 0 auto`：内容超高时页面正常滚动、页脚永远在内容之后；
  中/宽布局空列占位改为在剩余高度内垂直居中（`.tb-page[data-narrow=false] .tb-col > .tb-empty`）。
  本地复现实测：改前 `scrollHeight==clientHeight`、页脚与最后一张卡重叠；改后
  `scrollHeight>clientHeight`（840→903）、页脚在卡片下方。
- v0.2.0 修复（组长条基线）：组长条里的 ghost 按钮沿用 `.tb-btn` 的 500 字重 + 独立字体族 +
  `line-height:1`，与同行文字的字号/行高不一致，视觉上比「组长 · xxx」「忙」等文字低约 1px。
  改为 `.tb-leads .tb-lead-btn` 完全继承组长条正文排版（字体族 / 字号 / 字重 / 行高）；
  本地 2x 渲染实测：改前按钮墨迹中心低 2 设备像素，改后与标签/状态文字一致。
- v0.2.0 修复（归档组长 / 主会话兜底）：新增 `workspaceRegistry.archivedSessionIds` 检测。
  组长会话被归档时 tick / `ensure-workspace-lead` 删除失效映射、把该组长名下 `doing` 任务重排
  `todo`、懒创建新组长（不 unarchive 用户的归档动作）；主会话被归档时回执暂停
  （`{sent:false, reason:'main-archived'}`）；`MainSessionRef` / `LeadRef` 增加 `archived`，
  组长条对归档会话显示「已归档」并提供「创建组长」。
- v0.2.0 调整（模式显示名）：`taskboard-dispatch` 的显示名由「派单看板模式」改为
  「任务看板 · 工作区组长（自动）」，`taskboard-worker` 改为「任务看板 · 执行者（自动派发）」。
  这两个预设由插件自动使用，显示名带「自动」是为了在模式选择器里表明**通常不需要手动选择**；
  preset id 不变，已有会话、`config.workspaceLeads` 与脚本引用都不受影响。dsh 的 preset 声明
  （`@deepseek-ai/dsh-agent-preset` 的 Config：id/name/description/order/plugins）没有 hidden
  字段，注册的预设必然出现在选择器里，无法从插件侧隐藏。
- v0.2.0 新增（粘贴图片附件）：两个看板的新建备注 textarea 支持从剪贴板粘贴 png/jpeg/webp/gif，
  上传后 note 只写短引用 `![image](attachment://<uuid>)`（绝不写 base64），详情浮层按引用渲染 `<img>`。
  Host 新增 RPC `upload-attachment` / `attachment`：优先复用 `ctx.attachments`（DSH 附件服务，
  对象在 `$DSH_HOME/attachments/v1/`）；服务不可用时自建存储到
  `$DSH_HOME/storages/dsh-taskboard/attachments/<uuid>.<ext>`。id 用 `randomUUID`（不可猜）；
  单图解码后 ≤5 MB、note 每任务 ≤8 个引用、一次粘贴 ≤4 张；读取只按索引 id 查，非法 id → `bad-request`、
  未知 id → `not-found`；`upload-attachment` 请求体上限单独放宽到约 7 MB。客户端待提交图片有缩略图 /
  删除；普通文本粘贴不拦截。§2.1 / §3.1 / §3.3 / §5.1.1 / §5.2 / §7 同步更新。
- v0.2.0 文档同步（t-33 卡片精简）：§5.2「看板主体」原先仍写卡片显示备注 / `#t-3` / 工作区 tag /
  相对时间 / 组长 / 执行者 / result / `lastError`；t-33 已把卡片改为「标题 + 操作按钮」，
  这些信息只在详情浮层展示，本次按实现同步该段；同时删掉详情段里的「提醒次数」（实现从未展示，
  单测也断言不出现）。
- v0.2.0 文档同步（§1.8 写盘失败口径）：`handleSubagentEnd` 实际不检查 `commitBoard` 返回值
  （写盘 best-effort，失败只 `console.warn`），原文「end 路径写盘失败也记 `leadAuto.lastError`」与代码
  不一致；改为写清 dispatch / end 两条路径的差异（只有 dispatch 检查返回值并记 `leadAuto.lastError`）。
- v0.2.0 收尾（t-34：文档漂移 + 附件边界）：§5.1 表与 §5.1.1 第 4 条原先仍写卡片带「工作区 tag」，
  t-33 后 `Card` 只渲染标题 + 操作按钮（`tb-card-tag` 已不存在），按实现改为「卡片只显示标题 + 操作按钮，
  工作区等信息在详情浮层」；`lib/client.js` 文件头注释与 `test/client-render.test.mjs` 的用例标题同源修正。
  删除无引用的 locale 键（`card.notified` / `card.assignee` / `card.result` / `card.workspace` / `card.lead`，
  以及同批审计出的 `card.deleteConfirm` / `page.subtitle` / `detail.status` / `lead.archivedHint`）
  与两块看板里只为卡片相对时间服务的 `bind.now` + 30s `setNow` 定时器（t-33 后是纯重渲染死状态；
  `fmtAgo` 作为纯函数测试口保留）。同批修掉 §5.5 两处同源漂移（卡片不再显示「组长 / 执行者」；
  主会话归档只显示「已归档」，不再声称有换绑提示）。附件边界：粘贴前按 `file.size` 预检单图 5 MB（超限提示、不发请求）、
  `uploading` 改成计数（连续粘贴不会提前解除提交禁用）、提交前统计 note 引用 > 8 给具体提示
  （与服务端文案同源）、同批上传单个读取 / 上传失败不丢已成功图片（逐项 catch）、详情附件缓存只淘汰
  已就绪的最旧项；Host 新增 `truncateNote()`：4000 字符截断不切出半截 `attachment://` 引用（§2.1 同步口径），
  `bodyLimitFor()` 明确只有 `upload-attachment` 放宽请求体上限。单测补 12 条（截断 / 请求体上限 /
  handleHttp 405·415·403 / 5 MB 预检 / 上传计数与 Enter / 8 引用预检 / 缓存淘汰 / 加载失败占位 / 部分失败）。
- v0.2.0 收尾补充（t-34：裸引用截断兜底）：`stripPartialAttachmentRef` 原先只清理「半个 `attachment://`
  协议前缀」，裸引用 `attachment://<uuid>` 的 UUID 被 4000 字符边界切断时会残留半截 id（坏链接 / 死文本）。
  增加第 4 条兜底：前缀完整但 id 不是完整 UUID → 整段丢掉；完整 UUID 照常保留（§2.1 同步口径），
  补 1 条单测（含 `add-task` / `update-task` 同口径断言）。
- v0.2.0 修复（t-40：header 图标再点一次关闭）：会话 header 的看板按钮原先无论右栏状态都
  `openTab('taskboard')`，看板已打开时再点没有反应。改为 toggle：`sidebarRight.isExpanded() === true`
  且 `sidebarRight.active().kind === TAB_KIND` 时调 `sidebarRight.hide(active().id)`——0.2.2-rc.1 实测
  docked 折叠整列、floating 关闭浮层，tab 记录保留供下次展开；其它情况（没开 / 已收起 / 活动 tab 是别的）
  仍 `openTab` 打开并聚焦。`active` / `isExpanded` / `hide` 任一缺失或抛错都退回 `openTab`，右栏服务缺失时
  仍只 `console.warn`、不抛错（打开路径的「会话刚切过来重试一次」保留）。header 的 `onClick` 改成箭头函数，
  避免把事件对象当 `retry` 传进 `openBoard`（原先重试实际不生效）。§5.0 / §5.1 / §7 同步；
  `test/client-render.test.mjs` 扩 `sidebarRight` 桩（`active` / `isExpanded` / `hide`）并补 3 条用例。
- v0.2.0 新增（t-38：归档满 30 分钟自动删除）：`archived` 任务归档满 30 分钟后由宿主自动从
  `board.json` 的 `tasks[]` 里**物理删除**，用户不必手动点「删除」。新增导出常量
  `ARCHIVE_RETENTION_MS = 30 * 60 * 1000` 与纯函数 `pruneArchivedTasks(state, now, retentionMs)`：
  只处理 `status==='archived'`；归档时间优先 `archivedAt`，缺失 / 不可解析时回退 `updatedAt` → `createdAt`，
  三者都不可解析时**保守保留**（不误删时间坏掉的任务）；`now - 归档时间 >= 30 分钟` 即删（满 30 分钟，边界即删）；
  删除后 `revision` +1（`commitBoard`），**`nextId` 不回退**（已删除任务的 id 不复用）；未过期任务保持原顺序
  （原地改写 `state.tasks`，数组引用不变）。清理点：`runTick` 在 `pollEnabled` 判断**之前**
  （暂停轮询也清理，且不阻塞派发 / 完成回执）+ `apply()` 启动时一次（宿主停机期间到期的归档不必等第一个 tick）；
  没有过期任务时**不写盘、不改 revision**；清理异常 / 写盘失败只 `console.warn`（best-effort）。
  UI 侧**没有**加「归档 30 分钟后自动删除」提示：`lib/client.js` 同期由 t-40 改 header 图标 toggle，
  避免同文件并发冲突，留待后续单独补（不影响功能）。§1.2 增加「归档生命周期」段，§1.4 / §2 同步；
  `test/host.test.mjs` 补 3 条：纯函数删除窗口（31 分钟删 / 29 分钟留 / 正好 30 分钟删 / 非 archived 不删 /
  `nextId` 不回退）、时间字段回退与不可解析保留、`pollEnabled=false` 时 tick 仍清理并落盘且无过期不写盘。
- v0.2.0 修复（t-39：任务「对话」打开真正执行任务的 worker 会话）：原先卡片「对话」与详情「执行对话」
  都优先 `task.dispatchedSessionId`（= 任务被投递到的组长会话），点进去是组长对话，不是真正干活的子会话。
  现在新增纯函数 `workerSessionOf(task)`：只有 `task.assignee` 非空且形如 `session-…` 或裸 UUID
  （宿主 `subagentId`）时才算 worker 会话；`worker-42` / `main` 这类普通标签不算会话（详情「执行者」行照常显示标签）。
  `sessionOf(task)` 重构为 worker → `dispatchedSessionId`（组长）→ `sessionId`（发起）→ 老 Host 的
  `poll.lastDispatchSessionId` 兜底（§5.2）；卡片「对话」按钮 `title` 写实际跳转的会话 id。
  详情「关联对话」拆成三个各自可点的按钮：「发起对话」= `task.sessionId`、「执行对话」= worker
  `assignee`、「组长对话」= `dispatchedSessionId`（新增 i18n key `detail.leadSession`，zh「组长对话」/
  en「Lead conversation」；与 worker / 发起会话相同则不重复显示），都没有时保留「（这条任务还没有关联对话）」。
  poll 兜底语义不变，但按新语义显示为「组长对话」（兜底会话是派发到的组长会话，不再冒充 worker）；
  发起对话与 doing 兜底 A/C/D 的既有行为保留。只改 Client 半（`lib/client.js`）+ 渲染测试，Host 不动。
  `test/client-render.test.mjs` 更新卡片用例（worker 优先 / 只有 assignee / 非会话标签不出按钮）与详情用例
  （三按钮 / dispatched-only 只显示组长对话 / 无会话 muted），补 1 条 `workerSessionOf` 纯函数用例；
  §1.3 / §2 / §5.2 / §5.5 同步。
- v0.2.0 修复（t-42：任务卡片标题与按钮之间多出一整块空行）：t-33 的等高靠
  `.tb-card-fixed{min-height:var(--tb-card-h,108px)}` + `.tb-card-fixed .tb-card-actions{margin-top:auto}`，
  但 2 行标题 + 单行按钮的内容只有约 79px，卡片被 108px 撑高后 `margin-top:auto` 把多出来的约 29px
  全变成标题与操作行之间的空行。现在**去掉整卡 `min-height`（连同无写入方的死变量 `--tb-card-h`）与
  操作行 `margin-top:auto`**，等高改为给标题固定 2 行高度（`.tb-card-fixed .tb-card-title` 加
  `min-height:2.8em`，保留 `-webkit-line-clamp:2` / `line-height:1.4`）：1 行与 2 行标题的标题块同高，
  标题与操作行之间只剩 `gap:5px`，卡片高度由内容决定（2 行标题 + 单行按钮约 81px，含边框）。
  窄栏按钮换 2 行时卡片自然变高——不裁按钮的取舍，不用整卡固定高度硬压。行内编辑态照旧不带
  `.tb-card-fixed`、高度自适应（实测 142px）。浏览器实测（3080 右栏看板，13 张卡片）：改后
  全部 81px、标题块到操作行一律 5px、操作行 `margin-top` 为 0；把旧规则在页面上重新套回同一张
  卡片则是 108px / `margin-top:27px` / 标题块到操作行 32px。5 个按钮在窄列换 2 行时卡片 81 → 106px、
  间距仍是 5px（按钮不裁）。`test/client-render.test.mjs` 把原先断言 `min-height:var(--tb-card-h,108px)`
  与 `margin-top:auto` 的两条改为：整卡规则无 `min-height`、无 `--tb-card-h`、操作行无 `margin-top`、
  标题 `min-height:2.8em`；`test/` 全绿。§5.2「看板主体」补「卡片高度 / 等高」段。只改 Client 半 + 文档，
  Host 不动。
- v0.2.1（发布汇总）：本批集中发布列头 / 会话 header / 卡片 / 对话跳转 / 归档清理与 t-34 收尾，
  `node --test` 189 pass / 0 fail。主要内容：
  - 列头高度 CSS：`.tb-colhead` 固定 `height:31px`（`box-sizing:border-box`，窄栏 29px），
    「全部归档」按钮不再把「已完成」列头撑高；四列标题与卡片起点对齐。
  - header 图标再点收起：看板已展开且是活动 tab 时，header 按钮调 `sidebarRight.hide()` 收起
    （docked 折叠整列 / floating 关闭浮层，tab 记录保留）；其它情况仍 `openTab`，API 缺失或异常时
    回退 `openTab`，不挡打开主路径。
  - 卡片 2 行标题等高 / 去掉空行：去掉整卡 `min-height`（含 `--tb-card-h`）与操作行 `margin-top:auto`，
    标题块固定 `min-height:2.8em`，1 行 / 2 行标题的标题块同高，标题与操作行之间只留 `gap:5px`；
    窄栏按钮换 2 行时卡片自然增高、不裁按钮。
  - 对话优先跳 worker 会话：卡片「对话」与详情「执行对话」优先 `task.assignee` 中形如
    `session-…` / UUID 的 worker 子会话；详情拆为「发起对话 / 执行对话 / 组长对话」三个可点按钮，
    普通标签不算会话，老 Host 的 poll 兜底按「组长对话」展示。
  - 归档满 30 分钟自动清理：`pruneArchivedTasks()` 物理删除归档满 30 分钟的任务，清理点在 tick
    的 `pollEnabled` 判断之前（暂停轮询也清理）与 `apply()` 启动时；`nextId` 不回退，时间字段
    不可解析时保守保留，无过期任务不写盘、不改 revision。
  - t-34 文档 / 附件边界收尾：§5.1 / §5.1.1 的卡片字段与实现对齐；删除无引用 locale 键与
    卡片相对时间的死定时器；补齐 5 MB 预检、8 引用上限、单批 4 张、上传计数、部分失败保留，
    以及 `truncateNote()` 不切断 `attachment://` 引用的文档与回归测试。
- v0.2.2 新增（t-51：看板「待你处理」闭环，组长提问 + 用户回复继续）：组长在需要用户决策时用
  任务上的 `needsUser` 标记 + `question` / `questionOptions` 提问，看板派生「待你处理」区
  （右栏顶部条 + 平台看板最左第五列，不重复出现在普通四列），用户回答后宿主 followup 给组长会话、
  清标记、任务继续；**不新增 status**，`todo` / `doing` 保持原样。
  - 任务字段（§2）：`needsUser` / `question`（≤500）/ `questionOptions`（≤4 个、每个 ≤80）/
    `askedAt` / `askedBy` / `lastAnswer`（≤1000）/ `answeredAt`。`needsUser:true` 缺 `question`
    写入端 `bad-request`、读盘端降级为未 flag；`needsUser:false` 清问题四字段、保留回答留档。
  - Host：`selectDispatchCandidates` / tick 过滤 flagged 任务（`dispatch-now` 返回 `conflict`）；
    新 RPC `answer-task {id, answer}`（目标会话 `dispatchedSessionId` → `askedBy` → `sessionId`
    逐个尝试、跳过归档候选，复用 `agents.get` / `sessionController.resolveAgent`，followup +
    `sessions.flush` 成功后才清标记，全部不可用 / 投递失败保留标记并把原因写进 `lastError`）；
    `taskboard_update` 支持 `needsUser` / `question` / `questionOptions` 并补 `askedBy`；
    `applyTaskUpdate` 先做完全部校验再写字段（失败不留部分修改），只传 `questionOptions` 不 flag →
    `bad-request`；任务进入 archived / `archiveDoneTasks` / `requeueTasksOfLead` 都清问题四字段；
    **归档优先**：`{status:'archived', needsUser:true}` 漏 `question` 也照样归档（跳过 needsUser /
    question / options 校验，标记清空）；**重设 `question` 不带 `questionOptions` 清空旧选项**；
    `askedBy` 只在同一次调用里同时设置 `question` / `needsUser:true` 时生效，单独传被忽略；
    `answer-task` 对已归档任务直接 `conflict`「任务已归档，不能再回答」（不投递、不写 `lastAnswer`）；
    `buildDispatchText` 带 `用户最近回答：…`；`taskboard_list` / `taskBrief` 暴露
    `needsUser` / `question` / `questionOptions`（`taskBrief` 从 7 个键扩到 10 个已声明键，
    `TASK_LIST_OUTPUT_SCHEMA` / `TASK_ONE_OUTPUT_SCHEMA` 同步）；`add-task` / `update-task`
    接受同名可选字段（含 `askedBy`）。
  - Client：`needsUserTasks()` 派生列表（排除 archived、`askedAt` 最旧优先）不再进普通列；
    右栏顶部「待你处理 N」条、平台看板第五列「待你处理」（问题最多两行）、详情浮层「需要你处理」区
    （选项按钮 + 自由输入 + 「回复并继续」+ 错误提示不丢输入；「最近回答」在 flagged 分支外，
    `lastAnswer` 非空即显示）；header `.tb-headbtn` 与左侧栏图标增加独立 needsUser 红点角标
    （与右栏看板同一 `tasksForWorkspace` 过滤）；i18n zh/en 新增 `column.needsUser`
    与 `needsUser.*`（无 `needsUser.empty` 死键）；CSS 适配窄栏。
  - 文档：§1.2 / §1.4 / 新增 §1.9 / §2 / §3.1 / §3.3 / §4.4 / §5.1 / §5.1.1 / §5.2 / §5.3 /
    §6 / §7 第 12 项同步；`presets/taskboard.patch.yml` 组长 persona 增加第 7 条
    「需要用户决策时用 needsUser + question/options，不要只写 lastError 或聊天」。
    `package.json` 版本号不在本任务里 bump（发布流程统一处理）。
- v0.2.2（发布汇总）：发布「待你处理（needsUser）」闭环——组长需要用户决策时不再只能写 `lastError`
  或停在对话里，而是把问题挂到任务上、由看板收集回答、宿主 followup 回组长会话继续干活。
  `node --test` **218 pass / 0 fail**（v0.2.1 基线 189，+29）；真机链路已验证（t-51：组长设置
  needsUser → 看板「待你处理」→ 用户回答「发」→ 组长收到「【任务看板 · 用户回复】」继续）。
  主要内容：
  - 新增字段：`needsUser` / `question`（≤500）/ `questionOptions`（≤4 个、每个 ≤80）/ `askedAt` /
    `askedBy` / `lastAnswer`（≤1000）/ `answeredAt`；**不新增 status**，flagged 任务仍是 `todo` /
    `doing`，只是带标记（§2 / §1.9）。
  - 提问与回答：`taskboard_update` 支持 `needsUser` / `question` / `questionOptions`（同时补
    `askedBy`）；宿主新增 RPC `answer-task {id, answer}`，把回答 followup 给组长会话、投递成功后才清标记。
  - 轮询跳过：`selectDispatchCandidates` / tick 过滤 flagged 任务，`dispatch-now` 返回 `conflict`，
    用户没回答前不会把问题任务当普通 todo 重新派发（§3.1 / §3.3）。
  - 看板：右栏顶部「待你处理 N」条 + 平台看板最左第五列「待你处理」+ 详情浮层回答区（选项 / 自由输入 /
    「回复并继续」）+ header 与侧栏图标的红点角标；flagged 任务不进普通四列（§5.1 / §5.1.1 / §5.2 / §5.3）。
  - 边界：写入端先校验后落字段——`needsUser:true` 缺 `question` → `bad-request` 且**零修改**、不留
    部分字段；`answer-task` 目标会话按 `dispatchedSessionId` → `askedBy` → `sessionId` **回退**、
    跳过归档候选；归档（`archiveDoneTasks`）与组长重排（`requeueTasksOfLead`）都清问题四字段，且
    **归档优先**——`{status:'archived', needsUser:true}` 漏 `question` 也照样归档；**重设 `question` 不带
    `questionOptions` 时清空旧选项**；`lastAnswer` **随派发文本**（`buildDispatchText` 带
    「用户最近回答：…」）交给下一个执行者。
  - 测试与文档：`node --test` 218/0（+29 条 host / client / render 回归）；§1.2 / §1.4 / §1.9 / §2 /
    §3.1 / §3.3 / §4.4 / §5.1 / §5.1.1 / §5.2 / §5.3 / §6 / §7 与 `presets/taskboard.patch.yml`
    组长 persona 同步。
