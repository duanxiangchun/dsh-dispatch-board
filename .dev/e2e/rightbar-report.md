# dsh-taskboard 右侧栏改版验证报告

- 时间：2026-11-11 11:22 ~ 11:32（Asia/Shanghai）
- 实例：http://127.0.0.1:3099 （dsh 0.2.2-rc.1，profile=taskboard，PID 27068；服务未重启，页面刷新即加载新 client bundle）
- 版本：client bundle 为「看板搬到右侧栏」新版（header `.tb-headbtn` → `openTab('taskboard')`；右栏 tab 类型注册）；host 未改
- 视口 1600×1000；仅写 .dev/e2e/，未改 lib/ presets/ package.json docs/
- 布局规则按 lead 最新口径：全屏或宽度≥900 → 四列；560–900 → 两列网格；<560 → 纵向 lane

## 结论：6/6 PASS

| # | 项目 | 结果 | 证据 |
|---|------|------|------|
| 1 | 会话 header 入口按钮（含角标）→ 右栏 tab + 面板内容 | **PASS** | `rb-01-header-entry.png`、`rb-02-panel-default.png` |
| 2 | 右栏面板内新增任务 → 待开始出现卡片 → 删除 | **PASS** | `rb-03-task-added.png`、`rb-04-task-deleted.png` |
| 3 | 全屏切四列 / 拖窄切 4 lane（两种形态可互切） | **PASS** | `rb-05-fullscreen.png`、`rb-07-narrow-lane.png`、`rb-06-after-fullscreen.png` |
| 4 | 右栏引导页「任务看板」入口卡片 → 点开看板 tab | **PASS** | `rb-08-guide.png`、`rb-09-guide-open-board.png` |
| 5 | 左侧菜单不再有看板项 | **PASS** | 左栏只剩 插件/自动化任务/更多（`rb-01-header-entry.png` 左栏） |
| 6 | console 无报错 | **PASS** | `rb-console.json`（total=0, errors=[], warnings=[]） |

---

## 1) header 入口按钮 + 右栏 tab —— PASS

- 打开「派单模式自检」会话后，会话 header 右侧出现按钮：
  - `.tb-headbtn`，`aria-label="打开任务看板（右侧栏）"`，`title="任务看板"`
  - 角标：待开始=0 时无角标；面板内新增 1 条待开始任务后角标变为 `1`（`rb-01-header-entry.png` 顶部按钮上的 1）
- 点击按钮 → 右侧栏打开，tab 条出现 chip `.tb-tabtitle`（看板图标 + 「任务看板」），面板内渲染看板（`rb-02-panel-default.png`）。
- 默认右栏宽度实测 **719px** → `data-layout="medium"`、`data-narrow="false"`、`.tb-board` 计算样式 `grid-template-columns: 335.5px 335.5px`（= 两列网格：待开始/进行中一行，已完成/已归档一行）。与 lead 说明的「默认约 685px → 两列网格」一致（本机默认 719px，仍在 560–900 区间）。
- 窄栏 lane 形态见第 3 项（拖窄到 398px 后出现 4 个纵向 lane）。

## 2) 面板内新增 / 删除任务 —— PASS

- 先在面板顶部点「暂停轮询」（避免主 Agent 立刻接活），再在面板输入框填「RS 验证：面板内新增任务」→ 点「添加到待开始」。
- 待开始列出现卡片（t-17，含 开始/立即派发/编辑/删除 按钮）→ `rb-03-task-added.png`。
- 点卡片「删除」→ 浏览器 confirm「删除任务「RS 验证：面板内新增任务」？」自动接受 → 卡片消失，待开始计数回到 0 → `rb-04-task-deleted.png`。
- 验证后已点「恢复轮询」，最终看板只剩 1 条 archived probe 任务（t-15），无残留。

## 3) 全屏四列 / 拖窄四 lane —— PASS

| 形态 | 触发 | 实测 |
|------|------|------|
| 默认（分栏） | 打开 tab | 宽 719px，`data-layout=medium`，`.tb-board` 两列网格（335.5px ×2），4 个状态列分两行 |
| 全屏 | 右栏头部按钮「全屏」 | `data-layout=wide`，面板宽 1599px，`.tb-board` `grid-template-columns: 381.75px ×4`（四列横排）→ `rb-05-fullscreen.png` |
| 退出全屏 | 再点「全屏」 | 回到宽 719px、medium 两列 → `rb-06-after-fullscreen.png` |
| 窄栏 | 鼠标拖动右栏左边界到 `left=1202`（宽 398px < 560） | `data-layout=narrow`，`.tb-lanes` 出现、`.tb-board` 消失，4 个纵向 lane：待开始 / 进行中 / 已完成 / 已归档 → `rb-07-narrow-lane.png` |

- 结论：三档阈值（wide ≥900 / medium 560–900 / narrow <560）按新规则生效；拖动可达到 lane 形态。

## 4) 右栏引导页入口 —— PASS

- 关闭看板 tab 后，右栏回到引导页（空布局）；重新打开右栏（「打开右侧边栏」）可见引导卡片：
  - **任务看板** —— 「看板在右侧栏里：待开始 / 进行中 / 已完成 / 已归档，主 Agent 会自动挑待开始的任务派发。」（与 工作区文件 / 新建终端 / 更多工具 并列）→ `rb-08-guide.png`
- 点击该卡片 → 右侧栏打开看板 tab，`.tb-page` 出现且 `data-layout=medium` → `rb-09-guide-open-board.png`。

## 5) 左侧菜单不再有看板项 —— PASS

- 左栏 `.panelRow` 实测只有：`["插件","自动化任务","更多"]`；全页 `aria-label="任务看板"` 的左侧入口不存在（`sidebar.panellist` 已移除）。`rb-01-header-entry.png` 左侧可见。

## 6) console / pageerror —— PASS

- 三轮独立浏览器会话全量收集 console 与 pageerror：**total=0，errors=[]，warnings=[]，pageerror=0**。
- 证据：`shots/rb-console.json`、`shots/rb-data.json`、`shots/rb-guide-data.json`。

## 备注

- 验证期间会话里有一条「如何处理幽灵 probe 任务」的追问卡片，是历史 verify-rpc 探针任务被打断留下的，与本轮右侧栏改版无关；lead 已说明修复探针脚本。
- 拖窄/全屏均为纯 UI 操作，未触发任何看板任务派发（新增任务时轮询已暂停）。

## 复跑方式

```
$env:TARGET_URL='http://127.0.0.1:3099/?token=<token>'
cd C:\Users\duan\.claude\skills\playwright-skill
node run.js C:\Users\duan\Code\dsh-taskboard\.dev\e2e\rb-03-full.js    # 入口/默认布局/增删/全屏/拖窄
node run.js C:\Users\duan\Code\dsh-taskboard\.dev\e2e\rb-04-guide.js   # header 角标/引导页入口
```
