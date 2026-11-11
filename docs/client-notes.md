# DSH 0.2.2-rc.1 浏览器端插件契约调查（dsh-taskboard 前置）

> 调查员：client-scout ｜ 版本：DSH `0.2.2-rc.1`（commit `c59d10a`）｜ 日期：2026-11-11
> 参考实现：`C:\Users\duan\Code\dsh-ollama-statistical\lib\client.js`（在跑的真实插件）
> 证据来源：npm 安装包 `C:\Users\duan\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*`
> 下文的 `L123` 均指该文件的行号；`dist/idx≈949400` 指 `dsh-web-frontend\dist\assets\index-BgUyXZcc.js` 的**字符偏移**（该文件基本是单行压缩产物）。
> 只读调查：除本文件外未写任何文件、未改 `~/.dsh`、未装依赖、未启服务。

---

## 0. 结论速览（先看这 12 条）

1. **bundle 必须是「classic script + CJS factory」**：`window.__ModuleLoader__.load({ id, factory })`，文件里**不能有顶层 `import`/`export`**——宿主是用 `<script src=…>`（无 `type=module`）加载的（`dsh-client-modules/lib/client.js` L580-594）。
2. `id` **必须等于包名**（`<pkg>/client` 会被剥成 `<pkg>`，L98-100）；脚本重复执行导致重复注册会**抛错**（L703-716）。
3. `load()` **只注册 factory，不执行插件体**；factory 在首次 `import/require` 时物化（memoize），**所有副作用（含 `<style>` 注入）必须写在 factory 内**（L14-31）。
4. `require` 白名单 = **11 个平台种子模块** + 已注册的包 factory。种子清单实测：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`（`dist/idx≈949400` 的 `YZ()`）。**除 `react` 外的种子模块能用，但要先 `dsh.client.external` 声明**（否则可能在物化时尚未注册而抛 `missed the module table`，L842）。ollama 的「只 require('react')」是**保守但推荐**的做法。
5. **必须导出** `apply(ctx)` + `inject = [服务名…]`（cordis 插件面）；可选 `name`/`reusable`/`Config`。官方包一律是 `exports.apply` / `exports.inject`（如 `dsh-client-ui-jobs/lib/client.js` L905-906）。
6. 生命周期：物化 → `loader.unwrapExports` → `ctx.registry.plugin(exports)` → **fiber 等 inject 服务就绪才 `apply(ctx)`** → 卸载/HMR 时 `ctx.effect` 清理函数反向执行（`dist/idx≈944364` 的 `KZ()`；`dsh-client-modules/README.md` 的 Lazy-CJS 段）。
7. **0.2.2-rc.1 的 slot 是「父 slot 声明 children」模型**：只有父注册者声明过的 key 才能注册，否则抛 `slot "x" is not declared`（`dist/idx≈493000` `SlotCore.register`）。本版本可用的 root 子 slot：`sidebar`、`main`(keyed)、`rightbar`、`shell.bottom`、`shell.overlay`(list)、`shell.leading`；`sidebar` 的子 slot：`sidebar.panellist`(list)、`sidebar.footer.action`(list)、`sidebar.workspaces`、`sidebar.settings`、`sidebar.brand.mark`、…（`dsh-client-ui-layout/lib/client.js` L705-733、`dsh-client-ui-sidebar/lib/client.js` L733-769）。
8. **看板三处注册**：`sidebar.panellist`（侧栏入口，props `{size, active}`）+ `main`（keyed，`key` 必须与 panellist 的 `id` 相同）+ 可选 `sidebar.footer.action`（props `{wide}`）。点图标切页由 sidebar 调 `ctx.layout.selectPanel(id)` 完成，layout 再用 `entryKey` 渲染对应 main（`dsh-client-ui-layout` L122-129、L506-526）。
9. **main 组件没有 session/connection props**：ownerProps 是 `{}`；能拿到的是标准 kit（`useSessions`/`usePanelInfo`/… 由 root `provideRoot` 注入）、`t`（注册时写了 `locale`）、以及**你自己在 `inject` 里塞的 props/hooks**（`dsh-client-ui-renderer` L736-767）。RPC 要用 `apply(ctx)` 闭包里的 `connection`。
10. **Connection RPC 信封**：客户端 `connection.rpc.call(channel, endpoint, payload, signal?)` → `POST /<channel>/<endpoint>`，body `{type:'client-request', rpcId, method, payload}`，响应 `{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error:{code,message,details}}}`；`call()` 直接 resolve 出 **`result`**（不是信封），HTTP 非 2xx / rpcId 不符 / 信封不合法会 **reject**；`error.details` 缺失会被判为非法响应（`dsh-client-connection/lib/client.browser.js` L1209-1239、L1288-1319）。**没有内建超时**，要自己发 `AbortSignal`。
11. 样式只用 `--dsw-*` 主题变量（实测 414 个），暗色由 `body[data-ds-dark-theme]` 切换、变量自动成立；`<style>` 用 `data-plugin-css` 幂等注入并在 `ctx.effect` 里移除（`dsh-client-ui-layout` L571；ollama L306-319）。
12. `dsh.client` 的字段语义（权威定义在 `dsh-package-manifest/lib/types/types.d.ts`）：`platform:'web'`、`immediately`=「boot 阶段一预取屏障」、`inject`=**仅信息性的包名依赖，不是 Cordis 服务注入**、`external`=除基线外的精确模块请求。`exports["./client"]` 是**硬要求**，缺失会在宿主侧直接抛错（`dsh-client-modules/lib/index.js` L792）。

---

## 1. `window.__ModuleLoader__.load` 的确切契约

### 1.1 宿主侧 bootstrap facade（源码原文）

`dsh-client-modules/lib/index.js` L518-540 生成注入到 `<head>` 的 queue facade：

```js
// 宿主把下面这段源码作为一个字符串注入 <head>（原文节选，外层反引号已省略）
(() => {
  const pendingQueue = []
  window.__ModuleLoader__ = {
    mode: 'queue',
    pendingQueue,
    load(registration) { pendingQueue.push(registration) },
    create(options) {
      if (this.mode !== 'queue') throw new Error('client-modules: create called after module-system boot')
      const index = pendingQueue.findIndex((registration) => registration.id === '@deepseek-ai/dsh-client-modules')
      const registration = pendingQueue[index]
      if (registration === undefined) throw new Error('client-modules: HTML did not preload dsh-client-modules/client.js')
      pendingQueue.splice(index, 1)
      const exports = registration.factory((specifier) => {
        throw new Error('client-modules: requested external "' + specifier + '" before the module system existed')
      })
      if (typeof exports !== 'object' || exports === null
        || typeof exports.createClientModuleSystem !== 'function' || typeof exports.apply !== 'function') {
        throw new Error('client-modules: bootstrap module face missing')
      }
      return exports.createClientModuleSystem(this, { id: registration.id, exports }, options)
    },
  }
})()
```

结论：
- 注册对象只有 **`{ id, factory }`**（另有可选的 `chunk`，用于包内动态分包，见 `client.js` L706-707，普通插件不用）。
- `mode:'queue'` 时 `load` 只是入队；boot 完成后 facade 切到 live 模式，`load` 直接 `register()`（L694-701）。
- `load` 的返回值**没有意义**，不要依赖。

### 1.2 注册与物化（浏览器侧）

`dsh-client-modules/lib/client.js`：

| 行为 | 证据 |
|---|---|
| 脚本执行只注册 factory；物化时 `factory(this.makeRequire(ownerId, edges))` | L805-832（`materialize`） |
| 注册 id 规范化：`<pkg>/client` → `<pkg>` | L98-100、L705 |
| 重复注册（脚本跑了两遍）抛错 | L703-716 |
| `require(spec)` 解析顺序：**种子表 → 已物化记录 → 已注册 factory → 抛错** | L834-853 |
| `require.asset(ref)` / `require.async('./client.<name>.js')` | L844-851 |
| 包体 script 加载：**classic script**（无 `type=module`），`async`，插到 `head` | L580-594 |

```js
// L834-843 原文（require 的实现，白名单就藏在这里）
const require = (spec) => {
  edges.add(spec)
  if (this.seed.has(spec)) return this.seed.get(spec)
  const id = stripClientSuffix(spec)
  const record = this.loadCache.get(id)
  if (record !== void 0) return record.exports
  if (this.factories.has(id)) return this.materialize(id).exports
  throw new Error('client-modules: require("' + spec + '") missed the module table …')
}
```

### 1.3 `require` 白名单（实测 11 项，来自 shell 的 `PLATFORM_MODULES`）

`dist/assets/index-BgUyXZcc.js`，`r.create({boot, staticModules: YZ(), …})` 处：

```js
function YZ(){return{
  react: fk,
  "react/jsx-runtime": gk,
  "react-dom": xk,
  "react-dom/client": Ck,
  "@deepseek-ai/cordis": Rb,
  zod: JS,
  "@tanstack/react-virtual": rI,
  "@deepseek-ai/dsh-client-store": SI,
  "@deepseek-ai/dsh-client-ui-slots": MI,
  "@deepseek-ai/dsh-client-ui-primitives": FU,
  "@deepseek-ai/dsh-client-ui-dockkit": WZ,
}}
```

要点：
- `react` 返回的是 **ESM namespace 形状**（`{...named, default: react}`），`require('react').useState` 与 `.default.useState` 都可用。
- **11 项之外的 `@deepseek-ai/*` 只能靠 `dsh.client.external` 声明 + 目标包也在 boot graph 里**；否则物化时抛 `missed the module table`（L842）。官方包的写法见 `dsh-client-ui-sidebar/package.json` 的 `dsh.client.inject`（列的是**包名**）。
- **ollama 的约束「只 require('react')，禁止 require 任何 @deepseek-ai/*」是保守策略**：本版本种子表里那几个 `@deepseek-ai/*` 其实可以 require，但一旦用错（拼错包名、包不在 graph、HMR 期间未注册）就是硬崩；taskboard 没必要冒险，**建议只 require('react')**。
- `react-dom/client` 也在种子里，但**不要**自己建 root——渲染进 slot 即可。

### 1.4 必须导出什么 / 生命周期

导出（cordis 插件面，官方包 100% 一致）：

```js
exports.apply  = apply        // function apply(ctx, config?)
exports.inject = ['slots','connection','timer','locale']  // 服务名数组；服务齐了才调 apply
// 可选：exports.name / exports.reusable / exports.Config
return module.exports
```

- 兼容性兜底：loader 会 `unwrapExports`（若导出带 `default` 会取 `default`），所以 `module.exports = { apply, inject }` 与 `exports.apply = …` 等价（`dist/idx≈944364` `_init()` 的 `this.loader.unwrapExports(t)`）。
- **生命周期**：脚本执行（register） → 首次 import/物化（factory 跑完，返回 exports） → `ctx.registry.plugin(exports)` → fiber 等 `inject` 服务 → `apply(ctx)` → 页面运行 → 插件卸载/HMR 时 **fiber dispose**，所有 `ctx.effect(() => cleanup)` 按逆序执行。
- **HMR**：宿主按 `mtimeMs/ctimeMs/size` 生成 rev（`dsh-client-modules/README.md`），bundle 重载=旧 fiber dispose + 新 factory；所以 `ctx.effect` 里一定要能干净移除 `<style>`、定时器、slot 注册。
- **`apply` 里拿 ctx 的方式**：`function apply(ctx) { const slots = ctx.slots /* 或 ctx.get('slots') */ }`。
  ollama 用 `ctx.get(...)` + try/catch 降级（L2046-2057），官方包直接用 `ctx.slots` / `ctx.locale` / `ctx.jobs`（`dsh-client-ui-jobs` L880-902）。两者都成立；**在 `exports.inject` 里声明后**用属性访问更简洁。

### 1.5 客户端 ctx 上可用的服务（实测清单）

| 服务名（inject 用的字符串） | 来源 | 用途 |
|---|---|---|
| `slots` | `dsh-client-ui-renderer`（`SlotRegistry extends Service`，`super(ctx,"slots")` L1347-1348） | `inject/register/entries/entriesOfSlot/subscribe/provideRoot/installScope` |
| `connection` | `dsh-client-connection`（`ctx.provide("connection", handle)` L1497） | `rpc.call(...)`、`state`/`generation` 观察、`reconnect()` |
| `timer` | cordis timer（`ctx.interval/timeout/throttle/debounce`，`super(ctx,"timer")`） | 定时器，随 fiber 自动清理 |
| `locale` | `dsh-client-locale`（`ctx.provide("locale", locale)` L1838） | `register/bind/getLocale/subscribe` |
| `layout` | `dsh-client-ui-layout`（`ctx.reflect.provide("layout", layout)` L704） | `selectPanel(id)`、`toggleSidebar()`、`openRightbar/closeRightbar` |
| `theme` | `dsh-client-ui-theme` | `getTheme()`、`theme/change` 事件 |
| `shortcuts` | `dsh-client-shortcuts` | 快捷键注册 |
| `sessions` | 会话控制器 | 会话列表/状态（root hook `useSessions` 的来源） |
| `jobs` | `dsh-jobs` 客户端面 | 后台任务 |
| `uiWorkspace` | 工作区 UI | 会话/工作区导航 |
| `resources` / `contextMenus` / `remoteAccess` / `productAnalytics` / `uiRenderer` | 各自官方包 | 资源、右键菜单、远程权限、埋点、挂载 |
| `reflect` / `loader` / `modules` | cordis / shell | 提供自定义服务、模块表 |

其他 ctx 能力：`ctx.get(name)`、`ctx.effect(fn, label)`、`ctx.inject([...], cb)`、`ctx.on(event, cb)`、`ctx.reflect.provide(name, value)`。

### 1.6 官方 bundle vs ollama 的差异（要点）

| 维度 | 官方（如 `dsh-client-ui-jobs`、`dsh-client-ui-sidebar`） | ollama `lib/client.js` |
|---|---|---|
| 取服务 | `ctx.slots` / `ctx.jobs` 属性直取，`inject` 硬依赖 | `ctx.get('slots')` + try/catch 降级，容忍缺服务 |
| 导出 | `exports.apply` + `exports.inject` | 同 |
| slots API | `ctx.slots.inject(name, () => ctx.slots.register({...}, Comp))` | `slots.inject(...)` + `slots.register(...)`（同一 API，经 `ctx.get` 取得） |
| 组件 props | 全部走 `register({ inject })` 的 hooks/props | 除 `size/active/wide` 外不依赖宿主 props |
| i18n | `ctx.locale.register(ns,{zh,en,…})` + `register({locale:ns})` → 组件拿 `t` | 自己的字典 + `locale.bind` + 降级内置字典 |
| 样式 | 编译期 CSS module（hash 类名） | 手写 CSS 字符串 + `<style data-plugin-css>` 幂等注入 |
| 模块依赖 | `dsh.client.inject` 列真实包名 | 列的是服务名（**信息性字段，等于无效声明**，但无害） |

---

## 2. 0.2.2-rc.1 的 slot 清单与 props

### 2.1 模型：父 slot 声明 children

`SlotCore.register`（`dist/idx≈493000`，`dsh-client-ui-slots` 的 `SlotCore`）关键规则：

- 只能注册**已被父条目在 `children` 里声明过**的 slot，否则 `slot "<name>" is not declared (a parent entry's children table must declare it)`。
- `kind`：`single`（同 priority 只能 1 个）、`keyed`（**必须 `key`**）、`list`（**必须 `id`**，按 `priority`→`order` 排序）、`chain`。
- 注册项字段：`name`(必填)、`id`/`key`/`order`/`label`(string|thunk)/`priority`/`locale`/`inject`/`children`/`store`/`select`。
- `scope`：`root` 或 `session`（session 的组件会再拿到 `sessionId` 与 session 标准 hooks）。
- `label` 会被 `resolveSlotLabel` 求值（`EI = e => typeof e==='function' ? e() : e`，`dist/idx≈497600`），侧栏用它做文案，**传 thunk 可随语言切换**。

### 2.2 本版本实际声明的 slot 树（root 两层）

```text
root                                   single  (built-in)
├─ sidebar                             single  root   [dsh-client-ui-layout L709-712]
│  ├─ sidebar.brand.mark               single  root   [ui-sidebar L737-740]
│  ├─ sidebar.brand.name               single  root
│  ├─ sidebar.toggle.badge             single  root
│  ├─ sidebar.panellist                list    root   ★ 侧栏面板入口
│  ├─ sidebar.panellist.actions        list    root   （"更多"菜单行）
│  ├─ sidebar.workspaces               single  root
│  ├─ sidebar.settings                 single  root
│  └─ sidebar.footer.action            list    root   ★ 侧栏底部动作
├─ main                                keyed   root   ★ 全局面板页（entryKey=panellist id）
├─ rightbar                            single  root   （官方右侧栏容器，被 ui-sidebar-right 独占）
│  └─ rightbar.session                 single  session
├─ shell.bottom                        single  root
├─ shell.overlay                       list    root   （浮层，z-index 20）
└─ shell.leading                       single  root
```

出处：`dsh-client-ui-layout/lib/client.js` L705-733（root children）、`dsh-client-ui-sidebar/lib/client.js` L733-769（sidebar children）、`rightbar` 声明见 `dsh-client-ui-sidebar-right/lib/client.js`（`name:"rightbar"` 位于该文件字符偏移约 222145；child 为 `rightbar.session`）。

其他官方插件还会声明更多子 slot（如 `conversation.session.header.actions`、`settings.*`），但**与看板无关**，列在这里只为说明「不要猜 slot 名」。

### 2.3 每个 slot 的 props

| slot | 渲染处 / props | 说明 |
|---|---|---|
| `sidebar.panellist` | `renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id })`（`ui-sidebar` L228-231） | props：`size:number`、`active:boolean`。**必须返回一个图标**（SVG），16~24px，`currentColor` 跟随；`active` 时用 `var(--dsw-alias-brand-primary)`。外面是 36px 的按钮 + Tooltip + `aria-current`，你不要自己画按钮。 |
| `main` | `renderSlot("main", {}, { entryKey: panelId ?? "conversation" })`（`ui-layout` L127） | **ownerProps 为空对象**；组件只拿标准 kit + 你 inject 的东西。当 `activePanelId===key` 时挂载，切走即卸载。 |
| `sidebar.footer.action` | `renderSlot("sidebar.footer.action", { wide })`（`ui-sidebar` L561） | props：`wide:boolean`（侧栏展开=true）。窄栏（`wide===false`）时通常 `return null`。 |
| `shell.overlay` | `renderSlot("shell.overlay", {})`（`ui-layout` L346） | list，绝对定位覆盖层；适合全局抽屉/浮层。子元素 `pointer-events:auto`。 |
| `rightbar` | `renderSlot("rightbar", { width, viewportWidth, canShow })`（`ui-layout` L389-393） | **single**，已被官方 `dsh-client-ui-sidebar-right` 占用；`dsh-client-ui-sidebar-right` 就是「右侧栏（文件/文档/终端/指南 多 tab）」这一整个官方功能。**第三方看板不要抢它**，会与官方条目冲突（single slot 同 priority 二次注册直接抛错）。 |
| `rightbar.session` | 同上，session scope | 官方右侧栏的 session 座位，同上不建议动。 |

### 2.4 标准 kit：组件能从宿主拿到什么

`dsh-client-ui-renderer/lib/client.js` L736-767（`standardKit`）：
- `...standard`：root 标准 props/hooks；
- 若注册时写了 `locale`，注入 **`t`**（该 namespace 的翻译函数，L742-746）；
- 若注册时写了 `store`，注入 `useStore` + `actions`（L747-752）；
- 若注册时声明了 `children`，注入 `renderSlot` / `renderSlotChain` / `SessionProvider`（L753-761）；
- 你自己的 `inject`（function → props；`{hooks, props, keyedHooks}` → `use<Name>` props + 原样 props）。

root 标准 hooks（由各官方包 `slots.provideRoot` 提供，**任何 root slot 都能用**）：

| prop | 来源 | 说明 |
|---|---|---|
| `useSessions` | `dsh-client-ui-session` L1120-1124（`hooks:{sessions: ctx.sessions.list, sessionStatus}`） | 会话列表 store hook |
| `useSessionStatus` | 同上 | 会话运行/待交互状态 |
| `useWorkspaces` | `dsh-client-ui-workspace` L5781-5782 | 工作区列表 |
| `usePanelInfo` | `dsh-client-ui-layout` L703 | `{ activePanelId }`，判断当前是否在自己的页面 |
| `useContextMenu` | `dsh-client-ui-context-menu`（props） | 右键菜单 |
| `useSessionRetainInfo` / `useSessionAccess` / `useWorkspaceAccess` / `useResource` | keyedHooks（按 key 取 hook） | 会话保活、远程权限、资源 |
| `t` | 注册时 `locale` | 见上 |

session 标准 hooks（只有 `scope:"session"` 的子 slot 才有）：`useSession`（运行时的 session 贡献）、`useAccess`、`useProjection(key)` 等。

> **注意**：`main` / `sidebar.panellist` / `sidebar.footer.action` 都是 **root scope**，**没有 `useSession` 这个 prop**。要「当前会话」就自己从 `useSessions` 里挑（layout 的官方写法：`useSessions(s => Object.values(s.byId).find(x => (x.retainedBy.mainView ?? 0) > 0)?.id)`，`ui-layout` L61）。

### 2.5 注册代码骨架（taskboard 三处）

```js
function apply(ctx) {
  const slots = ctx.slots
  const connection = ctx.connection       // 见 `3

  // ① 侧栏入口（list，必须有 id 与 label）
  slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: 'taskboard',                 // ★ 同时作为 main 的 key
    order: 40,                       // 排在同列其它插件之后
    label: () => '任务看板',          // thunk：语言切换自动重读
  }, PanelIcon))

  // ② 主页面（keyed，必须有 key；key === panellist.id）
  slots.inject('main', () => slots.register({
    name: 'main',
    key: 'taskboard',
    label: () => '任务看板',
    inject: () => ({
      // 把自己的 RPC 封装成 props 传给组件（可选方案；也可用闭包，见 `6）
      callRpc: (endpoint, payload) => connection.rpc.call('/taskboard', endpoint, payload ?? {}),
    }),
  }, BoardPage))

  // ③ 侧栏底部动作（list；窄栏由 wide 判断）
  slots.inject('sidebar.footer.action', () => slots.register({
    name: 'sidebar.footer.action',
    id: 'taskboard-count',
    order: 90,
    label: () => '任务计数',
  }, FooterCount))
}
```

**点击图标如何切页**：sidebar 的 `PanelRow.onClick → selectPanel(id)`（`ui-sidebar` L217-224）→ `ctx.layout.selectPanel(id)`（L719-721）→ `LayoutController.selectPanel` 校验「存在该 key 的 main 注册」后写入 `panelInfo.activePanelId`（`ui-layout` L522-526、L460-465）→ `MainPanel` 用 `entryKey=activePanelId` 渲染对应 main（L122-129）。所以：
- **`panellist.id === main.key`**，任意稳定字符串（建议小写连字符，如 `taskboard`）；
- 若只有 panellist 没有 main，点击会抛 `layout.selectPanel: main panel "x" is not registered`；
- 想从自己页面跳回别处，可 `ctx.inject(['layout'], ctx => ctx.layout.selectPanel(null))`（`null` = 回到会话）。

---

## 3. Connection RPC（客户端 ↔ 宿主）

### 3.1 客户端调用面

`dsh-client-connection/lib/client.browser.js`：

```js
// L1212-1231（原文精简；原本是 createWebConnectionRpc() 返回对象里的方法，这里改写成函数便于单独阅读）
async function call(channel, endpoint, payload, signal) {
  assertTarget(channel, endpoint)
  const rpcId = RpcId(randomUuid())
  const message = { type: "client-request", rpcId, method: endpoint, payload }
  const response = await send((channel + "/" + endpoint).slice(1), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
    ...signal === void 0 ? {} : { signal }
  })
  if (!response.ok) throw new Error("transport failure for " + channel + "/" + endpoint + ": HTTP " + response.status)
  const full = parseConnectionResponse(await response.json())
  if (full.rpcId !== rpcId) throw new Error("rpcId mismatch for " + endpoint)
  return full.result
}
```

- 形参：`call(channel, endpoint, payload, signal?)`；**返回值是 `result`**：`{ ok:true, value }` 或 `{ ok:false, error:{code,message,details} }`。
- 校验正则（L1201-1202）：`channel` 必须 `^\/[A-Za-z0-9._~-]+$`；`endpoint` 允许 `/`，每段 `^[A-Za-z0-9_$.-]+$`。
- **会 reject 的情况**：HTTP 非 2xx；响应不是 `{type:'server-response', rpcId:string, result:...}`；失败结果缺 `details`（必须是对象）（L1288-1313）。
- **无内建超时**：`AbortSignal` 可选传入（第 4 参）。需要超时就自己 `AbortSignal.timeout(ms)`。

推荐封装（与 ollama 的 `callRpc` 等价，L2106-2123）：

```js
function callRpc(endpoint, payload) {
  try {
    if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function')
      return Promise.resolve({ ok: false, error: { code: 'internal', message: 'connection unavailable', details: {} } })
    return Promise.resolve(connection.rpc.call('/taskboard', endpoint, payload || {}))
      .then(r => (r && typeof r.ok === 'boolean') ? r
        : { ok: false, error: { code: 'internal', message: 'malformed RPC response', details: {} } })
      .catch(e => ({ ok: false, error: { code: 'network', message: String((e && e.message) || e), details: {} } }))
  } catch (e) {
    return Promise.resolve({ ok: false, error: { code: 'internal', message: String((e && e.message) || e), details: {} } })
  }
}
```

### 3.2 宿主如何回应（路由 + 信封）

宿主注册路由（`dsh-host-webserver` 的 `WebServer.register`，类型见 `lib/types/index.d.ts`：`{ kind:'exact'|'prefix', path, handler }`，返回 disposer）：

```js
export const inject = ['timer', 'webServer']

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/taskboard',            // 必须与客户端 channel 完全一致
    handler: (req, res) => { handle(req, res).catch(() => {}) },
  }), 'taskboard: rpc bridge')
}
```

响应必须是 **200 + JSON 信封**（ollama `lib/index.js` L3728-3748）：

```js
const fail = (code, message, details) => ({
  ok: false, error: { code: String(code), message: String(message), details: details ?? {} }
})
const ok = (value) => ({ ok: true, value })
// 回给浏览器：
res.writeHead(200, { 'content-type': 'application/json' }).end(
  JSON.stringify({ type: 'server-response', rpcId, result })
)
```

实测约定（ollama `.dev/protocol.md` L71-109）：
- 非 POST → 404；非 `application/json` → 415；非 loopback Host → 403；非法信封 → **200 + `error.code='bad-request'`**（不是 4xx）；
- `error.details` 必须是对象，否则浏览器端 `parseConnectionResponse` 直接 reject（TypeError）。
- 错误码建议：`bad-request` / `internal` / `network` / `rate-limit` / `no-data` 等，自定义也行，浏览器端只当字符串。

> 安全默认：**只服务 loopback**。宿主侧建议照抄 ollama 的 `isLoopbackHost(req.headers.host)` 检查（`lib/index.js` L3943-3953）。DSH 默认绑定 127.0.0.1，但 Web GUI 也可能通过远程访问暴露，别假设。

### 3.3 轮询与清理（推荐做法）

**结论**：页面级轮询用 `window.setInterval` + `useEffect` 清理最稳；插件级（跨页面）常驻轮询用 `ctx.interval`（随 fiber 自动 dispose）。两者都行，关键是**卸载必须清**。

ollama 的做法（`lib/client.js` L2125-2152、L3953-3967）：包装 `every()` 优先 `ctx.interval`，回退 `window.setInterval`，并在 `useEffect` cleanup 里 `dispose()`；同时用 `aliveRef` 丢弃迟到响应。

推荐给 taskboard（2 秒轮询、单飞、失败保留旧数据）：

```js
React.useEffect(() => {
  let alive = true
  let inFlight = false
  const tick = () => {
    if (!alive || inFlight) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return // 后台不轮询
    inFlight = true
    callRpc('snapshot', {}).then((r) => {
      inFlight = false
      if (!alive) return
      if (r && r.ok === true) { setSnap(r.value || {}); setError(null) }
      else setError((r && r.error) || { code: 'internal', message: '' })
    }).catch(() => { inFlight = false })
  }
  tick()
  const id = window.setInterval(tick, 2000)
  return () => { alive = false; window.clearInterval(id) }
}, [])
```

注意事项：
- `callRpc` 必须稳定引用（放在 `apply` 闭包里，或 `useRef`），否则 effect 每次重建会抖；
- 页面卸载/切到别的面板时 main 组件**会被卸载**，cleanup 必执行——这就是唯一的清理点；
- 插件整体卸载时 `ctx.effect` 里注册的东西（`<style>`、slot 注册）自动回收；
- 若用 `ctx.interval`，一定在 effect cleanup 里调用其返回的 dispose（否则会在插件 fiber 上累积 effect，ollama 正是这么做的）。

### 3.4 可选的实时通道

`connection` 还有 `state`（在线/离线）、`generation`（连接代次）、`reconnect()`（L1421-1456）。看板若想「宿主数据变了立刻推」，本版本更省事的是**短轮询**（2s）或让宿主返回 `updatedAt`/`revision`，客户端比对后再更新；长连接/SSE 属于宿主路由的事（`webServer.register` 允许持有响应不结束），但会显著增加复杂度，首版不建议。

---

## 4. 样式：`--dsw-*` 主题变量与注入

### 4.1 变量总量与分组（实测 414 个）

来自 `dsh-client-ui-theme/lib/client.js` 全量提取。**推荐只用下面这些**（ollama 已在真实环境验证过一遍）：

```css
/* 背景 */
--dsw-alias-bg-base                 /* 页面底色 */
--dsw-alias-bg-layer-1 / -2 / -3    /* 卡片 / 次级 / 三级层 */
--dsw-alias-bg-skeleton             /* 骨架屏 */
--dsw-alias-bg-mask-1               /* 遮罩 */
--dsw-specific-sidebar-fill         /* 侧栏专用底色 */
--dsw-specific-menu                 /* 菜单面 */
--dsw-menu-surface-fill
/* 文字 */
--dsw-alias-label-primary
--dsw-alias-label-secondary
--dsw-alias-label-tertiary
--dsw-alias-label-caption
--dsw-alias-label-primary-foreground  /* 主色按钮上的字 */
--dsw-alias-label-primary-inverted
--dsw-alias-link
/* 边框 */
--dsw-alias-border-l1 / -l2 / -l3 / -l4   /* l1 最浅，l3/l4 用于分隔线 */
/* 交互 */
--dsw-alias-interactive-bg-hover
--dsw-alias-interactive-bg-active
/* 品牌 / 按钮 */
--dsw-alias-brand-primary
--dsw-alias-button-primary-fill
--dsw-alias-button-primary-hover
--dsw-alias-button-elevated-fill
/* 状态色 */
--dsw-alias-state-success-primary / -secondary / -tertiary
--dsw-alias-state-warn-primary / -secondary / -tertiary / -label
--dsw-alias-state-error-primary / -secondary
--dsw-alias-state-business-primary
--dsw-alias-state-idle-primary
--dsw-alias-state-done-primary
/* 圆角 */
--dsw-radius-xs / -sm / -md / -lg / -xl / -panel
/* 字体（连字号写法，可整体用于 font 简写） */
--dsw-font-xxxs-11 / -strong-11
--dsw-font-xxs-12 / -strong-12
--dsw-font-xs-13 / -strong-13
--dsw-font-s-14 / -s-strong-14
--dsw-font-m-18 / -l-20 / -xl-24 / -base-16
--dsw-font-family / --dsw-font-family-brand
/* 焦点环 */
--dsw-focus-ring-width
--dsw-focus-ring-color
/* 阴影 / 模糊 */
--dsw-shadow-lv1 / -lv2 / -lv3
--dsw-mask-blur
/* 滚动条 */
--dsw-alias-scrollbar-bg-l1 / -l2, --dsw-alias-scrollbar-hover-l1 / -l2
```

写法示例（来自 ollama，可直接抄）：

```css
.tb-page{ color:var(--dsw-alias-label-primary); font:var(--dsw-font-xs-13); }
.tb-card{ background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:var(--dsw-radius-md); }
.tb-btn:hover{ background:var(--dsw-alias-interactive-bg-hover); }
.tb-btn:focus-visible{ outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:2px; }
.tb-chip[data-tone=ok]{ background:var(--dsw-alias-state-success-tertiary); color:var(--dsw-alias-state-success-primary); }
```

### 4.2 亮/暗主题

- 暗色通过 **`body[data-ds-dark-theme]`** 切换（`dsh-client-ui-layout` L570-571 的 `DARK_ATTRIBUTE = "data-ds-dark-theme"`；sidebar CSS 里也有 `[data-ds-dark-theme]` 分支）；也支持 `prefers-color-scheme`。
- `--dsw-alias-*` 本身就是语义别名，亮暗下自动变值 → **不要写死 `#fff`/`#111`**。
- 唯一允许的硬编码：数据可视化强调色（ollama 只保留图表/横条的蓝紫色）。看板的列头色/优先级色可以放在 `data-*` + 自己变量上，但仍建议用 `color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)` 这类派生，亮暗都成立。
- `color-mix()` 在 DSH Web 目标浏览器（Chrome 系）可用；ollama 大量使用，可放心。
- 注意：ollama 用过一个 `--dsw-alias-bg-l1`，**本版本 414 个变量里没有它**（有 `bg-layer-1` / `bg-base`），属于疑似拼写残留，别抄。

