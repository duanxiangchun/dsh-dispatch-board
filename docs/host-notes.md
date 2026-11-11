# dsh-taskboard 宿主半 API 调查（dsh 0.2.2-rc.1 / Web profile）

> 只读调查：未改 `~/.dsh`、未装依赖、未起服务。证据前缀 **PKG** =
> `C:\Users\duan\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`
> 行号对 0.2.2-rc.1 安装包成立。参考真实插件 `C:\Users\duan\Code\dsh-ollama-statistical\lib\index.js`。

---

## 0. 结论速查

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 前缀路由 | `ctx.webServer.register({ kind:'prefix', path:'/taskboard', handler(req,res){} })` → 同步 disposer；`req/res` 是**原生 node:http**，无包装。前缀 `p` 命中 `p` 与 `p/<任意>`，最长前缀胜。需 Web profile（可 `inject:['webServer']` 或 `ctx.get('webServer')`）。 |
| 2 | 定时器 | `ctx.interval(cb,ms)` / `ctx.timeout(cb,ms)` → disposer，**卸载自动清理**（内部 `ctx.effect`）。需 `inject:['timer']`。 |
| 3 | 推消息给 agent | `agent.followup(msg)` = 排"下一轮"、**不打断当前轮**、idle 立刻开新轮 ✅。`steer` 进当前轮、`inject` 不唤醒、`send` 是底层。拿 agent：`ctx.agents.get/roots`（live）+ `ctx.get('sessionController').resolveAgent()`（冷会话，仅 Web）。 |
| 4 | 工具注册 | 直接 `ctx.tools.register({name,description,parameters:标准JSON Schema,output:{schema,render},execute})` 完全可行，**不必 import defineTool**。失败用 throw → `isError:true`。宿主根 ctx 注册 = 全局层，对**所有 preset** 的 Agent 可见。 |
| 5 | 持久化 | `DSH_HOME` 环境变量 → 缺省 `~/.dsh`；惯例 `$DSH_HOME/storages/<plugin>/<file>.json`（本机确有 `storages/ollama-statistical/*.json`）。原子写自己 tmp+rename。 |
| 6 | 会话/工作区 | 宿主路由**没有 ambient session**，必须由浏览器传 `sessionId`；工具调用用 `exec.agent`。根/子代理看 `session.header.origin==='subagent'`+`delegationDepth`。工作区 `ctx.get('workspaceRegistry')`（仅 Web）。 |
| 7 | inject | base 必有：`timer/sessions/agents/tools/subagents/sessionQuery/storageDomain`；仅 Web：`webServer/connection/sessionController/workspaceRegistry`。建议 `['timer','tools','agents','sessions']` + Web 能力可选挂载。 |

---

## 1. `ctx.webServer` 前缀路由

### 1.1 签名（证据：`PKG/dsh-host-webserver/lib/types/index.d.ts`）

```ts
export type WebRouteKind = 'exact' | 'prefix'                    // :37
export interface WebRoute {                                     // :39
  kind: WebRouteKind
  path: string        // 绝对路径，不接受尾斜杠               // :41
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>   // :44
}
register(route: WebRoute | WebResourceRoute): () => void         // :193
registerUpgrade(route): () => void                               // :200  (WS 升级，exact)
registerFallback(fallback): () => void                           // Web 里已被 SPA 占，别碰
readResource(request, peer): Promise<Response>                   // resource 形式只支持 GET/HEAD
get port() / get host() / get protocol() / getOrigin()
```

实现要点（`PKG/dsh-host-webserver/lib/index.js`）：

1. **没有 `route()/on()`**，就 `register()`；返回**同步** disposer。
2. `handler` 收**原生** `IncomingMessage/ServerResponse`；body 自己 `req.on('data')` 读，响应自己 `writeHead/end`，生命周期归你（可长挂 SSE）。
3. 前缀匹配 `pathname === p || pathname.startsWith(p + '/')`，**最长前缀胜**（`:580-589`）；顺序 exact → prefix → fallback（`:576-578`）。
4. **任意 HTTP 方法都会走到 handler**（`:459-472`）；`resource` 形式才限 GET/HEAD→否则 405。所以 POST RPC / SSE 都用 `handler`。
5. 同 `(kind,path)` 重复注册 **throw**（`:375-382`）。
6. handler 异步抛错 → server 回 **400 + warn**（`:473-483`）→ 自己 catch。
7. `webServer` 仅 Web profile（`PKG/dsh-web-app/cordis.patch.yml:175-184`，base 无此服务）。
8. 注册包 `ctx.effect`，否则插件卸载不摘路由。

### 1.2 可用骨架（裸前缀路由，现状 lib/index.js 的做法✔）

