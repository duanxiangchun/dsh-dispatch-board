# dsh 0.2.2-rc.1 Agent Preset（模式）机制调查

> 对象：已安装 dsh 0.2.2-rc.1（结论以此为准）。交叉参考旧仓库 C:/Users/duan/Code/deepseek-harness（0.1.2-alpha.1，仅对照并标注）。只读调查：未改 ~/.dsh、未装依赖、未启动服务。

## 路径缩写

| 缩写 | 路径 |
|---|---|
| $DSH | C:/Users/duan/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh |
| $PKGS | $DSH/node_modules/@deepseek-ai |
| $HOME | C:/Users/duan/.dsh |
| $PROFILE | $HOME/profiles/web |
| $OLD | C:/Users/duan/Code/deepseek-harness（0.1.2-alpha.1） |
| $PROJ | C:/Users/duan/Code/dsh-taskboard |

---

## 0. 结论速览

1. HOME 下的 .agent-presets 目录机制在 0.2.2 已废弃，没有任何宿主代码读它。官方 skill 原文：Nothing reads that directory any more.（$PKGS/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:70）。$HOME/profiles/node_modules/@deepseek-ai/dsh-agent-presets 是一条悬空软链（包已删除），是旧机制残留物证。
2. 0.2.2 的 preset = 一条 Cordis 声明行（插件 @deepseek-ai/dsh-agent-preset，config 含 id/name/description/order/plugins），随 bundle patch 层安装、由 profile 组合栈加载。内置 standard/ptc/minimal/cordis 就是 $PKGS/dsh-web-app/presets/*.patch.yml 四个文件（$PKGS/dsh-web-app/package.json:47-54）。
3. 本项目 $PROJ/preset/{preset.yml,agent.cordis.yml} 与 lib/index.js 的 installPreset() 是 0.1.x 机制产物，在 0.2.2 上完全无效（不报错，也不会出现在选择器里）。必须改成 bundle 声明（推荐）或运行时 register()。
4. preset 行里 bare 包名从进程级 runtime resolution 解析（安装树依赖闭包 + profile 已装包），基准是 registry 的 ctx.baseUrl = profile 目录，不是任何 preset 目录。第三方包可写 name: dsh-taskboard 或 dsh-taskboard/tools（需 exports）。相对路径 ./x.mjs 相对 profile 目录解析，不能再指 preset 自带文件。
5. 宿主级 ctx.tools.register() 的工具对所有 preset 的 agent 可见（工具注册表 = host 全局层 + per-scope 层叠加，agent 继承全局层，ctx.tools.restrict() 只能按 agent 收窄）。看板工具用宿主级注册是对的，preset 里不必再挂工具行。
6. 子 agent 默认 join 父 agent 那一代 preset 组合（同一份挂载 = 同一套工具 + 同一套 persona），不是复制工具目录（$PKGS/dsh-subagent/lib/types/child-agent.d.ts:84；$PKGS/dsh-agent-preset-registry/lib/index.js:717-728）。要给孩子不同工具集/persona，必须 tool-subagent 配 agentPreset: worker（fork 后端不支持）。
7. 0.2.2 删除了 tool-subagent 的 persona / toolFilter / backgroundMode：检测到 persona/toolFilter 会直接抛错（$PKGS/dsh-tool-subagent/lib/index.js:346）。
8. persona.suffix 里写 {{cwd}} 变量会让每个请求在组装前失败——官方 README 点名要求移除 Your working directory is {{cwd}}.（$PKGS/dsh-system-prompt/README.zh.md:80）。现有 preset 第 21 行正是这句。
9. preset 是 eager 挂载、每声明一次、跨 session 共享 revision；修改只影响之后创建/绑定的 agent；切换 preset 只允许空白会话（$PKGS/dsh-agent-preset-registry/lib/index.js:766-786）。
10. UI 列表靠 agentPresets/list 现读，无注册步骤；但只有提供了 name 的 preset 才被当作自定义分组（$PKGS/dsh-client-ui-agent-preset/lib/client.js:1275-1277）。

---

## 1. Lead 的 5 个优先问题

### Q1 .agent-presets 是否启动时扫描一次？新增 preset 必须重启 dsh web 吗？

前提已变：0.2.2 根本不扫描这个目录。

- 注册表 README 原文：注册表不扫描目录，也不接受 preset 路径。官方迁移指引写明现在没有任何东西读这个目录（SKILL.md:70）。
- 全安装 grep agent-presets 只命中 skill 文档、README 链接、两个前端导航 id；$PKGS 下不存在 dsh-agent-presets 包；$HOME/profiles/node_modules/@deepseek-ai/dsh-agent-presets 是悬空软链。
- 旧版才有：COMPOSITION_FILE = agent.cordis.yml（$OLD/packages/preset/agent-presets/src/discovery.ts:37）、USER_PRESET_DIR = .agent-presets（:51）、每次读 roster 都重扫（:5 注释、:289 scanRoot），根顺序 shipped -> 配置 roots -> 用户根（src/index.ts:234-236、:477），前者先赢（旧版也不能用同名覆盖 standard）。

0.2.2 新增 preset 两条路，都不需要重启：

- bundle patch 声明：Web profile 的 HMR 是开的（base 的 hmr 行 disabled: !!js "!ctx.get('profileContext')"，$PKGS/dsh-base/cordis.patch.yml:27-32），profile 配置变化会热重组合；HMR README 明确无需重启（$PKGS/dsh-hmr/README.zh.md:49、:73 新包入口在 Loader entry 重启时生效）。
- 运行时 ctx.agentPresets.register() 立即生效（进程内）。
- 但已存在会话不会换组合；GUI roster 无变更推送，客户端只在连接重置/设置更新时重读（$PKGS/dsh-client-ui-agent-preset/README.zh.md 理解实现）——装完刷新一次页面最稳（install_bundle 是否触发 client 重读未实测）。
- 例外：安装改到宿主依赖时结果会带 restartReason（如 package-moved）。

### Q2 preset 支持哪些字段？

0.2.2 没有 preset.yml，等价物是声明行的 config（$PKGS/dsh-agent-preset/lib/index.js:13-19）：

| 字段 | 必填 | 说明 |
|---|---|---|
| id | 是 | 稳定标识，会话保存/恢复用；重复 id 时后一条注册抛 Duplicate agent preset（$PKGS/dsh-agent-preset-registry/lib/index.js:489） |
| name | 否 | 展示名；提供 name 即被判为自定义预设（影响分组与是否显示官方 guide） |
| description | 否 | 卡片一行说明 |
| order | 否 | roster 排序（list() 按 order ?? Infinity 再按 id） |
| plugins | 是 | Cordis entry list（子插件行） |

没有 icon/version/tags/hidden。旧版 preset.yml 只有 name/description/order（$OLD/.../metadata.ts:25-38），id 来自目录名。版本标记只能写进 description。

### Q3 row 的 bare specifier 相对哪里解析？外部插件能否在 preset 里挂自己的工具行？

解析基准 = 进程级 runtime resolution，父锚点是 profile 目录（$PROFILE），不是 preset 目录。证据链：

1. mountPreset 把 registry 的 ctx.baseUrl 传给 mount：tree.root.update(prepareProfileEntries(ctx, plugins, ctx.baseUrl))（$PKGS/dsh-agent-preset-registry/lib/types/mount.js:189，lib/index.js:226）。
2. registry 用自己的 ctx（不是声明行 ctx）：const context = this.ctx（lib/index.js:487）；scope.ctx.extend({ baseUrl: record.context.baseUrl })（:517）。registry 是 profile 根树 row -> baseUrl = profile 的 cordis.yml 所在目录（$DSH/lib/profile-boot-e2mS45fC.js:202-210 注释）。
3. Loader 导入：cordis: 内建；有 loader.internal（DSH 必有）就用 loader.internal.import(name, ctx.baseUrl)；否则相对名 new URL(name, ctx.baseUrl)，包名走 createResolve(ctx.baseUrl)（$PKGS/cordis-plugin-loader/lib/index.js:337-354）。
4. 启动器给 Node 装了解析拦截（PluginPackages + installRuntimeInterception，$DSH/lib/profile-boot-e2mS45fC.js:305-307，$PKGS/dsh-app-boot/lib/index.js:2632、:4251）；表里含安装树依赖闭包（scope installation，所以全部 @deepseek-ai/dsh-* 可用）与 profile 已装包（scope profile）（:1495-1577）；路由规则 target.scope === installation || layer.active（:2450-2457）-> 第三方包只要作为 profile 包被激活就能解析。
5. 相对路径不会被锚定到 patch 文件：anchorInsertedPluginNames 只递归 insert 顶层 row 与 group.config（:4717-4726），不进 config.plugins -> preset 里的 ./x.mjs 留在原地、按 profile 目录解析，必然找不到包内文件。
6. 需要定位包内资源时用 !!js + baseUrl（官方 cordis preset 的 skill-filesystem 写法）：createRequire(baseUrl).resolve('包名/package.json')。表达式求值环境是 new Function('ctx','expr','with(ctx){return eval(expr)}')（loader lib:359-364），baseUrl 是 ctx 属性（:208；src/index.ts:91-92）。

结论：能挂自己的工具行，前提是包为本 profile 已装包且 package.json 声明了 exports 子路径：

~~json
"exports": { ".": {"default":"./lib/index.js"}, "./tools": {"default":"./lib/tools.js"} }
~~
~~yaml
- id: taskboard-tools
  name: 'dsh-taskboard/tools'
~~

但对 dsh-taskboard 通常不需要：工具已宿主级注册（见 Q4），全模式可见。

### Q4 宿主级 ctx.tools.register 的工具对所有 preset 的 agent 可见吗？

可见。工具注册表是 host 全局层 + per-scope 层叠加；ctx.tools.restrict(filter) 的语义是对单个 agent 继承的全局工具应用允许/拒绝掩码（$PKGS/dsh-tools/README.zh.md 按 agent 限制工具）——说明全局工具默认被每个 agent 继承、可按 agent 收窄。旁证：官方 Web 组合必须逐条把 base 的 host 级 tool-* 行 disabled，正是因为留在 host 就所有 agent 都看得见（$PKGS/dsh-web-app/cordis.patch.yml:467-484）。本项目 lib/index.js:992-995 的注释与 0.2.2 行为一致，可保留。取舍：宿主级 = 全模式可见（看板工具正合适）；preset 行 = 只在挂载该 preset 的 agent 可见（或用于遮蔽宿主同名工具）。不建议同一工具双注册。

### Q5 现有 $PROJ/preset/agent.cordis.yml 会不会挂载失败？逐项体检

| # | 位置 | 问题 | 后果 | 依据 |
|---|---|---|---|---|
| 1 | 整个目录 | 放在包内 preset/ + preset.yml，而不是 bundle 声明 | 完全不生效（选择器里没有） | §1 |
| 2 | :21 | persona.suffix 里的 {{cwd}} 变量 | 每个请求组装期抛错，会话发不出请求 | $PKGS/dsh-system-prompt/README.zh.md:80 |
| 3 | :177-185、:192-200 | tool-subagent 的 backgroundMode / persona / toolFilter | apply 直接抛错 -> 整个 preset 挂载失败 | $PKGS/dsh-tool-subagent/lib/index.js:346（is no longer supported; configure persona and tool plugins in an Agent Preset and select it with agentPreset (spawn only)） |
| 4 | :169-170 | name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' | 0.2.2 该包 exports 只有 . -> 导入失败；list_agents 已在主入口一起注册 | $PKGS/dsh-tool-subagent-control/package.json exports；其 README 主入口一起注册 send_message/interrupt_agent/list_agents |
| 5 | :208-213 | tool-ralph（disabled: true，config subagentProvider/maxRounds） | 没问题：包存在、Config 字段一致 | $PKGS/dsh-tool-ralph/lib/types/index.d.ts |
| 6 | :204-206 | tool-workflow disabled: true | 没问题 | $PKGS/dsh-tool-workflow/lib/types/index.d.ts |
| 7 | :109-147 | isolate 用法（planMode / compaction+toolResultPruner / workflowEngine） | 没问题，与官方 standard 同款；没有提供服务却未 isolate 的 row | $PKGS/dsh-web-app/presets/standard.patch.yml:71-121 |
| 8 | :81、:85 等 | disabled: !!js process.platform ... | 没问题，官方同款 | 同上 |
| 9 | :79-105 | 主 agent 保留 bash/pwsh/fs/jobs/skill | 不会失败，但与 persona 不自己干活矛盾；子 agent 继承同一组合，删掉反而让孩子没工具 | child-agent.d.ts:84 |
| 10 | 缺失 | 没有 id/name/description/order（在 preset.yml 里） | 声明不合法（id 必填） | §Q2 |
| 11 | :22-68 | persona 提到 taskboard_* 工具 | 没问题（宿主级注册，全模式可见） | §Q4 |
| 12 | :224-228 | tool-web 挂在主 agent | 不失败，但与一切调查都派发冲突，建议移除 | 设计取舍 |

最小修复清单：1) 改 bundle 声明格式并补 id/name/description/order；2) 删 cwd 变量；3) 删 persona/toolFilter/backgroundMode（或改双 preset + agentPreset）；4) 删 list-agents 行；5) 重新考虑主 agent 的 shell/fs 是否保留（见 §7）。

---

## 2. 发现机制与优先级（完整版）

组合 = 空根（$PROFILE/cordis.yml 只有 []）上叠 patch 层，层序（$DSH/lib/profile-boot-e2mS45fC.js:225-231 注释 + $PKGS/dsh-app-boot/lib/index.js:1908-1918 实现）：

1. package.json 的 dsh.profile.bundles，按序展开每个 bundle 的 dsh.bundle.patch（可数组）；
2. profile 用户层 $PROFILE/cordis.patch.yml；
3. home 用户层 $HOME/cordis.patch.yml（机器本地，优先级高于 per-profile；当前不存在）；
4. --patch 覆盖层；
5. 遥测层。

同 row id：后层整体替换（config 整块替换、不深合并）：$PKGS/cordis-plugin-include/lib/index.js:229-266。内置 preset 的 row id 约定 preset-<config.id>（SKILL.md:24），覆盖内置必须按 row id（如 preset-standard）重述完整 plugins（SKILL.md:54-66）。

同名 config.id 不覆盖：第二条 register 抛错（$PKGS/dsh-agent-preset-registry/lib/index.js:489）-> 自定义必须用新 id。

当前 $PROFILE/cordis.patch.yml 的 agent-preset-registry 被用户层覆盖为 default: standard + selectedDefault: ptc。

## 3. 挂载语义

### 3.1 每进程一次 != 每 agent 一份

- 每条声明在 register() 时 eager 挂载一次，得到 generation（scope + 内存 Loader 树）：$PKGS/dsh-agent-preset-registry/lib/index.js:486-510、:511-537。
- 所有选它的 agent 通过 bindScopeParent(agentKey, generationKey) 共享：:670-696；子 agent 默认 join 父的那一代：:717-728。
- readDocument 只读渲染 YAML，无写回接口（:629-647）。

### 3.2 isolate realm 规则

- preset 行若提供服务，必须把提供者与消费者放进同一个 cordis:group 的同一 isolate realm，否则服务写进根 realm -> 审计拒绝整个 mount：Preset services require isolate realms: <names>（$PKGS/dsh-agent-preset-registry/lib/types/mount.js 的 mountPreset/leakedServices；lib/index.js:230）。
- 现成范例：planning{planMode}、compaction{compaction,toolResultPruner}、delegation{workflowEngine}。
- 隔离 realm 不沿 agent scope 传播；读 preset 私有服务用 agentPresets.serviceFor(agent,name)（:741-744）。

### 3.3 host plane 判定

权威注释（$PKGS/dsh-web-app/cordis.patch.yml:467-484）：判据原文 a host row that injects a service is the criterion for host-plane ownership；Web 面禁用 base 的这些行，让每个 session 挂 preset。

- 必须留 host：agents/sessions/storage/settings/agent-loop/system-prompt 注册表/tools 注册表/jobs 注册表/skill 注册表/goal 服务/token meter/subagents 注册表/mcp/webserver/api/client-ui/workspace/schedule/shell-env/working-directory。
- 可进 preset：面向模型的 row（工具、persona、prompt 段落、命令、委派工具）。Web 面把 base 的 host tool row 全 disabled（:484-584）。
- 生命周期：空白会话可切（:766-786，非空白 agent-preset/locked）；重启恢复用记录的 preset id 当前定义，缺失拒绝恢复（README）。

## 4. 外部插件如何安装/更新自己的 preset

### 4.1 纠正前提

不要写 $HOME/.agent-presets/<name>/（§1）。$PROJ/lib/index.js:113、:489-560、:797-800、:1135-1139 的 installPreset/inspectPreset/install-preset 在 0.2.2 是死代码。

### 4.2 方案 A（推荐）：自家 bundle patch 声明

一个包可同时是插件 + bundle（先例：$HOME/profiles/web/node_modules/dsh-plugin-capabilities 与 dsh-ollama-statistical 都有 dsh.bundle.patch + 主入口 + dsh.client；后者 patch 注释：名字解析自 profile 的 node_modules）。

```json
"dsh": { "bundle": { "patch": ["./cordis.patch.yml", "./presets/patch.yml"] } }
```

```yaml
# presets/patch.yml
- insert:
    - id: preset-taskboard-dispatch
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: taskboard-dispatch
        name: 派单看板模式
        description: 主 Agent 只拆解/派单/审核/汇报（dsh-taskboard v0.1.0 预设）
        order: 40
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                你是一个调度型编码 Agent（dispatcher）...
          # ... 见 §7 行清单
```

安装：plugin_manager {action:'install_bundle', target:'绝对目录'}（$PKGS/dsh-plugin-manager/lib/types/tools.js:71-100）或 dsh plugin --profile web add ./dsh-taskboard。

建议加 engines.dsh（兼容性预检只认 engines.dsh 或 @deepseek-ai/dsh* peer，$PKGS/dsh-app-boot/lib/index.js:1129-1144；不兼容会把行 disabled 并打 stderr，:3091-3096）。

### 4.3 方案 B（备用）：apply() 里运行时注册

API：ctx.agentPresets.register(definition) -> disposer（$PKGS/dsh-agent-preset-registry/lib/types/index.d.ts）。dsh-agent-preset 自己就这么做（其 lib/index.js 的 [Service.init]）。

```js
export const inject = ['agentPresets']
const ID = 'taskboard-dispatch'
async function ensurePreset(ctx, plugins) {
  const list = await ctx.agentPresets.list()
  if (list.some(p => p.id === ID)) return          // 已由 bundle 或别的实例注册，绝不重复
  const dispose = await ctx.agentPresets.register({ id: ID, name: '派单看板模式', description: '...', order: 40, plugins })
  ctx.effect(() => dispose, 'taskboard.preset')
}
```

风险（未实测）：官方明确不要在某个 Host row 自己的激活里跑 diagnostic（会等 Host 树结算）；register 走 activate -> mountPreset，启动时序有风险，建议放到启动完成后的钩子。运行时注册不落 patch 文件，重启要重新注册，plugin_manager list_plugins 里也看不到这条 row。生产用 A，B 只兜底。

### 4.4 扫描/重启结论

- 声明不是被扫描，是 Loader 普通 row：启动加载 + HMR 热重组合（base 的 hmr 行 root:[]，Web profile 开）。
- HMR README:49：profile 监听 + Plugin Manager 触发的重组合会替换磁盘上变化的插件（含 node_modules 下已装包），无需重启；:73：新包入口在 Loader entry 重启时生效。
- 但已存在会话不换组合；GUI roster 刷新时机见 Q1（未实测）。

### 4.5 更新已存在 preset 的安全做法

1. 只用自家 config.id（taskboard-dispatch），永不覆盖 standard/ptc/minimal/cordis 的 row（会整块替换内置 plugins，未来升级必错位）。
2. 版本标记只能写 description（schema 无自定义字段）：如 ...（dsh-taskboard v0.1.0 预设）；GUI 卡片与 readDocument 都可见。
3. 更新 = 发新包 + 新 patch 层按 row id 覆盖（整块 config 重述）。
4. 不覆盖用户改动：profile/home 用户层优先级高于 bundle 层，用户改过就赢，这是设计如此，不要写用户 patch。检测：plugin_manager list_plugins 的 overridden，或 agentPresets/read 比对 description 版本标记；不一致就提示已被用户覆盖。
5. 方案 B 更新 = dispose() 再 register()；已绑定 agent 仍旧 generation。

## 5. 兼容性坑清单（旧 preset -> 0.2.2）

| # | 旧写法 | 0.2.2 后果 | 依据 |
|---|---|---|---|
| 1 | $HOME/.agent-presets/<id>/ 目录 | 完全不生效 | §1 |
| 2 | tool-subagent persona/toolFilter | apply 抛错，整 preset 挂载失败 | $PKGS/dsh-tool-subagent/lib/index.js:346 |
| 3 | backgroundMode / modelSelectionSettings | 字段不存在（新的是 modelSelection/modelDiscovery） | 同上 :301-315 |
| 4 | tool-subagent-control/list-agents 子路径 | exports 无该子路径 -> 导入失败 | 该包 package.json |
| 5 | dsh-workflow-worker-thread | 0.2.2 无此包 | $PKGS 目录 |
| 6 | persona.suffix 里的 {{cwd}} 变量 | 每请求组装抛错 | $PKGS/dsh-system-prompt/README.zh.md:80 |
| 7 | preset 内提供 fs-local 等服务未 isolate | 服务泄漏 -> mount 被拒 | mount.js；registry README |
| 8 | ./xxx.mjs 相对行 | 相对 profile 目录，找不到 | §Q3.5 |
| 9 | id/name/order 放 preset.yml | 声明不合法 | §Q2 |

## 6. UI 显示（registry config 与选择器）

- remote：agentPresets/list（roster）、read（只读 YAML）、select（仅空白会话）（$PKGS/dsh-agent-preset-registry/lib/typert.remote-client.d.ts）。
- Config：default（必填）+ selectedDefault（volatile，设置服务持久化到 profile patch；现物证 $PROFILE/cordis.patch.yml 里 selectedDefault: ptc）。defaultId = selectedDefault ?? default（registry lib:445-448、:471-473）。只决定新会话默认，不影响列表出现。
- built-in 判定：id 属于 standard/ptc/minimal/cordis 且 name === undefined（client.js:1251-1294）；给了 name 就进自定义分组、用我们的 name/description、不受代码工作工具开关过滤（requiresCodingTools 只对内置 ptc/minimal，:1682-1688）。
- 坏掉的 preset 仍在列表，带 broken 徽标与原因（:2368-2392），正好暴露写错的行。
- 列表刷新：连接重置/设置更新（README 理解实现）；无变更推送。装完刷新页面最稳。

## 7. 派单模式最小骨架（建议双 preset）

设计：主 preset 只读 fs + 派单/审核；worker preset 有 shell + 全量 fs；tool-subagent 配 agentPreset: taskboard-worker（spawn 支持：capabilities.agentPreset true、inheritsParentContext false，$PKGS/dsh-subagent-spawn-in-process/lib/index.js:21-27）；不挂 fork（agentPreset:false 且继承父上下文，$PKGS/dsh-subagent-fork-in-process/lib/index.js:35-41；配了会 assertProvider 抛错，tool-subagent lib:269）。

persona：派单纪律放 prefix（deployment:persona-prefix，order 0，遮蔽部署 persona、位于第一方指导之前）；汇报/结束回合口径放 suffix（deployment:persona-suffix，order 10200，所有第一方指导之后）。不要 complete: true（会抹掉第一方指导与 runtime 上下文；minimal 是刻意如此）。依据 $PKGS/dsh-system-prompt/README.zh.md:48-49、:142。

主 preset 必须行：persona(prefix) / agent-instructions / compaction 组 / delegation 组（tool-subagent-control + tool-subagent{provider: spawn, agentPreset: taskboard-worker, maxDepth: 1}） / tool-fs{read:true, write:false, edit:false, applyPatch:false} / tool-fs-search / tool-todo / tool-ask-user / present；推荐 time-context + planning 组；disabled：tool-workflow、tool-ralph、tool-plugin-manager；不挂：pwsh/bash、jobs、web、skill、fork。

worker preset 必须行：persona(worker 口径) / agent-instructions / compaction 组 / tool-pwsh(平台条件) / tool-fs 全量 / tool-fs-search；推荐 jobs、skill 组、web；不挂任何 subagent/workflow/ralph。

（完整可粘贴 YAML 因篇幅未展开；需要的话下一轮补。）

## 8. 对 dsh-taskboard 三件套的接线

| 交付物 | 平面 | 落点 |
|---|---|---|
| 模式 preset | agent plane | $PROJ/presets/patch.yml 两条 @deepseek-ai/dsh-agent-preset 声明；$PROJ/cordis.patch.yml 的 taskboard host row 不变 |
| 侧边栏看板 UI | host/client plane | lib/client.js + package.json dsh.client（platform web、inject slots/connection/timer/locale）——不能放 preset |
| 轮询 + 工具 | host plane | lib/index.js（ctx.tools.register 宿主级 + 轮询 + remote）——preset 里不需要工具行 |

要改四处：1) 删/停 installPreset 写 .agent-presets 的路径，改为检查 roster 里是否已有声明；2) preset 的 plugins 搬进声明；3) 修 Q5 的必挂点；4) package.json 的 dsh.bundle.patch 改数组、engines.dsh 改 >=0.2.2-rc.1。

## 9. 未确认/建议实测

1. install_bundle 后 client 是否立即重读 roster（README 只提到连接重置/设置更新）。
2. 方案 B 在宿主 row 激活中途 register 的稳定性（官方只禁 diagnostic 这类调用）。
3. 第三方 bundle 声明 preset 无现成先例（官方 web-app 用同一机制，风险应低）。
4. dsh web --dump-config 打印层栈（CLI 有该选项，$DSH/lib/bin.js:63-86；本次未执行）。
5. 自定义 !!js 表达式拿 baseUrl 的做法（官方 cordis preset 有先例，未实测我们自己的）。

---

## 附录：证据索引

| 主题 | 文件:行 |
|---|---|
| 旧目录已废弃/迁移/声明格式/平面原则 | $PKGS/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:10-24、:26-52、:54-66、:68-70、:76-82 |
| 声明字段 schema | $PKGS/dsh-agent-preset/lib/index.js:13-19 |
| 注册表核心 | $PKGS/dsh-agent-preset-registry/lib/index.js:230、:445-448、:471-473、:486-537、:517、:586-607、:629-647、:670-696、:702-786；lib/types/mount.js；README.zh.md |
| 内置 preset | $PKGS/dsh-web-app/presets/{standard,ptc,minimal,cordis}.patch.yml；package.json:47-54 |
| host/preset 平面 | $PKGS/dsh-web-app/cordis.patch.yml:467-594；$PKGS/dsh-base/cordis.patch.yml:1-32、:281-320 |
| 层序/baseUrl | $DSH/lib/profile-boot-e2mS45fC.js:202-231；$PKGS/dsh-app-boot/lib/index.js:1908-1918 |
| Loader import / !!js | $PKGS/cordis-plugin-loader/lib/index.js:208、:337-354、:359-364 |
| runtime resolution / 相对名锚定 | $PKGS/dsh-app-boot/lib/index.js:1495-1577、:2450-2457、:2632、:4251、:4717-4726 |
| HMR | $PKGS/dsh-hmr/README.zh.md:27、:49、:73 |
| 子 agent 继承/独立 preset | $PKGS/dsh-subagent/lib/types/child-agent.d.ts:57-84；$PKGS/dsh-tool-subagent/lib/types/preset-selection.d.ts；lib/index.js:269、:301-315、:345-348、:452-462 |
| spawn/fork 能力 | $PKGS/dsh-subagent-spawn-in-process/lib/index.js:21-27；$PKGS/dsh-subagent-fork-in-process/lib/index.js:35-41 |
| persona/system-prompt | $PKGS/dsh-persona/lib/types/index.d.ts:1-45；$PKGS/dsh-system-prompt/README.zh.md:44-50、:80、:142 |
| 工具注册表分层 | $PKGS/dsh-tools/README.zh.md（注册工具/按 agent 限制工具/理解实现） |
| UI | $PKGS/dsh-client-ui-agent-preset/README.zh.md；lib/client.js:1251-1294、:1682-1688、:2322-2331、:2368-2392 |
| 插件管理工具 | $PKGS/dsh-plugin-manager/lib/types/tools.js:71-100 |
| 旧版（对照） | $OLD/packages/preset/agent-presets/src/discovery.ts:5、:37、:51、:60、:324-327；src/index.ts:234-236、:477；src/metadata.ts:25-38；src/specifier.ts:1-28 |
| 现有旧 preset | $HOME/.agent-presets/my-agent/{preset.yml,agent.cordis.yml}；$HOME/.agent-presets/anchored-standard/ |
| 本项目现状 | $PROJ/package.json、cordis.patch.yml、preset/、lib/index.js:63-64、:113、:489-560、:797-800、:992-1100、:1135-1139 |

