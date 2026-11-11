# dsh-taskboard 回归报告（UX 修正后）

- 时间：2026-11-11 11:02 ~ 11:09（Asia/Shanghai）
- 实例：http://127.0.0.1:3099 （dsh 0.2.2-rc.1，profile=taskboard，重启后 PID 27068；token 由 lead 提供，未重启服务、未改代码）
- 插件：dsh-taskboard v0.1.0（含「会话标题/模式名」与「角标/列高」修正的新 bundle）
- 只做回归：未重跑 e2e、未改 lib/ presets/ package.json docs/。回归产生的临时任务已清理，最终看板仅剩 archived 的 probe 任务；pollEnabled=true 已恢复。

## 结论：4/4 PASS

| # | 项目 | 结果 | 证据 |
|---|------|------|------|
| 1 | 看板四列撑满高度 + 头部「上次派发」可读（非 session-） | **PASS** | `shots/regress-board.png`、`shots/regress-board-header.png` |
| 2 | 「派发给」下拉带模式名 | **PASS** | `shots/regress-target-select.png`、`shots/regress-select-data.json` |
| 3 | 侧栏角标出现/消失 | **PASS** | `shots/regress-badge.png`、`shots/regress-badge-after.png`、`shots/regress-badge-data.json` |
| 4 | console 无报错 | **PASS** | `shots/regress-console.json`（console total=0, errors=[], warnings=[]） |

---

## 1) 列高撑满 + 头部派发对象可读 —— PASS

- 视口 1600×1000；`.tb-board` 与四列全部 `top=168 / bottom=954 / height=786px`，四列等高且一直撑到页脚上方（页脚 top=966），不再是最初的 220px 就结束；`document.scrollHeight=1000`（无多余滚动条）。
- 头部文本实测：`每 15s 轮询 · 上次检查 11:05:xx · 上次派发 11:05:24 → 74ba36fd`；另一次派发记录 `上次派发 11:03:43 → 1abdefcd`。两处都是 **8 位尾串**，不再是 `session-` 截断。
- snapshot 同时给出 `poll.lastDispatchSessionTitle` 字段（本次为 null，因为该会话 title 为空，回落尾 8 位，符合验收口径「会话标题或 8 位尾串」）。
- 证据：`shots/regress-board.png`（四列撑满）、`shots/regress-board-header.png`（头部显示「上次派发 11:03:43 → 1abdefcd」）、`shots/regress-badge-data.json`（layout 精确数值）。

## 2) 「派发给」下拉带模式名 —— PASS（preset 投影修复生效）

- 打开侧栏已有会话「派单模式自检」（session-0a81f6b1…，使其成为 live idle agent）后回看板，「派发给」下拉的选项为：
  ```
  自动（最近活跃会话）
  1abdefcd                             ← 无标题、标准模式会话 → id 尾 8 位
  74ba36fd · running · 派单看板模式     ← 派单看板模式会话（preset 投影修复生效）
  18d90872                             ← 无标题标准模式会话
  ```
- 选中后 select 显示 `74ba36fd · running · 派单看板模式`；snapshot 中该 agent 行 `preset="taskboard-dispatch"`（修复前为 `standard`）。
- 说明：该历史会话的 `agent.session.header.title` 仍为空（重启后恢复的会话不还原 header.title），因此显示 id 尾 8 位而不是会话标题；这与验收口径「若标题为空，至少应看到 · 派单看板模式 后缀」一致。
- 证据：`shots/regress-target-select.png`（下拉选中项文本可见）、`shots/regress-select-data.json`（options 全量 + agents 的 preset 字段）。

## 3) 侧栏角标出现 / 消失 —— PASS

- `ICON_POLL_MS = 6000`，角标按 6s 周期统计待开始任务数。
- 干净复测（待开始=0 时）：
  - 建任务前：badge = null
  - 新建「回归角标测试任务」后：badge = "1"（同时图标 title 变为「任务看板 · 1 个待开始任务」）
  - 点卡片「删除」并在 confirm 里确认后：badge 轨迹 `["1","1","1","1","1",null]` → 第 6 秒变 null 消失（符合 6s 轮询周期）
- 说明：第一次测时角标删完仍显示 1，是测试污染——当时遗留的回归任务 t-8 仍在「待开始」列被计数；清理后复测通过。最终看板待开始=0。
- 证据：`shots/regress-badge.png`（角标 1）、`shots/regress-badge-after.png`（角标消失）、`shots/regress-badge-data.json`（before/appeared/gone/trail）。

## 4) console 无报错 —— PASS

- 本轮共 3 次独立 Playwright 会话（board/角标、下拉、角标高净复测），每次从加载首页到操作完成全量收集 `console` 与 `pageerror`：
  - 各次 `console total=0`、`errors=[]`、`warnings=[]`、pageerror=0。
- 证据：`shots/regress-console.json`、`shots/regress-badge-data.json.console`、`shots/regress-select-data.json.console`。

## 回归副产物与清理

- 回归用临时任务：`t-8「回归：头部派发对象标签检查」`（用于验证头部派发对象标签，完成后已归档+删除）、`回归角标测试任务`（已验证角标后删除）。
- 最终 board.json：revision 62，仅 t-1/t-3/t-4/t-10 四条 archived probe 任务；`config.pollEnabled=true`；无 todo/doing/done 遗留。
- 回归中出现过的额外会话（如「回归自检就绪确认」「看板回归任务派发检查」）由页面操作/派单自然产生，未改动代码或配置。

## 复跑方式

```
$env:TARGET_URL='http://127.0.0.1:3099/?token=<启动 URL token>'
cd C:\Users\duan\.claude\skills\playwright-skill
node run.js C:\Users\duan\Code\dsh-taskboard\.dev\e2e\regress-06-badge.js   # 列高+头部+角标+console
node run.js C:\Users\duan\Code\dsh-taskboard\.dev\e2e\regress-07-select.js  # 「派发给」模式名
```