### 4.3 幂等 `<style>` 注入（推荐模式）

```js
const CSS_TAG_ID = 'dsh-taskboard/client.css'

function injectCss() {
  if (typeof document === 'undefined') return null
  if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') !== null) return null
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-taskboard'
  tag.dataset.pluginCss = CSS_TAG_ID
  tag.textContent = CSS
  ;(document.head || document.documentElement).appendChild(tag)
  return tag
}

// apply 里：
ctx.effect(() => {
  const tag = injectCss()
  return () => {
    if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
  }
}, 'taskboard: client css')
```

要点：选择器带唯一 `data-plugin-css`；`querySelector` 存在则跳过（HMR/双实例安全）；清理函数里 remove（**只 remove 自己新建的那个**）。ollama 的实现在 L306-319，`apply` 里包 `ctx.effect` 在 L2063-2101。

---

## 5. `dsh.client` 声明与加载

### 5.1 package.json（taskboard 可直接用）

```json
{
  "name": "dsh-taskboard",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "icon": "icon.svg",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["lib", "icon.svg", "cordis.patch.yml", "README.md", "LICENSE"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "external": []
    }
  },
  "engines": { "node": ">=20", "dsh": ">=0.2.2-rc.1" }
}
```

字段语义（**权威**：`dsh-package-manifest/lib/types/types.d.ts` 的 `DshClientManifest`）：