```js
export const name = 'taskboard'
export const inject = ['timer']                 // 见 `7：建议 webServer 改可选

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer) {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/taskboard',                       // 命中 /taskboard 与 /taskboard/<ep>
      handler: (req, res) => {
        handleHttp(ctx, req, res).catch(() => {
          if (!res.writableEnded) { res.statusCode = 500; res.end('internal error') }
        })
      },
    }), 'taskboard: rpc route')
  }
  // 轮询 / 工具照旧
}

function readBody(req) {                        // 原生长连接读取
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let done = false
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > 512 * 1024) { done = true; reject(Object.assign(new Error('too large'), { code: 'LIMIT' })); return }
      chunks.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')) } })
    req.on('error', (e) => { if (!done) { done = true; reject(e) } })
  })
}

function sendJson(res, status, value) {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}
```

**loopback 校验必须精确解析**（现状 `lib/index.js:572-573` 用 `host.startsWith('127.0.0.1')`，会被 `Host: 127.0.0.1.evil.com` 绕过 → P0 修）：

```js
function isLoopbackRequest(req) {
  const remote = req.socket?.remoteAddress || ''
  const addr = remote.startsWith('::ffff:') ? remote.slice(7) : remote
  if (addr !== '127.0.0.1' && addr !== '::1') return false
  const hostname = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}
```

### 1.3 更推荐：走 Connection RPC 通道（免手写鉴权/信封）

```ts
// PKG/dsh-client-connection/lib/types/rpc.d.ts
interface HostConnectionRpc {
  handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>   // :150
  intercept(channel: '/api', matches, handler): () => Promise<void>             // :158
}
type ConnectionRpcHandler = (endpoint, payload, signal: AbortSignal, peer) =>
  Promise<{ ok: true; value: unknown } | { ok: false; error: { code; message; details } }>   // :111,34-42
