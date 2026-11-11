# dsh-taskboard —— 任务看板 + 派单模式

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的插件，解决一个具体问题：

> **让主 Agent 别自己干活。** 主 Agent 只拆解、派单、审核、汇报；具体工作全部交给子 Agent。
> 你在侧边栏看板上往「待开始」丢任务，插件轮询到就送给主 Agent 派发，子 Agent 干完自动回报，
> 主 Agent 审核通过后把看板状态改成「已完成」，你只负责看结论和归档。

## 界面

- **侧栏图标**：侧栏面板列表里多一个看板图标（带待开始数量角标），点开是完整看板页。
- **四列看板**：待开始（蓝） / 进行中（黄） / 已完成（绿） / 已归档（灰）。
  - 「待开始」列可以自己加任务（标题 + 备注/验收标准），也可以选派发给哪个会话；
  - 卡片按钮：开始 / 立即派发 / 完成 / 打回 / 归档 / 重新打开 / 编辑 / 删除；
  - 顶部：轮询开关、轮询间隔（5s / 15s / 30s / 60s）、一键归档已完成、同步模式预设；
  - 底部显示数据文件路径（本机持久化，不随会话结束丢失）。
- **新「模式」：派单看板模式**。安装插件后自动写入预设，在模式选择器里选它，
  主 Agent 就按派单口径工作（不写文件、不跑命令，一切派给子 Agent）。

## 安装

```powershell
# 1) 装进你的 profile（web 是 `dsh web` 默认用的那个）
dsh plugin --profile web add C:\Users\duan\Code\dsh-taskboard

# 2) 重启 web 服务（Host 半需要重新加载）
dsh web

# 3) 浏览器刷新 http://127.0.0.1:3080 —— 侧栏出现看板图标
```

> 也可以用 GUI 的插件管理器安装本地包（等价于把包 link 进 profile）。
> 卸载：`dsh plugin --profile web remove dsh-taskboard`。

「派单看板模式」由插件包自带的 `presets/taskboard.patch.yml` **声明**（dsh 0.2.2 起 preset 是
bundle patch 里的 `@deepseek-ai/dsh-agent-preset` 行，不是 `~/.dsh/.agent-presets` 目录）。
装好插件、重启 `dsh web`、刷新页面后，模式选择器里就会出现：

- **派单看板模式**（主 Agent：只拆解 / 派单 / 审核 / 汇报）
- **派单看板模式 · 执行者**（子 Agent 专用：完整执行工具集）

不需要任何额外安装步骤，也不写盘。

## 用法

1. **选模式**：新建会话时把模式切成「派单看板模式」。
2. **加任务**：侧栏 → 任务看板 → 在「待开始」列输入任务标题（可加备注写验收标准），回车。
   - 「派发给」选「自动」= 由宿主挑最近活跃的空闲会话；也可以指定某个会话。
3. **等派发**：宿主每 15s 轮询一次「待开始」。命中且目标会话空闲时，会给主 Agent 推一条
   `【任务看板 · 待开始】t-3 …` 的消息；主 Agent 把任务改成「进行中」，然后派子 Agent 去做，
   自己结束本轮（不占对话，你可以继续和它聊别的）。
4. **审核闭环**：子 Agent 完成后，运行时把完成通知送回主 Agent，它开新一轮审核：
   - 通过 → 看板任务变「已完成」，`result` 里是结论，同时向你汇报一句话；
   - 不通过 → 带着修改意见打回同一个子 Agent 重做，任务保持「进行中」。
5. **归档**：你点「归档」，或顶部「全部归档」，任务进「已归档」列，不再参与轮询。

### 轮询规则（为什么它不会烦到你）

- 「派发给」选「自动」时，优先投给**派单看板模式**的空闲会话（没有才退化到任意空闲会话）；
- 只在目标会话 **空闲**（idle）时投递，运行中不打扰；
- 每轮最多投递 1 条任务；
- 同一个任务两次提醒之间至少等 `2 × 轮询间隔`（最长 120s），最多提醒 5 次，
  超过后卡片上标「派发超时」，等你手动处理；
- 顶部可以随时暂停轮询。

## 数据与文件

| 内容 | 路径 |
| --- | --- |
| 看板数据 | `$DSH_HOME/storages/dsh-taskboard/board.json`（原子写，坏文件自动备份） |
| 模式声明 | 插件包内 `presets/taskboard.patch.yml`（随 bundle 加载，不写 `$DSH_HOME`） |

`$DSH_HOME` 默认 `~/.dsh`（Windows：`C:\Users\<你>\.dsh`）。

想改模式行为（persona、工具集）就直接改 `presets/taskboard.patch.yml` 再重启；看板页会在模式
挂载失败时显示红色诊断条（`agentPresets.list()` 的 `broken` 原文）。

## 给模型用的工具

插件在宿主级注册了三个工具，所有模式都能用：

| 工具 | 用途 |
| --- | --- |
| `taskboard_list` | 列出看板任务（可只看某个状态），派单前确认、审核时对照 |
| `taskboard_add` | 往「待开始」加任务（用户口述需求、主 Agent 拆出的后续任务） |
| `taskboard_update` | 改状态（doing / done / todo / archived）、写 result / assignee / note |

## 排障

- **侧栏没有图标**：确认 `dsh plugin --profile web list` 里有 `dsh-taskboard`，重启 `dsh web` 后刷新页面；
  浏览器控制台若有 `dsh.client` 相关报错，说明 `lib/client.js` 没被识别（检查 `exports["./client"]`）。
- **加了任务但没派发**：看页面顶部的跳过原因——
  「没有在线的会话」表示当前没有打开的会话；「目标会话正在运行」表示主 Agent 正忙；
  「轮询已暂停」就点恢复。也可以对任务点「立即派发」跳过等待。
- **模式选择器里没有「派单看板模式」**：确认插件已装进当前 profile（`dsh plugin --profile <name> list`）
  并重启了 `dsh web`；看板页顶部若出现红色「派单看板模式加载失败：…」就是某个预设行配置有误，
  照着 `broken` 原文改 `presets/taskboard.patch.yml`（常见：删了必填 config）。
- **主 Agent 还是自己干活**：确认会话用的确实是「派单看板模式」，而不是 standard。

## 开发

```powershell
node --check lib\index.js
node --check lib\client.js
node --test
```

- 契约（RPC 端点 / 任务状态机 / 快照字段 / 模式声明）：[`docs/architecture.md`](docs/architecture.md)
- RPC 探针：`node .dev/verify-rpc.mjs http://127.0.0.1:3099`（33 项断言，含错误分支）
- 验证记录（自动化 + 端到端闭环证据）：[`docs/verification.md`](docs/verification.md)
- 浏览器端调查（slot / RPC / 主题变量）：[`docs/client-notes.md`](docs/client-notes.md)
- Host 端调查：[`docs/host-notes.md`](docs/host-notes.md)
- 预设调查：[`docs/preset-notes.md`](docs/preset-notes.md)

改 `lib/client.js` 后刷新浏览器即可（client bundle 走 HMR / 页面重载）；
改 `lib/index.js` 需要重启 `dsh web`（Host 模块不热更）。

## License

MIT