| 字段 | 含义 |
|---|---|
| `platform` | 必须是 `"web"`（Web 消费者按此选择） |
| `inject` | **「Informational package-name dependencies, not Cordis service injection」**——只写包名，不写服务名；写服务名不会报错但完全无效（ollama 就是这么写的，属可修的小瑕疵）。**看板可以省略。** |
| `immediately` | 「Boot phase-one registration barrier」——为 true 时进入 `prefetchImmediateTier()` 提前预取（`dist/idx≈949793`）。**只影响加载时机/性能**，不影响正确性；插件想「侧栏图标尽早出现」可以设 true（ollama 设了）。 |
| `external` | 除基线种子外**精确的模块表请求**，如 `["@deepseek-ai/dsh-client-ui-primitives"]`；不写就用不到那些包。任务板建议 `[]`（只用 react）。 |

### 5.2 加载链路（宿主 → 浏览器）

1. 宿主 `ClientModuleRegistry`（`dsh-client-modules/lib/index.js`）扫描**已启用的 Loader entry** 对应包的 `package.json.dsh.client`，读 `exports["./client"]` 的**构建产物**（不是源码）；缺 `./client` 直接抛 `declares dsh.client but exports no "./client" bundle`（L792）。
2. 组 boot graph（`window.__DSH_BOOT__`），bundle 由 `/plugins` 路由以 **combo URL** 提供：`plugins/??<pkg>&rev=<rev>`（`comboReference` L275-277），单包回退 URL 也一直可用。
3. 页面 `<head>` 注入：`__ModuleLoader__` queue facade → 预取 `<link rel=modulepreload>`（application 批次）→ **阻塞式 classic script**（bootstrap 批次）→ `__DSH_BOOT__`（`bootInjections` L518-563）。
4. 浏览器 `ClientModuleSystem` 懒加载：script 执行 → `load({id,factory})` → 首次 `import` 时物化 → cordis 激活。
5. 刷新页面或 HMR：宿主按 bundle 文件 `mtime/size` 生成 rev；`<pkg>/client` 与裸包名解析到同一 exports（L90-100）。**改完 `lib/client.js` 刷新浏览器即可**；HMR 也能自动热更（client.js 变化 → 页面重载该模块）。