// 浏览器侧：connection.rpc.call('/taskboard', endpoint, payload)                 // :254
```

- `handle()` 内部注册 `kind:'prefix', path:'/taskboard'`（`:855-871`），先 `admit()`（401/403），再解信封（`:888-916`：仅 POST + `application/json`，`{type:'client-request',rpcId,method,payload}`，method 必须等于 URL 末段）。
- **坑**：`get rpc()` 用 `this.ctx`（connection 自己的 fiber，`:724-730`）→ 返回的 disposer 不随本插件卸载，必须自己包。

```js
function mountConnectionRpc(ctx, handlers) {
  const connection = ctx.get('connection')
  if (!connection) return false
  const dispatch = async (endpoint, payload, signal) => {
    const fn = handlers[endpoint]
    if (typeof fn !== 'function') return { ok: false, error: { code: 'not-found', message: 'unknown endpoint: ' + endpoint, details: {} } }
    try { return { ok: true, value: await fn(payload, signal) } }
    catch (e) { return { ok: false, error: {
      code: typeof e?.code === 'string' ? e.code : 'internal',
      message: e instanceof Error ? e.message : String(e),
      details: (e && typeof e.details === 'object' && e.details) || {},
    } } }
  }
  ctx.effect(() => { const dispose = connection.rpc.handle('/taskboard', dispatch); return () => dispose() },
             'taskboard: connection rpc channel')
  return true
}
```

> 二者不可对同一 path 同时注册（duplicate throw）。`connection.rpc` 不支持 SSE（POST+JSON 一问一答）；要推事件用裸路由 `text/event-stream` 或 `connection.fetch.register(...)`。

### 1.4 SSE 骨架

```js
function openSse(ctx, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  res.flushHeaders?.()
  const send = (event, data) => { if (!res.writableEnded) res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n') }
  const heartbeat = ctx.interval(() => send('ping', { t: Date.now() }), 15000)   // 自动清理
  res.on('close', () => { heartbeat(); if (!res.writableEnded) res.end() })
  return { send }
}
```

gzip 中间件按 `content-type` 跳过 SSE（`dsh-host-webserver/lib/index.js:198-209`）→ `content-type` 必须在首次 write 前设好。

---

## 2. `ctx.timer`

证据 `PKG/cordis-plugin-timer/lib/types/index.d.ts` + `src/index.ts`：

```ts
timeout(callback, delay): () => void     // 一次性；也支持 await ctx.timeout(ms) 睡眠
interval(callback, delay): () => void    // 周期；也支持 for await (const _ of ctx.interval(ms))
throttle(fn, delay, noTrailing?) / debounce(fn, delay)   // 返回带 .dispose 的函数
setTimeout / setInterval                 // @deprecated，等价上面两个
```

**自动清理规则**：`interval/timeout/throttle/debounce` 内部都是 `ctx.effect(() => { const t = setInterval(...); return () => clearInterval(t) }, 'ctx.interval()')`（`src/index.ts:45-56,104-120`）→ 插件 fiber 卸载自动 clear，返回的 disposer 也可手动调。**必须 `inject:['timer']`** 才有 `ctx.interval`（mixin 随服务 fiber 卸载移除，`cordis/lib/types/reflect.d.ts:55-59`）。裸 `setInterval` 不会自动清（现状 `lib/index.js:885-905` 用裸 `setInterval+unref` + 手写 cleanup，能跑但不合惯例，且 unref 后进程可能先退出）。

```js
function startPolling(ctx, rt) {
  let running = false
  const dispose = ctx.interval(async () => {
    if (running) return                    // 防重入
    running = true
    try { await pollOnce(ctx, rt) } catch (e) { console.warn('[taskboard] 轮询异常：' + (e?.message ?? e)) }
    finally { running = false }
  }, rt.state.config.pollIntervalMs)
  return dispose                            // 改间隔：dispose() 后重建
}
```

官方实践另注：别轮询 `agent/status`，用 `ctx.on('agent/status', …)` / `turn/end` 事件（`PKG/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:28-29`）。

---

## 3. `ctx.agents` 与 followup（**优先级最高**）

### 3.1 注册表 API（`PKG/dsh-agent/lib/types/index.d.ts`）

```ts
get(id: SessionId): Agent | undefined      // :357  live 查
list(): Agent[]                            // :371  全部 live
roots(): Agent[]                           // :378  顶层 Agent（不含子代理）
isOwnedBy(id, owner)                       // :366
currentInitiator() / requireInitiator()    // :232 / :241
withInitiator(agent, op) / withoutInitiator(op)   // :255 / :267  （定时器里用 withoutInitiator）
turnBoundaryOf(session)                    // :221
```

### 3.2 Agent live 属性（`PKG/dsh-agent/lib/types/runtime-types.d.ts` 增强）

| 成员 | 说明 |
| --- | --- |
| `agent.id` / `agent.session` | 同一 identity；`session.header` 有 cwd/origin/parentSession/agentPreset |
| `agent.status` | `'idle' | 'running'`（`:115,174`），只在 `agent/status` 事件翻转 |
| `agent.inbox` | `{ nextTurn, nextStep, clear, append, prepend, replace, remove, splice }` |
| `agent.whenIdle()` | `:191`；整 agent 静默，**不**代表"本条 followup 完成"（practices.md:28） |
| `agent.cancel(cause,{keepInbox})` / `runMaintenance(task)` | 中断 / 空闲任务 |

### 3.3 followup / steer / inject / send 语义（`runtime-types.d.ts:202-237` 原文）

| API | 签名 | 语义 | 打断当前轮 | 空闲唤醒/开新轮 | 选用 |
| --- | --- | --- | --- | --- | --- |
| `followup(msg)` | `(message: UserMessage) => void` | 排一条**普通后续轮**（该消息独占一轮），并唤醒 driver | **否**（当前轮跑完才轮到） | **是**，idle 立即开新轮 | ✅ **正确选择** |
| `steer(msg)` | 同上 | 投到**最近 step 边界**；running 时在当前轮内消费 | 是（插进当前轮） | 是 | ❌ |
| `inject(msg)` | 同上 | 仅作为下一步模型上下文排队，**不唤醒** | 否 | **否**（会一直挂着） | ❌ 单独用不投递 |
| `send(msg,target,wakeup)` | `(message,target:'next-turn'|'next-step',wakeup) => void` | 底层：`followup≈send(next-turn,true)`，`steer≈send(next-step,true)`，`inject≈send(next-step,false)` | 看 target | 看 wakeup | 精细控制时 |

### 3.4 手工构造 UserMessage **不会被解码器拒绝**（确认）

```ts
// PKG/dsh-llm/lib/types/message.d.ts:124-146
interface MessageBase { id: MessageId; content: readonly ContentBlock[]; source: MessageSource }
interface UserMessage extends MessageBase { role: 'user' }
// createUserMessage 只做：{ ...input, role:'user' } + id=brandString(randomUUID()) + structuredClone + deepFreeze（message.js:34-39）
```

- `MessageId` 运行时就是字符串（brandString 无校验），`id: randomUUID()` 合法。
- `source.kind:'user'` 是内建 `MessageSourceMap.user`（`message.d.ts:101-104`），`user/message` 是内建事件（`dsh-session/lib/types/known-event-types.js:80`）→ **一定能解码**。官方 `dsh-schedule` 用 `{kind:'schedule'}` 是靠 declare-module 扩展（纯 JS 做不了），我们用 `user` 最稳。
- 唯一要求：整条消息必须是 **lossless JSON**（无 undefined/BigInt/Date/Map/函数）——现状 `lib/index.js:476-483` 的构造满足。

### 3.5 完整投递路径（宿主无 Agent 上下文）——**你问的第 2 条，答案：正确，但补一步 flush**

```js
import { randomUUID } from 'node:crypto'

function createBoardUserMessage(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

async function deliverFollowup(ctx, sessionId, text) {
  const agents = ctx.get('agents')                 // 或 ctx.agents（已 inject 时）
  const agent = agents?.get(sessionId) ?? agents?.roots().at(-1)   // 精确优先，退化到最近 root
  if (!agent) return { ok: false, reason: 'no-agent' }
  if (agent.status !== 'idle') return { ok: false, reason: 'agent-busy' }   // 不打断

  const message = createBoardUserMessage(text)
  agent.followup(message)                          // ← 不打断当前轮，空闲时开新轮
  await ctx.sessions.flush(agent.session)          // ← 关键：确保 inbox splice 已落盘（官方 schedule 必做）
  return { ok: true, messageId: message.id }
}
```

官方同款：`PKG/dsh-schedule/lib/index.js:1381-1403` —— `createUserMessage(...) → agent.followup(message) → await this.ctx.sessions.flush(agent.session)`，失败即视为投递失败。若想等这一轮跑完再更新看板：`const done = agent.whenIdle()` 后跟踪（`:1392,1411-1419`）。

冷会话（agent 不在注册表）：官方用 `ctx.get('sessionController').resolveAgent(sessionId)`（`dsh-schedule/lib/index.js:1494-1508,2117-2129`；返回 `{agent}` 或 `{error}`）。该服务**仅 Web profile**（`dsh-web-app/cordis.patch.yml:116-118`）→ non-Web profile 只能推 live agent。

```js
async function resolveAgent(ctx, sessionId) {
  const live = ctx.get('agents')?.get(sessionId)
  if (live) return live
  const c = ctx.get('sessionController')
  if (!c?.resolveAgent) return undefined
  const r = await c.resolveAgent(sessionId).catch(() => undefined)
  return r && !('error' in r) ? r.agent : undefined
}
```

另：定时器里的投递建议包 `ctx.agents.withoutInitiator(async () => …)`，避免继承首个 Agent 的因果归属（官方 `dsh-schedule/lib/index.js:1153`）；判子代理用 `delegationDepthOf(agent)`（`dsh-subagent/lib/types/index.d.ts:52`）或 `session.header.origin==='subagent'`。

---

## 4. `ctx.tools.register`（纯 JS，不 import defineTool）

### 4.1 直接传标准 JSON Schema **可行**（确认）

```ts
// PKG/dsh-tools/lib/types/contracts.d.ts
interface ToolDefinition extends ToolSchema {            // :23  ToolSchema={name,description,parameters:Record<string,unknown>,deferLoading?}
  readonly output: {                                     // :25 必填
    readonly schema: JsonSchemaNode                      // 对成功返回值强校验
    render(args, value): ContentBlock[]                  // :18 纯函数
    presentationMeta?(args, value): JsonValue
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>    // :36
  timeoutMs?: number; isConcurrencySafe?(args): boolean
  presentCall?(args) / presentResult?(args, result)
}
register(definition, options?: { when?(ctx): boolean | Promise<boolean> }): () => void   // index.d.ts:50 / :118
interface ToolRunContext { agent?: Agent; signal: AbortSignal; callId; rootCallId; deferContext(m); concludeTurn() }  // :231
```

`defineTool` 只是把"作者 spec"编译成 JSON Schema 并加参数校验（`dsh-tools/lib/index.js:310-359`；作者 spec 见 `lib/types/schema.d.ts:178-248`）——**不是必需**。现状 `lib/index.js:1002-1100` 直接 `register` 手写 definition，正确。

`parameters` 两种写法**不能混**：

| | defineTool spec | 裸 ToolDefinition |
| --- | --- | --- |
| 形态 | 属性表 `{ title:{type:'string', required:true} }` | 完整 JSON Schema `{ type:'object', properties:{…}, required:['title'], additionalProperties:false }` |
| required | 每属性 `required: true` | 根上 `required: ['title']` |
| 谁校验参数 | defineTool 编译的 validate | **没人校验**，自己 execute 里判 |

支持子集（`dsh-tools/lib/types/json-schema.d.ts:24-49`）：`type(单值)/oneOf/properties/required/additionalProperties/items/enum/const` + 注解 `description/title/default/examples`；**不支持 `$ref/anyOf/allOf/pattern/minimum`**（register 时 `JsonSchemaError`）。`register()` 只强校验 `output` 存在且 `render` 是函数、`output.schema` 合法、名字非保留 `run_code`（`lib/index.js:433-445`）。

### 4.2 output.schema / render / 失败

- `output.schema` 对返回值**强制校验**；不匹配 → `ToolOutputError` → `isError:true`（"invalid output"）。schema 必须与真实返回逐字段一致（`additionalProperties:false` 时不能多字段；`type:'string'` 不能回 `null`）。
- `render` 纯函数，返回 ContentBlock[]；惯用 `[{ type:'text', text: JSON.stringify(value) }]`（官方 `dsh-tool-schedule/lib/index.js:406-411`）。
- 失败：**throw 即可**（`dsh-tools/lib/pipeline.js:850-864`）→ `content:[{type:'text',text:'Error: '+msg}], isError:true`；抛 `HarnessError`（`@deepseek-ai/dsh-llm`）额外带 `error.info={name,code}`。另一种官方风格：返回结构化错误对象 + `output.schema = { oneOf:[正常, 错误] }`（`dsh-tool-schedule/lib/index.js:329-375`）。
- `execute` 是 async，须观察/转发 `exec.signal`；超时用定义里的 `timeoutMs`（由 `dsh-tool-call-timeout-policy` 包装，不进模型 schema）。`exec.agent` 可拿调用者 `session.id/cwd`。

### 4.3 可见性：宿主级 = 全局，所有 preset 可见

证据链：
1. `register()` 用 `this.layers.effect(this.ctx, …)`（`dsh-tools/lib/index.js:441-444`）；
2. cordis 把服务实例的 `ctx` **代理成调用方 ctx**（`cordis/lib/index.js:125-163`，`tracker.property='ctx'`）→ 实际按**调用方作用域**归属；
3. `scopeOf(ctx)` 根插件为 `undefined`（`dsh-scope/lib/types/index.d.ts:84`）→ 落 `layers.global`；
4. 视图合并永远先 global 再叠 scope 链（`dsh-tools/lib/index.js:477-500`）→ **宿主根 ctx 注册的工具对所有 preset 的每个 Agent 可见**。

preset 在自己的 scope 注册行（`dsh-web-app/cordis.patch.yml:467-475` "agent plane moves behind agent presets"），只能 shadow 同名、不能隐藏 global；隐藏只能 `agent.ctx.tools.restrict({deny:[…]})` 或注册时给 `when`。`agent.ctx.tools.register()` 才是"仅此 Agent"。

### 4.4 骨架（现状写法✔，建议加 ctx.effect）

```js
const STATUS = ['todo', 'doing', 'done', 'archived']
const text = (v) => [{ type: 'text', text: JSON.stringify(v) }]

export function registerTools(ctx, rt) {
  const tools = ctx.get('tools')            // 可选服务，别硬 inject
  if (!tools) return
  ctx.effect(() => tools.register({
    name: 'taskboard_update',
    description: '更新看板任务：doing=已派发 / done=审核通过 / todo=打回重做 / archived=归档。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: {
        id: { type: 'string' }, status: { type: 'string', enum: STATUS },
        result: { type: 'string' }, assignee: { type: 'string' }, note: { type: 'string' },
      },
    },
    output: { schema: ONE_TASK_SCHEMA, render: (_a, v) => text(v) },
    async execute(args, exec) {
      if (!args?.id) throw new Error('缺少任务 id')          // → isError
      exec.signal.throwIfAborted?.()
      const task = applyTaskUpdate(rt.state, args.id, args)  // 非法迁移 throw → isError
      commitBoard(rt.state, rt.filePath)
      return { task: taskBrief(task) }
    },
  }), 'taskboard: tool taskboard_update')
}
```

**关于 `ctx.inject(['tools'], cb)` 的清理语义（你问的第 4 条）**：`ctx.inject` 等价于挂一个子插件，服务就绪才跑、服务变化时卸载重跑（`cordis/lib/types/registry.d.ts:99-111`）。`cb` 拿到的 `toolCtx` 是子插件 ctx；`tools.register` 内部是 `effect(...)` 挂在**调用方 ctx**（即 `toolCtx`）上，所以 **子插件卸载时会自动摘工具**（现状 `lib/index.js:1181-1188` 功能正确）。但显式再包一层 `ctx.effect(() => tools.register(...))` 更清楚（能拿 disposer、和官方写法一致）；注意别重复包——重复 dispose 幂等无害。

---

## 5. 持久化（你问的第 5 条）

### 5.1 路径与惯例

```ts
// PKG/dsh-home-paths/lib/types/index.d.ts
DSH_HOME_ENV = 'DSH_HOME'                                  // :11
resolveDshHome(configured?, env?): string                  // :59  显式 > $DSH_HOME > ~/.dsh
dshHomePath(...segments): string                           // :78
```

`PKG/dsh-base/cordis.patch.yml:179-190`：`storage-json` 的 `root = dshHomePath('storages')`，`storage-domain` backend=json。本机真实布局（只读列举）：

```text
~/.dsh/storages/
  schedule.json                                  ← storage-domain 单文件布局
  workspace.json
  session_projcache/sessions/<sessionId>.json     ← per-record 布局
  ollama-statistical/state.json                   ← 第三方插件自有子目录（惯例✔）
  ollama-statistical/ledger.json
  ollama-statistical/token-cache.json
```

→ 本插件用 `$DSH_HOME/storages/dsh-taskboard/board.json` 符合惯例（现状 `lib/index.js:93-104` 已如此）。用 `ctx.storageDomain` 需要 `defineDomain+zod`（要 import），纯 JS 不划算。

### 5.2 原子写（直接抄）

参考 `dsh-ollama-statistical/lib/index.js:1237-1258`：

```js
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeJsonAtomic(filePath, value) {
  let tempPath = null
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    tempPath = filePath + '.tmp-' + process.pid + '-' + Date.now()
    writeFileSync(tempPath, JSON.stringify(value), { mode: 0o600 })
    renameSync(tempPath, filePath)       // 同卷 rename 原子；Windows 保留目标安全描述符
    return true
  } catch {
    if (tempPath !== null) { try { unlinkSync(tempPath) } catch {} }
    return false
  }
}
```

### 5.3 `@deepseek-ai/dsh-atomic-write` 可用但别依赖

零依赖，`writeFileAtomic(filename, content, {mode})` + `withFileLock(filename, op, {waitMs})`（`PKG/dsh-atomic-write/lib/types/index.d.ts:46,85`）：独占创建防符号链接、Windows 对 EACCES/EBUSY/EPERM 有限重试、跨进程写锁（`<file>.lock` + PID 探测）。比手写完备，**但**是否 import 取决于安装布局（见 5.4）。

### 5.4 第三方插件能否 import `@deepseek-ai/*`？本机实测：能，同一实例，但仍别依赖

```text
node -e "require.resolve('@deepseek-ai/dsh-llm', {paths:['C:/Users/duan/.dsh/profiles/web/node_modules/dsh-ollama-statistical']})"
→ ...\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-llm\lib\index.js

Get-Item ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm
→ LinkType: Junction, Target: ...\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-llm
```

即解析到**宿主同一份物理模块**（`instanceof` 一致），`createUserMessage/defineTool/HarnessError` 都能安全用。仍建议不 import：① 换安装方式（pnpm isolated / 打包分发）Junction 不保证，且可能加载第二份 `dsh-llm` 导致 `instanceof` 失效；② `node --test` 下无 DSH 进程，纯函数单测 import 本文件会崩；③ 团队已约定纯 JS。若要用：**不要写进 dependencies**（会装出第二份），用 peerDependencies 或不声明，并验证解析物理路径一致。

### 5.5 并发

- 同进程：HTTP handler、工具 execute、定时器三方写同一 state。Node 单线程 + **全同步** 读-改-写不会交错；现状 commitBoard 是同步的✔。若中途 `await` 会引入交错，务必"先改内存再落盘"或加队列。
- 跨进程（Web + CLI 各起一个）：rename 保证读到完整文件，但读-改-写会丢更新 → 上 `withFileLock`，或接受"后写覆盖"+ `revision` 让 UI 发现回退。
- 损坏兜底：parse 失败先备份 `board.json.bak-<ts>` 再从空板起（本机 `storages/workspace.json.bak-20260808233922` 即此惯例）。
- 别写 `$DSH_HOME/sessions`、`.credentials.yaml`、profile 的 `cordis.patch.yml`（用户文件；改配置走 `ctx.get('configEditor').edit(ctx.fiber.entry, …)`，见 `host-plugin.md:66-77`）。

---

## 6. 会话 / 工作区上下文

### 6.1 宿主路由没有 ambient session

`handler` 只有 `req/res`（`dsh-host-webserver/lib/types/index.d.ts:44`）→ 看板 RPC 的 `sessionId` 必须由浏览器放进 payload。工具调用相反：`exec.agent` = 调用者（`contracts.d.ts:231`），`exec.agent.session.id / .header.cwd` 可直接用（官方 `dsh-tool-schedule/lib/index.js:480-494` 的 `targetFor` 用 `agent.session.id` 实现 "this_session"）。

### 6.2 枚举

```js
ctx.agents.list()          // live Agent：{ session.id, status, session.header }
ctx.agents.roots()         // 仅顶层（天然排除子代理）
ctx.agents.get(sessionId)
ctx.sessions.list()        // live Session[]（dsh-session/lib/types/index.d.ts:507）
ctx.sessions.get(id); await ctx.sessions.flush(session)
await ctx.get('sessionQuery')?.listSessions()   // 全部（含冷会话）[{ header, live, persisted }]
await ctx.get('sessionQuery')?.traceSession(id) // 祖先 + 后代树
```

`sessionQuery` 在 base 一定存在（`dsh-base/cordis.patch.yml:157-161`，`openAt: never` 但服务在）；`SessionRecord` 只有 `{header,live,persisted}`（`dsh-session-query/lib/types/types.d.ts:14-23`），无 activity——要"最近活跃"用 Web 的 `sessionController.list()`。

### 6.3 根 vs 子代理（`PKG/dsh-session/lib/types/types.d.ts:59-100`）

```ts
interface SessionHeader {
  cwd?: string
  parentSession?: SessionId   // :76 子代理的创建者；普通 fork 不写。单凭它不足以判定
  origin?: 'subagent'         // :86 子代理会话的粗分类
  delegationDepth?: number    // :92 顶层缺省 0，子代理 = 父+1
  agentPreset?: string        // :99
}
```

```js
function isSubagent(session) {
  const h = session?.header ?? {}
  return h.origin === 'subagent' || (typeof h.delegationDepth === 'number' && h.delegationDepth > 0)
}
function listTargets(ctx) {
  return ctx.agents.roots().map((a) => ({
    sessionId: a.session.id, status: a.status, cwd: a.session.header?.cwd ?? null,
    preset: a.ctx.get('agentPresets')?.composedPreset?.(a.ctx) ?? a.session.header?.agentPreset ?? null,
  }))
}
```

**"哪个是用户正在用的主 Agent"没有官方 API**：Web 每个标签是一个 root agent，宿主不知道前台。近似：① RPC 带 `sessionId`（最准）；② `roots()` 里取"最后一个 idle"（现状 `lib/index.js:432-447`）；③ `sessionController.list()` 活动排序（Web only）。建议写进 architecture.md 固定一种。

### 6.4 工作区（仅 Web）

`PKG/dsh-workspace/lib/types/index.d.ts`：`list() :172 / get(id) :165 / resolveByPath(path) :265 / create(path,title) :146 / archivedSessionIds :196`；`Workspace = { id, path, title, createdAt, updatedAt, sessionIds }`（`types.d.ts:63-89`）。用 `ctx.get('workspaceRegistry')` 并接受 undefined。会话自身 cwd 在 `session.header.cwd`，不依赖它。

---

## 7. inject 清单

### 7.1 哪些服务在哪

base 必有（`PKG/dsh-base/cordis.patch.yml`）：`timer :24-25`、`sessions(session) :40-41`、`agents(agent) :82-83`、`sessionQuery :157-161`、`storage/storageDomain :179-190`、`credentials :125-126`、`subagents :363-374`、`tools :497-499`、`systemPrompt :510-513`。

仅 Web（`PKG/dsh-web-app/cordis.patch.yml`）：`workspaceRegistry :87-88`、`sessionController :116-118`、`connection :230-237`、`webServer :175-184`。

### 7.2 inject 语义（决定"缺服务会不会整包不加载"）

- `export const inject = [...]`：**全部**服务可用才 ACTIVE，否则 **PENDING 静默挂起**（`cordis/lib/types/fiber.d.ts:59-66`；`registry.d.ts:57-58` "only loads while all are available"）。→ 在 headless profile 里 `inject:['webServer']` 会让整个插件（含工具、轮询）都不跑。
- `ctx.get(name)`：不声明依赖直接取，缺则 `undefined`（`cordis/lib/types/reflect.d.ts:6-16`）。
- `ctx.inject([...], cb)`：局部子插件，服务齐了才跑（官方推荐处理可选服务，`practices.md:20`）。
- **cordis 4.1 没有 `{required, optional}` 形态**（`registry.d.ts:13-15`：`Inject = (keyof M)[] | { [K]: interceptConfig }`）。

### 7.3 建议

```js
export const inject = ['timer', 'tools', 'agents', 'sessions']   // 全在 base

export function apply(ctx) {
  const webServer = ctx.get('webServer')         // Web 专属，可缺省
  if (webServer) { /* ctx.effect(() => webServer.register(...)) */ }
  const connection = ctx.get('connection')
  if (connection) { /* connection.rpc.handle('/taskboard', dispatch) */ }
  // 轮询：ctx.interval(tick, ms)
}
```

确定只服务 Web、可接受 headless 不加载，则现状 `['timer','webServer']` 也行——但把这个取舍写进 architecture.md，否则以后有人用 TUI 试会误判"插件没装上"。`subagents` 不必 inject（派发是主 Agent 的工具职责）；真要读子代理再 `ctx.get('subagents')`。

---

## 8. 对照现状 `lib/index.js` 的修正清单

| 级别 | 现状 | 建议 |
| --- | --- | --- |
| **P0** | `isLoopbackRequest` 用 `host.startsWith('127.0.0.1')`（`:572-573`），`Host: 127.0.0.1.evil.com` 可绕过 | 精确解析 hostname + 校验 `req.socket.remoteAddress`（`1.2`），或改走 `connection.rpc.handle` |
| **P0** | `agent.followup(message)` 后直接写盘（`:862`） | 补 `await ctx.sessions.flush(agent.session)`，否则重启丢消息但 `notificationCount` 已 +1 |
| P1 | `inject=['timer','webServer']`（`:31-32`） | 要 headless 生效改 `['timer']` + `ctx.get('webServer')`；仅 Web 则保留并写明 |
| P1 | 裸 `setInterval+unref` + 手写 cleanup（`:885-905`） | 换 `ctx.interval(tick, ms)`（自动清理、不 unref），改间隔 `dispose()` 重建 |
| P1 | 裸路由 + 自守 loopback（`:1145-1164`） | 优先 `connection.rpc.handle`；裸路由留降级；两者不可同 path |
| P2 | 工具在 `ctx.inject(['tools'], cb)` 内注册、未包 `ctx.effect`（`:1181-1188`） | 包 `ctx.effect(() => tools.register(def))`（清理语义本就正确，只是更显式） |
| P2 | `execute` 不观察 `exec.signal`（`:1022,1049,1090`） | 目前同步内存操作无碍；加异步后必须转发 |
| P2 | 目标 agent 取 `roots()` 最后一个 idle（`:432-447`） | 保留 + 优先 RPC 上报的 `sessionId`；可监听 `agent/status` 即时补投 |
| P3 | 预设逐文件写（`:540-543`） | 可接受（标记文件最后写）；要严格原子则临时目录 + rename |

---

## 9. 疑点 / 待决策

1. **`@deepseek-ai/*` 解析依赖安装布局**：本机（全局 npm 装 dsh + `profiles/node_modules` Junction）可解析且同实例；换 pnpm isolated / 打包分发可能失效（`5.4` 已给验证命令）。
2. **"用户当前主 Agent"无官方 API**，需产品决策（`6.3` 三选一）。
3. **SSE 通道选型**：`connection.rpc` 只能 POST/JSON；实时推送用裸路由（无鉴权，自守 loopback）或 `connection.fetch.register`（受鉴权，有 body/method 约束）。当前 `/taskboard/snapshot` 轮询暂不需要。
4. **`output.schema` 严格度**：数组 `items/oneOf/const` 支持，`$ref/anyOf/pattern` 不支持；返回 `undefined` 字段或 `null≠string` 会 `ToolOutputError`（现状 `taskBrief` 用 `|| ''` 兜空串，安全）。
5. **`ctx.sessions.flush()` 返回 `Promise<boolean>`**，false = 无持久化 listener（纯内存 session）。它保证"事件已落盘"，**不是**"模型已收到"。
6. **HMR/重复 apply**：`webServer.register` 对重复 `(kind,path)` throw；现状 `ctx.effect + try/catch` 已兜住（旧 fiber dispose 会摘路由）。

---

## 10. 证据索引

| 主题 | 位置 |
| --- | --- |
| 路由 API / 匹配 / SSE gzip | `PKG/dsh-host-webserver/lib/types/index.d.ts:37-44,193,200`；`lib/index.js:198-209,375-382,459-487,576-589` |
| Connection RPC | `PKG/dsh-client-connection/lib/types/rpc.d.ts:34-42,111,143-159,254`；`lib/index.js:724-730,855-916` |
| 定时器 | `PKG/cordis-plugin-timer/lib/types/index.d.ts`；`src/index.ts:26-120` |
| Agent 注册表 / 运行时 | `PKG/dsh-agent/lib/types/index.d.ts:221-241,357-378`；`runtime-types.d.ts:115,174,191,202-237` |
| followup 官方范例 | `PKG/dsh-schedule/lib/index.js:1153,1381-1403,1454-1508,2117-2129`；`lib/types/runtime.d.ts:2-8` |
| 工具注册 | `PKG/dsh-tools/lib/types/index.d.ts:50`；`contracts.d.ts:14-36,110-118,231-248`；`json-schema.d.ts:24-49`；`lib/index.js:310-359,433-445,477-500` |
| 工具失败→isError | `PKG/dsh-tools/lib/pipeline.js:835-864` |
| 官方工具写法 | `PKG/dsh-tool-schedule/lib/index.js:1,329-375,406-411,451-494,503-559` |
| 服务 ctx 代理/作用域 | `PKG/cordis/lib/index.js:125-163,1842-1856`；`dsh-scope/lib/types/index.d.ts:84`；`lib/types/store.d.ts:102-145` |
| inject/fiber/effect | `PKG/cordis/lib/types/registry.d.ts:13-15,50-63,99-111`；`fiber.d.ts:59-66,148-163`；`reflect.d.ts:6-16` |
| 消息/会话 | `PKG/dsh-llm/lib/types/message.d.ts:101-146,196-216`；`message.js:34-58`；`dsh-session/lib/types/index.d.ts:494-507`；`types.d.ts:59-100` |
| 全会话查询 | `PKG/dsh-session-query/lib/types/index.d.ts:67,74,135`；`types.d.ts:14-23` |
| 工作区 | `PKG/dsh-workspace/lib/types/index.d.ts:146,165,172,196,265`；`types.d.ts:63-89` |
| 路径 / 原子写 | `PKG/dsh-home-paths/lib/types/index.d.ts:11,59,78`；`dsh-atomic-write/lib/types/index.d.ts:46,85` |
| bundle 装配 | `PKG/dsh-base/cordis.patch.yml:24-25,40-41,82-83,125-126,157-161,179-190,363-374,497-499,510-520`；`dsh-web-app/cordis.patch.yml:87-88,116-118,175-184,230-237,467-475` |
| 官方插件开发约定 | `PKG/dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md:57-77`；`practices.md:6-29` |
| 参考插件 | `C:\Users\duan\Code\dsh-ollama-statistical\lib\index.js:1-61,1166-1258,3900-4048`；`.dev/protocol.md:71-110` |