### 5.3 能不能直接 ESM？

**不能。** bundle 以 classic `<script>` 加载（无 `type="module"`，L580-594），顶层 `import`/`export` 会语法错误。必须：

```js
window.__ModuleLoader__.load({
  id: 'dsh-taskboard',                    // = 包名
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    /* … 所有代码与副作用 … */
    exports.apply = apply
    exports.inject = ['slots', 'connection', 'timer', 'locale']
    return module.exports
  },
})
```

### 5.4 安装/启用（宿主侧配套，非本任务重点）

- 包内 `cordis.patch.yml` 插一行 Host loader entry（ollama 的原文）：

```yaml
- insert:
    - id: taskboard
      name: dsh-taskboard
```

- 安装：`dsh plugin --profile web add dsh-taskboard`，或本地目录用 `plugin_manager install_bundle`（会被 link 进 profile）；外部插件实际落在 `~/.dsh/extern/<pkg>/`（本机已有 `dsh-better-sidebar`、`dsh-web-terminal` 等）。
- 安装后**刷新 DSH Web 页面**才会加载新 bundle（Host 侧即时生效）。
- 注意 `cordis.patch.yml` 只插 Host 半；**Client 半不需要 loader row**，由 `dsh.client` 自动发现（ollama patch 文件头部注释 L3-6 明说）。

---

## 6. 最小可运行片段（= 规划的 `docs/client-skeleton.md` 内容）

> 说明：本任务写入范围只有 `docs/client-notes.md`，故把 `client-skeleton.md` 的完整内容放在本节；如需独立文件，请 Lead 直接拆分（内容可原样复制）。

### 6.1 `lib/client.js`（约 190 行，可直接跑）

```js
/**
 * dsh-taskboard —— 浏览器端 bundle（经 window.__ModuleLoader__ 加载）。
 * 三处界面：sidebar.panellist 图标 / main(key: taskboard) 三列看板 / sidebar.footer.action 计数。
 * 数据通道：Connection RPC，宿主在 /taskboard 注册路由，endpoint = snapshot。
 * 约束：只 require('react')；不 require 任何 @deepseek-ai/* 包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-taskboard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const BUNDLE_ID = 'dsh-taskboard'
    const RPC_CHANNEL = '/taskboard'
    const CSS_TAG_ID = BUNDLE_ID + '/client.css'
    const POLL_MS = 2000

    /* ── 样式（幂等注入；只用 --dsw-* 主题变量）──────────────────── */
    const CSS = [
      '.tb-page{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;overflow:auto;padding:14px 18px 18px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);width:100%}',
      '.tb-page *{box-sizing:border-box}',
      '.tb-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.tb-title{margin:0;font:var(--dsw-font-s-strong-14);font-size:17px;font-weight:600}',
      '.tb-sub{margin:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.tb-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font:var(--dsw-font-xxs-strong-12);cursor:pointer;white-space:nowrap}',
      '.tb-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tb-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.tb-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.tb-error{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--dsw-alias-border-l1));border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary)}',
      '.tb-board{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:start;min-height:0}',
      '@media (max-width:980px){.tb-board{grid-template-columns:minmax(0,1fr)}}',
      '.tb-col{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}',
      '.tb-col-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.tb-col-title{display:inline-flex;align-items:center;gap:6px;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary)}',
      '.tb-dot{width:6px;height:6px;border-radius:999px;flex:none;background:var(--dsw-alias-state-idle-primary)}',
      '.tb-col[data-col=doing] .tb-dot{background:var(--dsw-alias-state-warn-primary)}',
      '.tb-col[data-col=done] .tb-dot{background:var(--dsw-alias-state-success-primary)}',
      '.tb-count{font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-label-tertiary)}',
      '.tb-card{display:flex;flex-direction:column;gap:5px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);min-width:0}',
      '.tb-card-title{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tb-card-meta{display:flex;align-items:center;gap:6px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.tb-tag{padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-label-secondary)}',
      '.tb-empty{padding:18px 8px;text-align:center;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}',
      '.tb-skeleton{height:64px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-skeleton)}',
      '.tb-foot{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.tb-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 4px;min-width:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary)}',
      '.tb-bar-val{font:var(--dsw-font-xxxs-strong-11);color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}',
    ].join('\n')

    function injectCss() {
      if (typeof document === 'undefined') return null
      if (document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') !== null) return null
      const tag = document.createElement('style')
      tag.dataset.plugin = BUNDLE_ID
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      ;(document.head || document.documentElement).appendChild(tag)
      return tag
    }

    /* ── 纯函数（便于单测）────────────────────────────────────── */
    const COLUMNS = [
      { id: 'todo', title: '待开始' },
      { id: 'doing', title: '进行中' },
      { id: 'done', title: '已完成' },
    ]
    const STATUSES = ['todo', 'doing', 'done']

    function groupByColumn(tasks) {
      const out = { todo: [], doing: [], done: [] }
      if (!Array.isArray(tasks)) return out
      for (const task of tasks) {
        if (!task || typeof task !== 'object') continue
        const status = STATUSES.includes(task.status) ? task.status : 'todo'
        if (task.archived === true) continue
        out[status].push(task)
      }
      return out
    }

    function countsOf(tasks) {
      const groups = groupByColumn(tasks)
      return { todo: groups.todo.length, doing: groups.doing.length, done: groups.done.length }
    }

    /* ── 图标（侧栏入口）──────────────────────────────────────── */
    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? Math.min(24, Math.max(14, props.size)) : 20
      const active = props && props.active === true
      const stroke = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      const rects = [
        { key: 'a', x: 4, y: 5, w: 4.6, h: 14, r: 1.2 },
        { key: 'b', x: 9.7, y: 5, w: 4.6, h: 9, r: 1.2 },
        { key: 'c', x: 15.4, y: 5, w: 4.6, h: 5.5, r: 1.2 },
      ]
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
        style: { display: 'block', color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
      }, rects.map((r) => h('rect', {
        key: r.key, x: r.x, y: r.y, width: r.w, height: r.h, rx: r.r,
        stroke: stroke, strokeWidth: 1.6,
      })))
    }

    /* ── 插件主体 ─────────────────────────────────────────────── */
    function apply(ctx) {
      const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (!slots) return
      const connection = ctx.connection || (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)

      // 样式：随 fiber 卸载移除
      const installCss = () => {
        const tag = injectCss()
        return () => { if (tag && tag.parentNode) tag.parentNode.removeChild(tag) }
      }
      try {
        if (typeof ctx.effect === 'function') ctx.effect(installCss, BUNDLE_ID + ': css')
        else installCss()
      } catch (e) { /* 样式失败不阻塞渲染 */ }

      function callRpc(endpoint, payload) {
        try {
          if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
            return Promise.resolve({ ok: false, error: { code: 'internal', message: 'connection unavailable' } })
          }
          return Promise.resolve(connection.rpc.call(RPC_CHANNEL, endpoint, payload || {}))
            .then((r) => (r && typeof r.ok === 'boolean')
              ? r
              : { ok: false, error: { code: 'internal', message: 'malformed RPC response' } })
            .catch((e) => ({ ok: false, error: { code: 'network', message: String((e && e.message) || e) } }))
        } catch (e) {
          return Promise.resolve({ ok: false, error: { code: 'internal', message: String((e && e.message) || e) } })
        }
      }

      /* ── 三列看板页（数据 owner）───────────────────────────── */
      function BoardPage() {
        const snapState = React.useState(null)
        const snap = snapState[0]
        const setSnap = snapState[1]
        const errorState = React.useState(null)
        const error = errorState[0]
        const setError = errorState[1]
        const busyState = React.useState(false)
        const busy = busyState[0]
        const setBusy = busyState[1]

        const load = React.useCallback(() => {
          setBusy(true)
          callRpc('snapshot', {}).then((result) => {
            if (result && result.ok === true) {
              setSnap(result.value && typeof result.value === 'object' ? result.value : {})
              setError(null)
            } else {
              setError((result && result.error) || { code: 'internal', message: '' })
            }
            setBusy(false)
          })
        }, [])

        React.useEffect(() => {
          let alive = true
          let inFlight = false
          const tick = () => {
            if (!alive || inFlight) return
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            inFlight = true
            callRpc('snapshot', {}).then((result) => {
              inFlight = false
              if (!alive) return
              if (result && result.ok === true) {
                setSnap(result.value && typeof result.value === 'object' ? result.value : {})
                setError(null)
              } else {
                setError((result && result.error) || { code: 'internal', message: '' })
              }
            })
          }
          tick()
          const id = window.setInterval(tick, POLL_MS)
          return () => { alive = false; window.clearInterval(id) }
        }, [])

        const tasks = snap && Array.isArray(snap.tasks) ? snap.tasks : []
        const groups = groupByColumn(tasks)
        const total = tasks.filter((t) => t && t.archived !== true).length

        const header = h('header', { className: 'tb-head' },
          h('div', null,
            h('h1', { className: 'tb-title' }, '任务看板'),
            h('p', { className: 'tb-sub' },
              total > 0 ? ('共 ' + total + ' 个任务' + (snap && snap.updatedAt ? ' · 更新于 ' + String(snap.updatedAt) : ''))
                : '暂无任务；宿主数据就绪后自动出现')
          ),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('button', {
              className: 'tb-btn tb-btn-primary', type: 'button',
              disabled: busy, 'aria-busy': busy ? 'true' : 'false',
              onClick: load,
            }, busy ? '刷新中…' : '刷新')
          )
        )

        const body = snap === null
          ? h('div', { className: 'tb-board' }, COLUMNS.map((col) => h('section', {
              key: col.id, className: 'tb-col', 'data-col': col.id,
            },
              h('div', { className: 'tb-col-head' }, h('span', { className: 'tb-col-title' },
                h('span', { className: 'tb-dot', 'aria-hidden': 'true' }), col.title)),
              h('div', { className: 'tb-skeleton' }), h('div', { className: 'tb-skeleton' }))))
          : h('div', { className: 'tb-board' }, COLUMNS.map((col) => {
              const rows = groups[col.id] || []
              return h('section', { key: col.id, className: 'tb-col', 'data-col': col.id },
                h('div', { className: 'tb-col-head' },
                  h('span', { className: 'tb-col-title' },
                    h('span', { className: 'tb-dot', 'aria-hidden': 'true' }), col.title),
                  h('span', { className: 'tb-count' }, String(rows.length))
                ),
                rows.length === 0
                  ? h('div', { className: 'tb-empty' }, '暂无任务')
                  : rows.map((task) => h('article', { key: String(task.id), className: 'tb-card' },
                      h('div', { className: 'tb-card-title', title: String(task.title || '') }, String(task.title || '未命名')),
                      h('div', { className: 'tb-card-meta' },
                        task.assignee ? h('span', null, String(task.assignee)) : null,
                        task.priority ? h('span', { className: 'tb-tag' }, String(task.priority)) : null,
                        task.updatedAt ? h('span', null, String(task.updatedAt)) : null
                      ))))
            }))

        return h('div', { className: 'tb-page' },
          header,
          error !== null ? h('div', { className: 'tb-error', role: 'status' },
            h('span', null, '数据加载失败：' + String((error && error.code) || 'internal')),
            h('button', { className: 'tb-btn', type: 'button', onClick: load }, '重试')) : null,
          body,
          h('footer', { className: 'tb-foot' }, '每 ' + (POLL_MS / 1000) + ' 秒自动刷新 · 归档任务不显示')
        )
      }

      /* ── 侧栏底部计数条（窄栏隐藏）────────────────────────── */
      function FooterCount(props) {
        const wide = !(props && props.wide === false)
        const snapState = React.useState(null)
        const snap = snapState[0]
        const setSnap = snapState[1]
        React.useEffect(() => {
          if (!wide) return undefined
          let alive = true
          let inFlight = false
          const tick = () => {
            if (!alive || inFlight) return
            inFlight = true
            callRpc('snapshot', {}).then((result) => {
              inFlight = false
              if (!alive) return
              setSnap(result && result.ok === true ? (result.value || {}) : null)
            })
          }
          tick()
          const id = window.setInterval(tick, 5000)
          return () => { alive = false; window.clearInterval(id) }
        }, [wide])
        if (!wide) return null
        const counts = countsOf(snap && Array.isArray(snap.tasks) ? snap.tasks : [])
        return h('div', { className: 'tb-bar', title: '任务看板计数' },
          h('span', null, '任务'),
          h('span', { className: 'tb-bar-val' }, counts.todo + ' / ' + counts.doing + ' / ' + counts.done)
        )
      }

      /* ── 槽位注册 ─────────────────────────────────────────── */
      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: 'taskboard',
        order: 40,
        label: () => '任务看板',
      }, PanelIcon))

      slots.inject('main', () => slots.register({
        name: 'main',
        key: 'taskboard',
        label: () => '任务看板',
      }, BoardPage))

      slots.inject('sidebar.footer.action', () => slots.register({
        name: 'sidebar.footer.action',
        id: 'taskboard-count',
        order: 90,
        label: () => '任务计数',
      }, FooterCount))
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection', 'timer', 'locale']
    exports.__test = { groupByColumn, countsOf, COLUMNS }   // 纯函数测试口（可选）

    return module.exports
  },
})
```

对应 `snapshot` 的宿主返回（约定，可按看板需求改）：

```json
{ "version": 1, "updatedAt": "2026-11-11T02:30:00.000Z",
  "tasks": [
    { "id": "t1", "title": "调研 slot 契约", "status": "doing", "priority": "P1", "assignee": "client-scout", "archived": false, "updatedAt": "02:10" }
  ] }
```

### 6.2 jsdom 冒烟测试骨架（`test/client-render.test.mjs`）

思路（对齐 ollama `.dev/smoke-client-apply.mjs` 与 `.dev/render-jsdom.mjs`）：
1. `vm.runInNewContext` 跑 bundle，stub `window.__ModuleLoader__.load` 捕获 `{id, factory}`；
2. 用**假 ctx** 驱动 `exports.apply(ctx)`（`slots`/`connection`/`timer`/`locale`/`effect` 全部手写）；
3. 用真 React + react-dom/client 在 jsdom 里渲染 `main` 注册的组件；
4. 断言：三列标题出现、RPC 被调用、`<style>` 幂等、卸载后 `clearInterval` 被调用；
5. 收 `console.error`，有 React 错误即失败。

```js
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { createRequire } from 'node:module'

// 用 DSH 安装包里的 react / react-dom / jsdom（本机示例，按需改路径）
const dshRequire = createRequire('C:/Users/duan/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json')
const React = dshRequire('react')
const ReactDOMClient = dshRequire('react-dom/client')
const { JSDOM } = dshRequire('jsdom')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const { window } = dom
const { document } = window
globalThis.window = window
globalThis.document = document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Node = window.Node
globalThis.Event = window.Event
globalThis.MutationObserver = window.MutationObserver

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/* 1. 捕获 factory */
const captured = {}
window.__ModuleLoader__ = { load(def) { captured.def = def } }

/* 2. 定时器/interval 记录，便于断言清理 */
const intervals = new Map()
let nextTimerId = 1
const fakeSetInterval = (fn, ms) => { const id = nextTimerId++; intervals.set(id, { fn, ms }); return id }
const fakeClearInterval = (id) => { intervals.delete(id) }

// 组件在 Node 上下文执行，读的是全局 jsdom window：把它也换成假实现，
// 否则 window.setInterval 会走 jsdom 真定时器，清理断言测不到。
window.setInterval = fakeSetInterval
window.clearInterval = fakeClearInterval

const sandbox = {
  console, Intl, Date, JSON, Math, Promise,
  setTimeout: () => 0, clearTimeout: () => {},
  setInterval: fakeSetInterval, clearInterval: fakeClearInterval,
  document, window, navigator: window.navigator,
  require(id) { if (id === 'react') return React; throw new Error('unexpected require ' + id) },
}
sandbox.globalThis = sandbox
runInContext(source, createContext(sandbox), { filename: 'client.js' })

const exportsObj = captured.def.factory(sandbox.require)

/* 3. 假 ctx：slots 真的执行 inject 回调，register 收集注册项 */
const registrations = []
const rpcCalls = []
const snapshotPayload = {
  version: 1,
  tasks: [
    { id: 't1', title: '调研 slot 契约', status: 'doing' },
    { id: 't2', title: '写 client 骨架', status: 'todo' },
    { id: 't3', title: 'jsdom 冒烟', status: 'done' },
    { id: 't4', title: '已归档任务', status: 'todo', archived: true },
  ],
}
const services = {
  slots: {
    inject(name, factory) { const d = factory(); return typeof d === 'function' ? d : () => {} },
    register(options, component) { registrations.push({ options, component }); return () => {} },
    entriesOfSlot() { return [] },
  },
  connection: {
    rpc: {
      call(channel, endpoint, payload) {
        rpcCalls.push({ channel, endpoint, payload })
        return Promise.resolve({ ok: true, value: snapshotPayload })
      },
    },
  },
  timer: {},
  locale: { register: () => () => {}, bind: () => (k) => k, getLocale: () => ({ active: 'zh-CN' }) },
}
const ctx = {
  get(name) { return services[name] },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  interval: fakeSetInterval, timeout: () => () => {}, on: () => () => {},
}

const errors = []
const origError = console.error
console.error = (...args) => errors.push(args.map((a) => (a && a.stack) || String(a)).join(' '))

exportsObj.apply(ctx)

/* 4. 渲染 main */
const main = registrations.find((r) => r.options.name === 'main')
const host = document.createElement('div')
document.body.appendChild(host)
const root = ReactDOMClient.createRoot(host)
root.render(React.createElement(main.component, {}))
await new Promise((r) => setTimeout(r, 60))   // 等一次 snapshot 落地

const html = host.innerHTML
for (const label of ['待开始', '进行中', '已完成']) {
  if (!html.includes(label)) throw new Error('missing column: ' + label)
}
if (html.includes('已归档任务')) throw new Error('archived task must not render')
if (rpcCalls.length === 0 || rpcCalls[0].endpoint !== 'snapshot') throw new Error('snapshot not called')
if (rpcCalls[0].channel !== '/taskboard') throw new Error('wrong channel: ' + rpcCalls[0].channel)

/* 5. 幂等 + 清理 */
if (document.querySelectorAll('style[data-plugin-css]').length !== 1) throw new Error('style not idempotent')
root.unmount()
await new Promise((r) => setTimeout(r, 10))
if (intervals.size !== 0) throw new Error('interval leaked after unmount: ' + intervals.size)

console.error = origError
if (errors.length > 0) { console.log('React errors:', errors.slice(0, 3)); process.exitCode = 1 }
else console.log('OK: 3 columns, snapshot RPC, 1 style tag, interval cleaned')
```

要点/坑：
- `slots.register` 返回 disposer；`ctx.effect(fn)` 在假 ctx 里直接执行 `fn()` 并收集返回值（真 cordis 会登记到 fiber）。
- 渲染前必须把 `window`/`document`/`navigator` 挂到全局再 require react-dom（ollama 的 `render-jsdom.mjs` 同做法）。
- 想断言「2 秒后自动再拉一次」，可用假 interval 手动 `intervals.get(id).fn()`，**不要真等 2s**。
- 假 interval 必须同时替换 `window.setInterval`（组件运行在 Node 上下文，引用的是全局 jsdom window），只替换 vm sandbox 里的同名函数测不到。
- `captured.def.id` 也可断言 `=== 'dsh-taskboard'`。
- `react`/`react-dom`/`jsdom` 的解析路径：优先用 DSH 安装目录的 `node_modules`；本机也可装到插件包的 devDependencies（但本次调查未安装任何依赖）。

---

## 7. 疑点 / 风险 / 待验证

1. **`dsh.client.inject` 的写法分歧**：官方包写**包名**，ollama 写**服务名**。类型定义明确它是「informational package-name dependencies」，服务名会被 graph 组包时忽略（不报错）。→ 建议 taskboard **不写 inject**（或写空数组），真正的服务依赖放在 `exports.inject`。这不是阻塞问题，但会让插件清单/文档产生误解。
2. **`--dsw-alias-bg-l1` 不存在**（ollama 用了）：本版本 414 个变量里只有 `bg-base`/`bg-layer-1..3`。属旧版残留，别抄。
3. **`sidebar.footer.action` 的 `wide` 语义**：`wide === false` 表示侧栏折叠成 rail。官方与 ollama 都选择返回 `null`；若看板想在 rail 里显示图标也可以，但 rail 尺寸只有 36px，慎用。
4. **`main` 组件无 session props**：若看板要「按会话过滤」，只能从 `useSessions` + `retainedBy.mainView` 推断当前会话（layout 内部也是这么做的），或让宿主在 `snapshot` 里带 `sessionId` 由 URL/面板状态决定。**这是产品决策点，建议首版做「全局看板」，不绑会话。**
5. **`immediately` 的真实收益未量化**：只确认它进入 `prefetchImmediateTier()`（boot 阶段一预取）。对本插件（图标要在侧栏出现）建议设 `true`（ollama 同样），但不设也能工作。
6. **样式冲突**：slot 里没有 shadow DOM/CSS module 隔离，类名必须自带前缀（`.tb-`）并尽量少用元素选择器；`<style>` 全局生效。
7. **热更新**：改 `lib/client.js` 后刷新页面最稳；HMR 能否在不刷新时重载取决于宿主 SSE 与 bundle rev，开发期建议「改完刷新」。
8. **未在真实 GUI 里跑过本骨架**（本次约束：只读、不装依赖、不启动服务）。已在 jsdom 层面给出可执行测试骨架；端到端验证需要 Lead 在装好插件后刷新 `http://127.0.0.1:3080` 实测。
9. **右侧栏/抽屉**：`rightbar` 是 single 且被官方 `dsh-client-ui-sidebar-right` 独占；若产品坚持「右侧抽屉式看板」，可行路径是 `shell.overlay`（list，自己画覆盖层 + 遮罩）而不是抢 `rightbar`。
10. **文档拆分**：任务要求 `docs/client-skeleton.md`，但写入范围只批了 `docs/client-notes.md`；第 6 节即该文件全文，请 Lead 决定是否拆分。

---

## 8. 证据索引（文件 → 行号/偏移）

**DSH 安装包** `C:\Users\duan\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`

| 文件 | 关键位置 | 内容 |
|---|---|---|
| `dsh-client-modules/lib/index.js` | L199-209 | `exports["./client"]` 解析 |
| 同上 | L518-563 | bootInjections：queue facade 原文 + `__DSH_BOOT__` |
| 同上 | L792 | 缺 `./client` 抛错 |
| `dsh-client-modules/lib/client.js` | L14-31 | Lazy-CJS 契约注释 |
| 同上 | L580-594 | `defaultLoadBundle`：classic script |
| 同上 | L682 | `seed = staticModules` |
| 同上 | L703-716 | register：重复注册抛错、chunk |
| 同上 | L805-853 | materialize / makeRequire 白名单分支 |
| `dsh-client-modules/README.md` | 「Declaring a client plugin」「What the browser loads」「Sharing modules」 | `dsh.client`、external、基线模块表 |
| `dsh-web-frontend/dist/assets/index-BgUyXZcc.js` | idx≈944364 | `KZ()` 启动插件（`loader.internal=modules`、audit） |
| 同上 | idx≈949400 | `staticModules: YZ()` + 11 个种子模块 |
| 同上 | idx≈949793 | `prefetchImmediateTier`（`e.immediately`） |
| 同上 | idx≈493000-495500 | `SlotCore.register` / `entriesOfSlot`（kind 校验、排序、children） |
| 同上 | idx≈497600 | `SlotCore / resolveSlotLabel / standardHookPropName` 导出 |
| `dsh-client-ui-renderer/lib/client.js` | L736-767 | `standardKit`：t / useStore / renderSlot / SessionProvider |
| 同上 | L660-702 | 标准 props 物化（hooks→`use<Name>`） |
| 同上 | L1305-1352 | `SlotRegistry extends Service`，`super(ctx,"slots")` |
| 同上 | L1368-1427 | `slots.inject(key, cb)` 语义（等声明、随 fiber 回收） |
| 同上 | L1465-1484 | `provideRoot` |
| 同上 | L1813-1819 | `register = ctx.effect(_register)` |
| 同上 | L1867-1875 | 安装 renderer、provide `uiRenderer` |
| `dsh-client-ui-layout/lib/client.js` | L61 | 官方「当前会话」取法 |
| 同上 | L122-129 | `MainPanel` → `renderSlot("main",{}, {entryKey})` |
| 同上 | L332-347 | sidebar / rightbar / shell.overlay / shell.leading 渲染 |
| 同上 | L506-549 | `LayoutController`：selectPanel/toggleSidebar/openRightbar |
| 同上 | L570-571 | `DARK_ATTRIBUTE = "data-ds-dark-theme"` |
| 同上 | L699-736 | root 注册 + children（main=keyed 等） |
| `dsh-client-ui-sidebar/lib/client.js` | L206-238 | panellist props `{size, active}` + 点击 selectPanel |
| 同上 | L557-565 | footer.action props `{wide}` |
| 同上 | L666-672 | `inject=['slots','layout','uiWorkspace','locale','shortcuts']` |
| 同上 | L690-705 | panels 同步：`entriesOfSlot` + `resolveSlotLabel` + order |
| 同上 | L712-732 | `selectPanel → ctx.layout.selectPanel` |
| 同上 | L733-771 | sidebar children 声明（panellist/footer.action 等） |
| `dsh-client-ui-sidebar-right/lib/client.js` | 字符偏移约 222145 | `rightbar`(single) + `rightbar.session`(session) 声明 |
| `dsh-client-connection/lib/client.browser.js` | L1201-1239 | `rpc.call` 实现（信封、URL、返回 result） |
| 同上 | L1288-1319 | 响应信封严格校验 / target 正则 |
| 同上 | L1421-1456 | connection handle（state/generation/reconnect/rpc） |
| 同上 | L1497 | `ctx.provide("connection", handle)` |
| `dsh-client-ui-jobs/lib/client.js` | L323 | 组件 props 示例（sessionId/useJobs/t） |
| 同上 | L871-902 | 官方 apply + `slots.inject` + `register({inject})` 写法 |
| `dsh-client-ui-session/lib/client.js` | L1108-1130 | `provideRoot({hooks:{sessions,sessionStatus}})` + `installScope('session')` |
| `dsh-client-ui-workspace/lib/client.js` | L5781-5783 | `useWorkspaces` |
| `dsh-client-locale/lib/client.js` | L1520 / L1675 / L1702 / L1838 | getLocale / register / bind / provide |
| `dsh-client-ui-theme/lib/client.js` | 全文 | 414 个 `--dsw-*` 变量定义 |
| `dsh-package-manifest/lib/types/types.d.ts` | `DshClientManifest` | platform/inject/immediately/external 权威语义 |
| `dsh-host-webserver/lib/types/index.d.ts` | `WebRoute` / `WebServer.register` | 宿主路由注册签名 |

**ollama 参考实现** `C:\Users\duan\Code\dsh-ollama-statistical\`

| 位置 | 内容 |
|---|---|
| `lib/client.js` L1-22 | 文件头契约声明（三处界面、RPC、样式约束） |
| 同上 L306-319 | 幂等 `<style>` 注入 |
| 同上 L2046-2101 | `apply(ctx)`：`ctx.get('slots'/'connection'/'locale')`、`ctx.effect` 资源注册 |
| 同上 L2106-2123 | `callRpc` 封装（错误归一） |
| 同上 L2125-2152 | `every`/`later`：ctx.interval 优先、window 回退 |
| 同上 L3720-3745 | snapshot 应用 + SWR 跟进 |
| 同上 L3953-3967 | 页面轮询 effect + 清理 |
| 同上 L4236-4282 | footer 槽位组件（`props.wide`、独立轮询） |
| 同上 L4394-4415 | 三处 slot 注册 |
| `lib/index.js` L3728-3748 | 宿主 `fail`/`buildServerResponse` |
| 同上 L3943-3966 | HTTP 守卫（POST/JSON/loopback/body） |
| 同上 L3972-4003 | `ctx.webServer.register({kind:'prefix', path, handler})` |
| `.dev/protocol.md` L71-109 | RPC 信封 + 错误码表（实测契约） |
| `.dev/protocol.md` L276-289 | 三处槽位注册参数与 label thunk 说明 |
| `.dev/smoke-client-apply.mjs` | vm + 假 ctx 驱动 `apply` 的最小冒烟 |
| `.dev/render-jsdom.mjs` | jsdom + react-dom 真实渲染冒烟 |
