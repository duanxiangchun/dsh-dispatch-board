import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ATTACHMENT_MEDIA_TYPES,
  BoardError,
  DEFAULT_DISPATCH_MODE,
  DISPATCH_MODES,
  LEAD_AUTO_MARK,
  LEAD_IN_FLIGHT_TTL_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_BODY_BYTES,
  MAX_TASK_ATTACHMENTS,
  MAX_UPLOAD_BODY_BYTES,
  STATUSES,
  TASK_LIST_OUTPUT_SCHEMA,
  TASK_ONE_OUTPUT_SCHEMA,
  addTask,
  applyTaskUpdate,
  archivedSessionIdSet,
  archiveDoneTasks,
  assertNoteAttachments,
  attachmentRef,
  attachmentsDir,
  bindMainSession,
  boardPath,
  bodyLimitFor,
  buildDispatchText,
  buildMainSessionRef,
  buildReceiptText,
  buildSnapshot,
  buildWorkspaceLeadRefs,
  canTransition,
  clearMainSession,
  commitBoard,
  countAttachmentRefs,
  createBoardUserMessage,
  createEmptyBoard,
  createLeadAutoState,
  decodeImageDataUrl,
  deleteTask,
  endpointFromUrl,
  ensureWorkspaceLead,
  findLeadInFlightTask,
  findTask,
  findTaskByWorker,
  firstDispatchLine,
  flattenResultLine,
  flushReceipts,
  handleHttp,
  handleSubagentDispatch,
  handleSubagentEnd,
  hostnameOfHostHeader,
  inspectPresets,
  isAbsoluteWorkspacePath,
  isLeadAutoTask,
  isLoopbackRequest,
  leadTaskTitle,
  loadAttachmentIndex,
  normalizeBoard,
  normalizeConfig,
  normalizeConfig as normalizeConfigAlias,
  normalizeLeadAuto,
  normalizePathForCompare,
  normalizeWorkspaceLeads,
  notifyCooldownMs,
  listWorkspaces,
  readAttachment,
  registerLeadAutoHooks,
  requeueTasksOfLead,
  parseRpcEnvelope,
  putWorkspaceLead,
  registerTools,
  reloadBoardIfStale,
  resolveSessionCwd,
  resolveSessionCwdViaQuery,
  resolveTargetAgent,
  resolveWorkspaceTarget,
  saveAttachment,
  selectDispatchCandidate,
  selectReceiptTasks,
  selectWorkspaceLead,
  sniffImageMime,
  subagentPromptText,
  taskBrief,
  tick,
  truncateNote,
  workspaceIdForCwd,
  workspaceKeyForCwd,
  workspacePathForCwd,
  workerResultText,
} from '../lib/index.js'

const NOW = Date.parse('2026-11-11T02:00:00.000Z')

/**
 * 迷你 JSON Schema 校验器：只覆盖 lib/index.js 工具 output.schema 用到的子集
 * （type / additionalProperties / required / properties / items / enum）。
 * 工具输出契约是封闭的（对象层 additionalProperties:false），用它断言
 * taskBrief() 不会带出 schema 未声明的字段。返回问题列表，空数组 = 符合。
 */
function schemaProblems(value, schema, path = 'value') {
  if (!schema || typeof schema !== 'object') return []
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [path + ' 应为 object']
    }
    const problems = []
    const properties = schema.properties || {}
    for (const key of schema.required || []) {
      if (!(key in value)) problems.push(path + '.' + key + ' 是必填字段')
    }
    for (const [key, child] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        if (schema.additionalProperties === false) {
          problems.push(path + '.' + key + ' 未在 schema 声明（additionalProperties:false）')
        }
        continue
      }
      problems.push(...schemaProblems(child, properties[key], path + '.' + key))
    }
    return problems
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [path + ' 应为 array']
    return value.flatMap((item, index) => schemaProblems(item, schema.items || {}, path + '[' + index + ']'))
  }
  if (schema.type === 'string' && typeof value !== 'string') return [path + ' 应为 string']
  if (schema.type === 'integer' && !Number.isInteger(value)) return [path + ' 应为 integer']
  if (schema.type === 'boolean' && typeof value !== 'boolean') return [path + ' 应为 boolean']
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [path + ' 不在 enum 内：' + String(value)]
  return []
}

function boardWith(...titles) {
  const state = createEmptyBoard()
  for (const title of titles) addTask(state, { title }, NOW)
  return state
}

/** tick / flush 单测用的最小 runtime（真实 apply() 里由插件入口构造）。 */
function fakeRuntime(state, ctx, filePath) {
  return {
    ctx,
    state,
    filePath,
    poll: {
      running: true,
      lastRunAt: null,
      lastDispatchAt: null,
      lastDispatchTaskId: null,
      lastDispatchSessionId: null,
      lastDispatchSessionTitle: null,
      lastSkipReason: null,
    },
    reviveFailures: new Map(),
    flushingReceipts: false,
  }
}

test('empty board has version, config and no tasks', () => {
  const state = createEmptyBoard()
  assert.equal(state.version, 1)
  assert.deepEqual(state.tasks, [])
  assert.equal(state.config.pollEnabled, true)
  assert.equal(state.config.pollIntervalMs, 15000)
})

test('normalizeConfig clamps interval and defaults', () => {
  assert.equal(normalizeConfig({ pollIntervalMs: 1 }).pollIntervalMs, 15000)
  assert.equal(normalizeConfig({ pollIntervalMs: 5000 }).pollIntervalMs, 5000)
  assert.equal(normalizeConfig({ pollIntervalMs: 999999 }).pollIntervalMs, 15000)
  assert.equal(normalizeConfig({ pollIntervalMs: 30000 }).pollIntervalMs, 30000)
  assert.equal(normalizeConfig({ pollEnabled: false }).pollEnabled, false)
  assert.equal(normalizeConfig({ maxNotifications: 0 }).maxNotifications, 5)
})

test('normalizeBoard drops bad tasks and repairs nextId', () => {
  const { state, dropped } = normalizeBoard({
    version: 1,
    nextId: 1,
    config: { pollIntervalMs: 20000 },
    tasks: [
      { id: 't-7', title: 'ok', status: 'doing' },
      { id: 't-8', title: '   ' },
      'nonsense',
      { id: 't-7', title: 'duplicate id' },
      { id: 't-9', title: 'unknown status', status: 'weird' },
    ],
  })
  assert.equal(dropped, 3)
  assert.deepEqual(state.tasks.map((task) => task.id), ['t-7', 't-9'])
  assert.equal(state.tasks[1].status, 'todo')
  assert.equal(state.nextId, 10)
  assert.equal(state.config.pollIntervalMs, 20000)
})

test('addTask assigns monotonic ids and defaults', () => {
  const state = boardWith('a', 'b')
  assert.deepEqual(state.tasks.map((task) => task.id), ['t-1', 't-2'])
  const task = addTask(state, { title: '  with note  ', note: 'n', source: 'agent', sessionId: 's1' }, NOW)
  assert.equal(task.id, 't-3')
  assert.equal(task.title, 'with note')
  assert.equal(task.status, 'todo')
  assert.equal(task.source, 'agent')
  assert.equal(task.sessionId, 's1')
  assert.equal(task.notificationCount, 0)
  assert.equal(task.createdAt, new Date(NOW).toISOString())
})

test('addTask rejects empty title', () => {
  const state = createEmptyBoard()
  assert.throws(() => addTask(state, { title: '   ' }), (error) => error instanceof BoardError && error.code === 'bad-request')
  assert.throws(() => addTask(state, {}), BoardError)
})

test('state transitions follow the documented graph', () => {
  assert.equal(canTransition('todo', 'doing'), true)
  assert.equal(canTransition('todo', 'done'), false)
  assert.equal(canTransition('doing', 'done'), true)
  assert.equal(canTransition('doing', 'todo'), true)
  assert.equal(canTransition('done', 'archived'), true)
  assert.equal(canTransition('done', 'doing'), true)
  assert.equal(canTransition('archived', 'todo'), true)
  assert.equal(canTransition('archived', 'done'), false)
  for (const status of STATUSES) assert.equal(canTransition(status, status), true)
})

test('applyTaskUpdate timestamps each transition', () => {
  const state = boardWith('t')
  const started = applyTaskUpdate(state, 't-1', { status: 'doing' }, NOW)
  assert.equal(started.status, 'doing')
  assert.equal(started.startedAt, new Date(NOW).toISOString())
  const done = applyTaskUpdate(state, 't-1', { status: 'done', result: 'ok' }, NOW + 1000)
  assert.equal(done.finishedAt, new Date(NOW + 1000).toISOString())
  assert.equal(done.result, 'ok')
  assert.throws(
    () => applyTaskUpdate(state, 't-1', { status: 'weird' }),
    (error) => error instanceof BoardError && error.code === 'bad-request',
  )
  const archived = applyTaskUpdate(state, 't-1', { status: 'archived' }, NOW + 2000)
  assert.equal(archived.archivedAt, new Date(NOW + 2000).toISOString())
  assert.throws(
    () => applyTaskUpdate(state, 't-1', { status: 'done' }, NOW + 3000),
    (error) => error instanceof BoardError && error.code === 'conflict',
  )
})

test('sending a task back to todo re-arms dispatch bookkeeping', () => {
  const state = boardWith('t')
  applyTaskUpdate(state, 't-1', { status: 'doing' }, NOW)
  const task = state.tasks[0]
  task.notifiedAt = new Date(NOW).toISOString()
  task.notificationCount = 3
  task.assignee = 'child-1'
  applyTaskUpdate(state, 't-1', { status: 'todo' }, NOW + 1000)
  assert.equal(task.notifiedAt, null)
  assert.equal(task.notificationCount, 0)
  assert.equal(task.assignee, '')
  assert.equal(task.startedAt, null)
})

test('applyTaskUpdate rejects unknown id and empty title', () => {
  const state = boardWith('t')
  assert.throws(() => applyTaskUpdate(state, 't-9', {}), (error) => error.code === 'not-found')
  assert.throws(() => findTask(state, ''), (error) => error.code === 'bad-request')
  assert.throws(() => applyTaskUpdate(state, 't-1', { title: '  ' }), (error) => error.code === 'bad-request')
})

test('archiveDoneTasks only archives done tasks', () => {
  const state = boardWith('a', 'b', 'c')
  applyTaskUpdate(state, 't-1', { status: 'doing' }, NOW)
  applyTaskUpdate(state, 't-2', { status: 'doing' }, NOW)
  applyTaskUpdate(state, 't-2', { status: 'done' }, NOW)
  const archived = archiveDoneTasks(state, NOW + 5000)
  assert.equal(archived, 1)
  assert.equal(state.tasks[1].status, 'archived')
  assert.equal(state.tasks[2].status, 'todo')
})

test('deleteTask removes the task', () => {
  const state = boardWith('a', 'b')
  deleteTask(state, 't-1')
  assert.deepEqual(state.tasks.map((task) => task.id), ['t-2'])
})

test('notifyCooldownMs is bounded between 10s and 120s', () => {
  assert.equal(notifyCooldownMs({ pollIntervalMs: 5000 }), 10000)
  assert.equal(notifyCooldownMs({ pollIntervalMs: 30000 }), 60000)
  assert.equal(notifyCooldownMs({ pollIntervalMs: 300000 }), 120000)
})

test('selectDispatchCandidate honours cooldown, cap and order', () => {
  const state = boardWith('first', 'second')
  assert.equal(selectDispatchCandidate(state, NOW).id, 't-1')

  state.tasks[0].notifiedAt = new Date(NOW).toISOString()
  state.tasks[0].notificationCount = 1
  assert.equal(selectDispatchCandidate(state, NOW + 1000).id, 't-2')
  assert.equal(selectDispatchCandidate(state, NOW + 40000).id, 't-1')

  state.tasks[0].notificationCount = 5
  assert.equal(selectDispatchCandidate(state, NOW + 40000).id, 't-2')

  applyTaskUpdate(state, 't-2', { status: 'doing' }, NOW)
  assert.equal(selectDispatchCandidate(state, NOW + 40000), null)
})

test('resolveTargetAgent is fully automatic and ignores task.sessionId', () => {
  const agent = { id: 'sess-1', status: 'idle' }
  const busy = { id: 'sess-2', status: 'running' }
  const service = {
    get: () => undefined,
    roots: () => [busy, agent],
  }
  // 任务上的 sessionId 不参与路由：即使指定了别的会话，也还是挑空闲 root
  assert.equal(resolveTargetAgent(service).agent, agent)
  assert.equal(resolveTargetAgent({ get: () => undefined, roots: () => [busy] }).reason, 'agent-busy')
  assert.equal(resolveTargetAgent({ get: () => undefined, roots: () => [] }).reason, 'no-live-agent')
  assert.equal(resolveTargetAgent(undefined).reason, 'no-agents-service')
})

test('buildDispatchText carries the task facts and instructions', () => {
  const state = boardWith('把 X 改成 Y')
  const task = state.tasks[0]
  task.note = '验收：测试通过'
  task.cwd = 'C:\\work'
  const text = buildDispatchText(task, NOW)
  assert.match(text, /【任务看板 · 待开始】t-1 把 X 改成 Y/)
  assert.match(text, /验收：测试通过/)
  assert.match(text, /C:\\work/)
  assert.match(text, /taskboard_update/)
})

test('createBoardUserMessage matches the UserMessage shape', () => {
  const message = createBoardUserMessage('hi')
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.equal(message.source.kind, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }])
  assert.notEqual(createBoardUserMessage('hi').id, message.id)
})

test('parseRpcEnvelope validates shape', () => {
  const ok = parseRpcEnvelope(JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'snapshot', payload: {} }))
  assert.deepEqual(ok, { rpcId: 'r1', method: 'snapshot', payload: {} })
  assert.throws(() => parseRpcEnvelope('not json'), (error) => error.code === 'bad-request')
  assert.throws(() => parseRpcEnvelope('[]'), (error) => error.code === 'bad-request')
  assert.throws(() => parseRpcEnvelope(JSON.stringify({ type: 'server-response' })), (error) => error.code === 'bad-request')
  assert.throws(() => parseRpcEnvelope(JSON.stringify({ type: 'client-request', method: '' })), (error) => error.code === 'bad-request')
})

test('endpointFromUrl strips the channel prefix', () => {
  assert.equal(endpointFromUrl('/taskboard/snapshot'), 'snapshot')
  assert.equal(endpointFromUrl('/taskboard/add-task?x=1'), 'add-task')
  assert.equal(endpointFromUrl('/taskboard'), '')
  assert.equal(endpointFromUrl('/other/snapshot'), '')
  assert.equal(endpointFromUrl('/taskboard/a/b'), 'a')
})

test('boardPath lives under DSH_HOME storages', () => {
  const path = boardPath()
  assert.match(path.replace(/\\/g, '/'), /storages\/dsh-taskboard\/board\.json$/)
})
test('hostnameOfHostHeader strips ports and keeps IPv6 brackets', () => {
  assert.equal(hostnameOfHostHeader('127.0.0.1:3099'), '127.0.0.1')
  assert.equal(hostnameOfHostHeader('127.0.0.1.evil.com:80'), '127.0.0.1.evil.com')
  assert.equal(hostnameOfHostHeader('localhost'), 'localhost')
  assert.equal(hostnameOfHostHeader('[::1]:3099'), '[::1]')
  assert.equal(hostnameOfHostHeader(''), '')
})

test('isLoopbackRequest trusts the socket address, never the Host header', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' }, headers: {} }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} }), true)
  // Host 头伪装不能放行非本机连接
  assert.equal(
    isLoopbackRequest({ socket: { remoteAddress: '10.0.0.5' }, headers: { host: '127.0.0.1:3099' } }),
    false,
  )
  assert.equal(
    isLoopbackRequest({ socket: { remoteAddress: '10.0.0.5' }, headers: { host: 'localhost' } }),
    false,
  )
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.5' } }), false)
  assert.equal(isLoopbackRequest({}), false)
})

test('inspectPresets reports missing registry, healthy roster and broken preset', async () => {
  const missing = await inspectPresets({ get: () => undefined })
  assert.equal(missing.installed, false)
  assert.match(missing.reason, /agentPresets/)

  const healthy = await inspectPresets({
    get: (name) =>
      name === 'agentPresets'
        ? {
            list: async () => [
              { id: 'standard', name: 'Standard' },
              { id: 'taskboard-dispatch', name: '任务看板 · 工作区组长（自动）', description: 'x' },
              { id: 'taskboard-worker', name: '执行者' },
            ],
          }
        : undefined,
  })
  assert.equal(healthy.installed, true)
  assert.equal(healthy.broken, '')
  assert.equal(healthy.presets.length, 2)
  assert.equal(healthy.presets[0].name, '任务看板 · 工作区组长（自动）')
  assert.match(healthy.path, /presets\/taskboard\.patch\.yml/)

  const broken = await inspectPresets({
    get: (name) =>
      name === 'agentPresets'
        ? { list: async () => [{ id: 'taskboard-dispatch', broken: 'row persona: boom' }] }
        : undefined,
  })
  assert.equal(broken.installed, false)
  assert.equal(broken.broken, 'row persona: boom')

  const failing = await inspectPresets({
    get: (name) => (name === 'agentPresets' ? { list: async () => { throw new Error('nope') } } : undefined),
  })
  assert.equal(failing.installed, false)
  assert.match(failing.reason, /nope/)
})

test('buildSnapshot exposes board, poll, agents and preset status', () => {
  const state = createEmptyBoard()
  addTask(state, { title: 'a' }, NOW)
  const rt = {
    ctx: { get: () => undefined },
    state,
    filePath: 'C:\\tmp\\board.json',
    poll: { running: true, lastRunAt: null, lastDispatchAt: null, lastDispatchSessionId: null, lastSkipReason: null },
    presetInfo: { installed: true, version: '0.1.0', path: 'bundle:presets/taskboard.patch.yml', restartRequired: false, broken: '', presets: [] },
  }
  const snapshot = buildSnapshot(rt, NOW)
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.tasks.length, 1)
  assert.equal(snapshot.tasks[0].title, 'a')
  assert.equal(snapshot.poll.running, true)
  assert.deepEqual(snapshot.agents, [])
  assert.equal(snapshot.preset.installed, true)
  assert.equal(snapshot.boardPath, rt.filePath)
  assert.equal(snapshot.pluginVersion.length > 0, true)
  assert.equal(snapshot.now, new Date(NOW).toISOString())
})
test('status changes clear a stale dispatch error', () => {
  const state = boardWith('t')
  const task = state.tasks[0]
  task.lastError = '目标会话正在运行，稍后再派'
  applyTaskUpdate(state, 't-1', { status: 'doing' }, NOW)
  assert.equal(task.lastError, '')
  task.lastError = 'again'
  applyTaskUpdate(state, 't-1', { status: 'done' }, NOW + 1000)
  assert.equal(task.lastError, '')
  task.lastError = 'keep me'
  applyTaskUpdate(state, 't-1', { result: 'note only' }, NOW + 2000)
  assert.equal(task.lastError, 'keep me')
})
test('resolveTargetAgent prefers an idle dispatcher-mode session', () => {
  const standard = { id: 's-standard', status: 'idle', session: { header: {} } }
  const dispatcher = {
    id: 's-dispatch',
    status: 'idle',
    session: { header: { agentPreset: 'taskboard-dispatch' } },
  }
  const busyDispatcher = {
    id: 's-dispatch-busy',
    status: 'running',
    session: { header: { agentPreset: 'taskboard-dispatch' } },
  }
  const service = {
    get: () => undefined,
    roots: () => [standard, busyDispatcher, dispatcher],
  }
  const resolved = resolveTargetAgent(service)
  assert.equal(resolved.agent, dispatcher)
  assert.equal(resolved.reason, 'dispatcher-root')

  // 没有派单模式会话时才退化到任意空闲 root
  const fallback = resolveTargetAgent({ get: () => undefined, roots: () => [standard, busyDispatcher] })
  assert.equal(fallback.agent, standard)
  assert.equal(fallback.reason, 'recent-root')
})
test('resolveTargetAgent routes a task back to its creating conversation', () => {
  const creator = { id: 'creator', status: 'idle' }
  const other = { id: 'other', status: 'idle' }

  const resolved = resolveTargetAgent({ get: (id) => (id === 'creator' ? creator : undefined), roots: () => [other] }, { sessionId: 'creator' })
  assert.equal(resolved.agent, creator)
  assert.equal(resolved.reason, 'creator-session')

  // 创建它的对话正在跑：等它空下来，不改派别的会话
  const busyCreator = { id: 'creator', status: 'running' }
  const waiting = resolveTargetAgent({ get: () => busyCreator, roots: () => [other] }, { sessionId: 'creator' })
  assert.equal(waiting.agent, null)
  assert.equal(waiting.reason, 'creator-busy')

  // 创建它的对话不在线：默认等它（不乱派到别的工作区），手动「立即派发」才退化
  const waitingCold = resolveTargetAgent({ get: () => undefined, roots: () => [other] }, { sessionId: 'creator' })
  assert.equal(waitingCold.agent, null)
  assert.equal(waitingCold.reason, 'creator-cold')
  const forced = resolveTargetAgent({ get: () => undefined, roots: () => [other] }, { sessionId: 'creator' }, () => '', { force: true })
  assert.equal(forced.agent, other)
  assert.equal(forced.reason, 'recent-root')

  // 没有创建会话信息的任务走原来的自动挑法
  assert.equal(resolveTargetAgent({ get: () => undefined, roots: () => [other] }, {}).agent, other)
})

test('resolveSessionCwd reads the live agent or the live session header', () => {
  const header = { cwd: 'C:\\work\\demo' }
  assert.equal(
    resolveSessionCwd({ get: (name) => (name === 'agents' ? { get: () => ({ session: { header } }) } : undefined) }, 's1'),
    'C:\\work\\demo',
  )
  assert.equal(
    resolveSessionCwd({ get: (name) => (name === 'sessions' ? { get: () => ({ header }) } : undefined) }, 's1'),
    'C:\\work\\demo',
  )
  assert.equal(resolveSessionCwd({ get: () => undefined }, 's1'), null)
  assert.equal(resolveSessionCwd({ get: () => undefined }, ''), null)
  assert.equal(resolveSessionCwd(undefined, 's1'), null)
})
test('tick dispatches around a busy creator instead of being blocked by it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-tick-'))
  try {
    const state = createEmptyBoard()
    // 兼容模式单测：显式指定 creator，旧的「回创建对话」路由按 §1.7 仍然生效。
    state.config = normalizeConfig({ pollEnabled: true, dispatchMode: 'creator' })
    const busyTask = addTask(state, { title: 'busy creator task', sessionId: 'creator-busy' }, NOW)
    const idleTask = addTask(state, { title: 'idle task' }, NOW + 1)

    const delivered = []
    const idleAgent = {
      id: 'agent-idle',
      status: 'idle',
      session: { id: 'agent-idle', header: { cwd: 'C:\\work' } },
      followup: (message) => delivered.push(message),
    }
    const busyAgent = {
      id: 'creator-busy',
      status: 'running',
      session: { id: 'creator-busy', header: {} },
      followup: () => {
        throw new Error('must not dispatch to a running creator')
      },
    }
    const agents = {
      get: (id) => (id === 'creator-busy' ? busyAgent : undefined),
      roots: () => [idleAgent],
    }
    const rt = {
      ctx: { get: (name) => (name === 'agents' ? agents : undefined) },
      state,
      filePath: join(dir, 'board.json'),
      poll: { running: true, lastRunAt: null, lastDispatchAt: null, lastDispatchSessionId: null, lastSkipReason: null },
      timer: null,
      polling: false,
    }

    const result = await tick(rt, {})
    assert.equal(result.dispatched, true)
    assert.equal(result.task.id, idleTask.id)
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].content[0].text, /idle task/)
    // 创建者忙的那条：不派，但留下可读原因，且通知次数不增加
    assert.match(busyTask.lastError, /创建这条任务的对话正在运行/)
    assert.equal(busyTask.notificationCount, 0)
    assert.equal(idleTask.notificationCount, 1)
    // 创建时没有 cwd 的任务，投递前从目标会话补上工作区
    assert.equal(idleTask.cwd, 'C:\\work')
    // 投递成功即自动置 doing：看板马上显示「进行中」，不依赖主 Agent 记得调 taskboard_update
    assert.equal(idleTask.status, 'doing')
    assert.ok(idleTask.startedAt)
    assert.equal(busyTask.status, 'todo')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('resolveSessionCwdViaQuery finds a cold session cwd from sessionQuery', async () => {
  const query = {
    listSessions: async () => [
      { header: { id: 's-cold', cwd: 'C:\\old\\place' } },
      { header: { id: 's-other', cwd: 'C:\\other' } },
    ],
  }
  assert.equal(await resolveSessionCwdViaQuery({ get: (name) => (name === 'sessionQuery' ? query : undefined) }, 's-cold'), 'C:\\old\\place')
  assert.equal(await resolveSessionCwdViaQuery({ get: () => query && query }, 'missing'), null)
  assert.equal(await resolveSessionCwdViaQuery({ get: () => undefined }, 's-cold'), null)
  assert.equal(await resolveSessionCwdViaQuery({ get: () => ({ listSessions: async () => { throw new Error('boom') } }) }, 's-cold'), null)
  assert.equal(await resolveSessionCwdViaQuery(undefined, 's-cold'), null)
})
test('tick revives a cold creator session so the task goes back to that conversation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-revive-'))
  try {
    const state = createEmptyBoard()
    // 兼容模式单测：显式指定 creator（默认 workspace-lead 走组长路由，见后面的新用例）。
    state.config = normalizeConfig({ pollEnabled: true, dispatchMode: 'creator' })
    const creatorId = 'session-cold'
    addTask(state, { title: 'cold task', sessionId: creatorId }, NOW)

    const delivered = []
    let live
    const revived = {
      id: creatorId,
      status: 'idle',
      session: { id: creatorId, header: { cwd: 'C:\\cold\\ws' } },
      followup: (message) => delivered.push(message),
    }
    const agents = {
      get: (id) => (id === creatorId ? live : undefined),
      roots: () => (live ? [live] : []),
    }
    let resolveCalls = 0
    const controller = {
      resolveAgent: async (id) => {
        resolveCalls += 1
        if (id !== creatorId) return { error: { code: 'session/not-found' } }
        live = revived
        return { agent: revived }
      },
    }
    const rt = {
      ctx: {
        get: (name) => (name === 'agents' ? agents : name === 'sessionController' ? controller : undefined),
      },
      state,
      filePath: join(dir, 'board.json'),
      poll: { running: true, lastRunAt: null, lastDispatchAt: null, lastDispatchSessionId: null, lastSkipReason: null },
      reviveFailures: new Map(),
    }

    const result = await tick(rt, {})
    assert.equal(result.dispatched, true)
    assert.equal(result.sessionId, creatorId)
    assert.equal(resolveCalls, 1)
    assert.equal(delivered.length, 1)
    // 唤醒后补上目标会话的工作区
    assert.equal(state.tasks[0].cwd, 'C:\\cold\\ws')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tick caches a failed revive and falls back instead of retrying every tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-revive-fail-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ pollEnabled: true, dispatchMode: 'creator' })
    addTask(state, { title: 'cold task', sessionId: 'session-gone' }, NOW)
    const fallback = { id: 'idle-agent', status: 'idle', session: { id: 'idle-agent', header: {} }, followup: () => {} }
    const agents = { get: () => undefined, roots: () => [fallback] }
    let resolveCalls = 0
    const controller = {
      resolveAgent: async () => {
        resolveCalls += 1
        return { error: { code: 'session/not-found' } }
      },
    }
    const rt = {
      ctx: {
        get: (name) => (name === 'agents' ? agents : name === 'sessionController' ? controller : undefined),
      },
      state,
      filePath: join(dir, 'board.json'),
      poll: { running: true, lastRunAt: null, lastDispatchAt: null, lastDispatchSessionId: null, lastSkipReason: null },
      reviveFailures: new Map(),
    }

    // 第一次：唤醒失败 → 不派到别的工作区，留在 todo 并给出原因
    const first = await tick(rt, {})
    assert.equal(first.dispatched, false)
    assert.equal(first.reason, 'creator-cold')
    assert.equal(resolveCalls, 1)
    assert.match(state.tasks[0].lastError, /还没激活/)

    // 第二次 tick 仍在负缓存窗口内：不再重复唤醒
    const second = await tick(rt, {})
    assert.equal(second.dispatched, false)
    assert.equal(resolveCalls, 1)

    // 手动「立即派发」（force）才退化到空闲会话
    const forced = await tick(rt, { taskId: state.tasks[0].id, force: true })
    assert.equal(forced.dispatched, true)
    assert.equal(forced.sessionId, 'idle-agent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('listWorkspaces reads the workspace registry and normalizes titles', () => {
  const registry = {
    list: () => [
      { id: 'w1', path: 'C:\\work\\plinto', title: 'plinto', status: 'ok' },
      { id: 'w2', path: 'C:\\work\\whart', title: '', status: 'missing' },
    ],
  }
  const rows = listWorkspaces({ ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) } })
  assert.deepEqual(rows, [
    { id: 'w1', path: 'C:\\work\\plinto', title: 'plinto', status: 'ok' },
    { id: 'w2', path: 'C:\\work\\whart', title: 'whart', status: 'missing' },
  ])
  assert.deepEqual(listWorkspaces({ ctx: { get: () => undefined } }), [])
  assert.deepEqual(listWorkspaces(undefined), [])
})

test('normalizePathForCompare ignores separators, trailing slashes and Windows case', () => {
  assert.equal(normalizePathForCompare('C:\\Work\\Demo/'), normalizePathForCompare('c:\\work\\demo'))
  assert.equal(normalizePathForCompare(''), '')
})

test('resolveTargetAgent prefers an idle session in the task workspace', () => {
  const inWorkspace = { id: 's-in', status: 'idle', session: { header: { cwd: 'C:\\work\\demo' } } }
  const elsewhere = { id: 's-out', status: 'idle', session: { header: { cwd: 'C:\\work\\other' } } }
  const dispatcher = { id: 's-dispatch', status: 'idle', session: { header: { cwd: 'C:\\work\\other', agentPreset: 'taskboard-dispatch' } } }
  const service = { get: () => undefined, roots: () => [elsewhere, dispatcher, inWorkspace] }
  const presetOf = (agent) => (agent.session.header.agentPreset ? 'taskboard-dispatch' : 'standard')

  // 平台看板任务：优先同工作区（即使别的闲置会话是派单模式）
  const hit = resolveTargetAgent(service, { id: 't-1', cwd: 'C:\\Work\\Demo\\' }, presetOf)
  assert.equal(hit.agent, inWorkspace)
  assert.equal(hit.reason, 'workspace-session')

  // 该工作区没有空闲会话 → 等，不改派
  const noIdle = resolveTargetAgent(
    { get: () => undefined, roots: () => [elsewhere, dispatcher] },
    { id: 't-2', cwd: 'C:\\work\\demo' },
    presetOf,
  )
  assert.equal(noIdle.agent, null)
  assert.equal(noIdle.reason, 'workspace-offline')

  // 该工作区有会话在跑 → workspace-busy
  const busy = { id: 's-busy', status: 'running', session: { header: { cwd: 'C:\\work\\demo' } } }
  const waitBusy = resolveTargetAgent({ get: () => undefined, roots: () => [busy] }, { cwd: 'C:\\work\\demo' }, presetOf)
  assert.equal(waitBusy.reason, 'workspace-busy')

  // force（立即派发）才退到派单模式/任意空闲会话
  const forced = resolveTargetAgent(
    { get: () => undefined, roots: () => [elsewhere, dispatcher] },
    { cwd: 'C:\\work\\demo' },
    presetOf,
    { force: true },
  )
  assert.equal(forced.agent, dispatcher)
  assert.equal(forced.reason, 'dispatcher-root')
})

test('snapshot exposes the workspace list', () => {
  const registry = { list: () => [{ id: 'w1', path: 'C:\\work\\demo', title: 'demo', status: 'ok' }] }
  const rt = {
    ctx: { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) },
    state: createEmptyBoard(),
    filePath: 'C:\\tmp\\board.json',
    poll: { running: true },
    presetInfo: null,
  }
  const snapshot = buildSnapshot(rt)
  assert.equal(snapshot.workspaces.length, 1)
  assert.equal(snapshot.workspaces[0].title, 'demo')
})
test('reloadBoardIfStale adopts a newer board written by another process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-stale-'))
  try {
    const filePath = join(dir, 'board.json')
    const diskState = createEmptyBoard()
    addTask(diskState, { title: 'written by another process' }, NOW)
    commitBoard(diskState, filePath)
    const diskRevision = diskState.revision

    const rt = { state: createEmptyBoard(), filePath }
    assert.equal(reloadBoardIfStale(rt), true, 'must reload when disk revision is newer')
    assert.equal(rt.state.revision, diskRevision)
    assert.equal(rt.state.tasks[0].title, 'written by another process')

    // 盘上没有更新 → 不重载
    assert.equal(reloadBoardIfStale(rt), false)
    // 内存比盘新（本地刚改还没写盘）→ 不重载，别把自己的改动冲掉
    rt.state.revision = diskRevision + 3
    assert.equal(reloadBoardIfStale(rt), false)
    assert.equal(rt.state.revision, diskRevision + 3)
    // 文件不存在 → 不重载
    assert.equal(reloadBoardIfStale({ state: createEmptyBoard(), filePath: join(dir, 'nope.json') }), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boardPath honors DSH_TASKBOARD_PATH so test instances do not share the real board', () => {
  const previous = process.env.DSH_TASKBOARD_PATH
  try {
    process.env.DSH_TASKBOARD_PATH = 'C:\\tmp\\isolated-board.json'
    assert.equal(boardPath(), 'C:\\tmp\\isolated-board.json')
    delete process.env.DSH_TASKBOARD_PATH
    assert.match(boardPath(), /board\.json$/)
  } finally {
    if (previous === undefined) delete process.env.DSH_TASKBOARD_PATH
    else process.env.DSH_TASKBOARD_PATH = previous
  }
})
test('normalizeConfig defaults dispatchMode to workspace-lead and validates values', () => {
  // v0.2.0：默认派发去处改为工作区组长；已持久化的合法旧值原样保留。
  assert.equal(normalizeConfig({}).dispatchMode, 'workspace-lead')
  assert.equal(normalizeConfig({ dispatchMode: 'workspace-lead' }).dispatchMode, 'workspace-lead')
  assert.equal(normalizeConfig({ dispatchMode: 'new' }).dispatchMode, 'new')
  assert.equal(normalizeConfig({ dispatchMode: 'creator' }).dispatchMode, 'creator')
  assert.equal(normalizeConfig({ dispatchMode: 'auto' }).dispatchMode, 'auto')
  assert.equal(normalizeConfig({ dispatchMode: 'bogus' }).dispatchMode, 'workspace-lead')
})

test('tick in new mode creates a fresh dispatcher conversation for the task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-newmode-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ pollEnabled: true, dispatchMode: 'new' })
    const task = addTask(state, { title: 'new mode task', cwd: 'C:\\work\\demo' }, NOW)

    const delivered = []
    const createdAgent = {
      id: 'session-created',
      status: 'idle',
      session: { id: 'session-created', header: { cwd: 'C:\\work\\demo' } },
      followup: (message) => delivered.push(message),
    }
    const createCalls = []
    const controller = {
      create: async (request) => {
        createCalls.push(request)
        return { sessionId: 'session-created', agentPreset: 'taskboard-dispatch' }
      },
      resolveAgent: async () => ({ agent: createdAgent }),
    }
    const agents = { get: (id) => (id === 'session-created' ? createdAgent : undefined), roots: () => [] }
    const rt = {
      ctx: { get: (name) => (name === 'agents' ? agents : name === 'sessionController' ? controller : undefined) },
      state,
      filePath: join(dir, 'board.json'),
      poll: { running: true, lastRunAt: null, lastDispatchAt: null, lastDispatchSessionId: null, lastSkipReason: null },
      reviveFailures: new Map(),
    }

    const result = await tick(rt, {})
    assert.equal(result.dispatched, true)
    assert.equal(result.sessionId, 'session-created')
    assert.equal(createCalls.length, 1)
    assert.equal(createCalls[0].cwd, 'C:\\work\\demo')
    assert.equal(createCalls[0].agentPreset, 'taskboard-dispatch')
    assert.equal(delivered.length, 1)
    assert.equal(task.status, 'doing')
    assert.equal(task.dispatchedSessionId, 'session-created')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tick in creator mode never creates a new conversation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-creatormode-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ pollEnabled: true, dispatchMode: 'creator' })
    addTask(state, { title: 'creator mode task', sessionId: 'creator-1' }, NOW)
    const delivered = []
    const creator = {
      id: 'creator-1',
      status: 'idle',
      session: { id: 'creator-1', header: {} },
      followup: (message) => delivered.push(message),
    }
    let createCalls = 0
    const controller = { create: async () => { createCalls += 1; return { sessionId: 'x' } } }
    const agents = { get: (id) => (id === 'creator-1' ? creator : undefined), roots: () => [creator] }
    const rt = {
      ctx: { get: (name) => (name === 'agents' ? agents : name === 'sessionController' ? controller : undefined) },
      state,
      filePath: join(dir, 'board.json'),
      poll: { running: true, lastRunAt: null, lastDispatchAt: null, lastDispatchSessionId: null, lastSkipReason: null },
      reviveFailures: new Map(),
    }
    const result = await tick(rt, {})
    assert.equal(result.dispatched, true)
    assert.equal(result.sessionId, 'creator-1')
    assert.equal(createCalls, 0)
    assert.equal(delivered.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('workspaceIdForCwd matches paths with separators and case differences', () => {
  const registry = {
    list: () => [
      { id: 'w-demo', path: 'C:\\Work\\Demo' },
      { id: 'w-other', path: 'C:\\Work\\Other' },
    ],
  }
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  assert.equal(workspaceIdForCwd(ctx, 'c:/work/demo/'), 'w-demo')
  assert.equal(workspaceIdForCwd(ctx, 'C:\\Work\\Other'), 'w-other')
  assert.equal(workspaceIdForCwd(ctx, 'C:\\nowhere'), '')
  assert.equal(workspaceIdForCwd(ctx, ''), '')
  assert.equal(workspaceIdForCwd({ get: () => undefined }, 'C:\\Work\\Demo'), '')
})

test('new dispatch mode creates the conversation inside the task workspace group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-ws-create-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ pollEnabled: true, dispatchMode: 'new' })
    addTask(state, { title: 'workspace grouped task', cwd: 'c:/work/demo/' }, NOW)

    const createCalls = []
    const createdAgent = {
      id: 'session-in-workspace',
      status: 'idle',
      session: { id: 'session-in-workspace', header: { cwd: 'C:\\Work\\Demo' } },
      followup: () => {},
    }
    const controller = { create: async (request) => { createCalls.push(request); return { sessionId: 'session-in-workspace' } } }
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\Work\\Demo' }] }
    const agents = { get: (id) => (id === 'session-in-workspace' ? createdAgent : undefined), roots: () => [] }
    const rt = {
      ctx: {
        get: (name) =>
          name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
      },
      state,
      filePath: join(dir, 'board.json'),
      poll: { running: true, lastRunAt: null, lastDispatchAt: null, lastDispatchSessionId: null, lastSkipReason: null },
      reviveFailures: new Map(),
    }

    const result = await tick(rt, {})
    assert.equal(result.dispatched, true)
    assert.equal(createCalls.length, 1)
    assert.equal(createCalls[0].workspaceId, 'w-demo')
    assert.equal(createCalls[0].cwd, undefined)
    assert.equal(result.sessionId, 'session-in-workspace')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('taskBrief output stays inside the closed tool output schemas', () => {
  // 回归：0.1.2 的 taskBrief 返回了 UI 专用的 dispatchedSessionId，但它不在
  // TASK_LIST_OUTPUT_SCHEMA / TASK_ONE_OUTPUT_SCHEMA（additionalProperties:false）里。
  // dsh 在 execute() 成功返回之后才校验 canonical output，于是看板写入已生效、三个工具却全部报
  // INVALID_TOOL_OUTPUT。这里用「带全部 UI/snapshot 字段的完整任务」喂 taskBrief：
  // 任何未声明字段漏进工具输出都必须让本测试失败。
  const fullTask = {
    id: 't-42',
    title: '修复工具输出契约',
    status: 'doing',
    note: '验收：测试通过',
    assignee: 'fixer',
    result: '进行中',
    updatedAt: new Date(NOW).toISOString(),
    // 以下字段只属于 board.json / buildSnapshot()，不得进入工具输出
    dispatchedSessionId: 'session-42',
    sessionId: 'session-42',
    cwd: 'C:\\work\\demo',
    source: 'agent',
    workspaceId: 'w-demo',
    createdAt: new Date(NOW - 1000).toISOString(),
    startedAt: new Date(NOW - 500).toISOString(),
    finishedAt: null,
    archivedAt: null,
    notifiedAt: new Date(NOW).toISOString(),
    notificationCount: 2,
    reportedAt: new Date(NOW).toISOString(),
    lastError: 'keep me',
  }

  const brief = taskBrief(fullTask)
  const declared = TASK_ONE_OUTPUT_SCHEMA.properties.task.properties

  // 键集合 ⊆ schema 声明的 properties；旧代码会在这里挂（dispatchedSessionId 未声明）
  assert.deepEqual(Object.keys(brief).sort(), ['assignee', 'id', 'note', 'result', 'status', 'title', 'updatedAt'])
  for (const key of Object.keys(brief)) {
    assert.ok(Object.prototype.hasOwnProperty.call(declared, key), 'taskBrief 返回了 schema 未声明的字段：' + key)
  }
  assert.equal('dispatchedSessionId' in brief, false, 'taskBrief 不得返回 UI 专用的 dispatchedSessionId')
  assert.equal('reportedAt' in brief, false, 'taskBrief 不得返回完成回执记账字段 reportedAt')

  // 单任务输出（taskboard_add / taskboard_update）与列表输出（taskboard_list，含 items）
  assert.deepEqual(schemaProblems({ task: brief }, TASK_ONE_OUTPUT_SCHEMA), [])
  assert.deepEqual(schemaProblems({ count: 1, tasks: [brief] }, TASK_LIST_OUTPUT_SCHEMA), [])
  assert.deepEqual(schemaProblems({ count: 0, tasks: [] }, TASK_LIST_OUTPUT_SCHEMA), [])

  // 反向自检：校验器必须真的能抓到未声明字段，否则上面的断言会退化成 no-op
  const leaked = { ...brief, dispatchedSessionId: 'session-42' }
  assert.deepEqual(schemaProblems({ task: leaked }, TASK_ONE_OUTPUT_SCHEMA), [
    'value.task.dispatchedSessionId 未在 schema 声明（additionalProperties:false）',
  ])
  assert.deepEqual(schemaProblems({ count: 1, tasks: [leaked] }, TASK_LIST_OUTPUT_SCHEMA), [
    'value.tasks[0].dispatchedSessionId 未在 schema 声明（additionalProperties:false）',
  ])
})


/* ------------------------------------------------------------------ *
 * v0.2.0：工作区组长路由 / 完成回执 / 新 config 字段（纯函数）
 * ------------------------------------------------------------------ */

test('normalizeConfig carries the v0.2.0 main-session and workspace-lead fields', () => {
  assert.equal(DEFAULT_DISPATCH_MODE, 'workspace-lead')
  assert.deepEqual(DISPATCH_MODES, ['workspace-lead', 'new', 'creator', 'auto'])

  const config = normalizeConfig({
    mainSessionId: '  main-1  ',
    mainSessionTitle: ' ' + 'M'.repeat(240),
    workspaceLeads: {
      'w-demo': {
        sessionId: ' s-1 ',
        title: '  demo  ',
        cwd: ' C:\\work\\demo ',
        createdAt: '2026-11-11T02:00:00.000Z',
      },
      'broken-no-session': { title: 'x', cwd: 'C:\\x' },
      'broken-no-cwd': { sessionId: 's-2', cwd: '   ' },
      'broken-not-object': 'nope',
    },
  })
  assert.equal(config.mainSessionId, 'main-1')
  assert.equal(config.mainSessionTitle.length, 200)
  assert.deepEqual(config.workspaceLeads, {
    'w-demo': {
      sessionId: 's-1',
      title: 'demo',
      cwd: 'C:\\work\\demo',
      createdAt: '2026-11-11T02:00:00.000Z',
    },
  })
  assert.equal(normalizeConfig({}).mainSessionId, null)
  assert.equal(normalizeConfig({ mainSessionId: '   ' }).mainSessionId, null)
  assert.equal(normalizeConfig({ mainSessionTitle: 42 }).mainSessionTitle, '')
  assert.equal(normalizeConfig({ pollEnabled: false, dispatchMode: 'new' }).dispatchMode, 'new')
  assert.equal(normalizeConfig({ dispatchMode: 'bogus' }).dispatchMode, DEFAULT_DISPATCH_MODE)
})

test('normalizeWorkspaceLeads drops invalid entries and caps at 32', () => {
  const raw = {}
  for (let i = 0; i < 40; i += 1) raw['w' + i] = { sessionId: 's' + i, cwd: 'C:\\work\\' + i }
  const leads = normalizeWorkspaceLeads(raw)
  assert.equal(Object.keys(leads).length, 32)
  assert.equal(Object.keys(leads)[0], 'w0')
  assert.equal(Object.keys(leads)[31], 'w31')
  assert.deepEqual(normalizeWorkspaceLeads(null), {})
  assert.deepEqual(normalizeWorkspaceLeads([1, 2]), {})
  assert.deepEqual(
    normalizeWorkspaceLeads({
      'no-session': { sessionId: '', cwd: 'C:\\x' },
      'no-cwd': { sessionId: 's', cwd: '   ' },
      'not-an-object': 'x',
    }),
    {},
  )
  assert.deepEqual(normalizeWorkspaceLeads({ one: { sessionId: 's', cwd: 'C:\\x' } }), {
    one: { sessionId: 's', title: '', cwd: 'C:\\x', createdAt: '' },
  })
})

test('putWorkspaceLead keeps a newly created mapping at the 32-entry cap', () => {
  const leads = {}
  for (let i = 0; i < 32; i += 1) leads['w' + i] = { sessionId: 's' + i, title: '', cwd: 'C:\\work\\' + i, createdAt: '' }
  const next = putWorkspaceLead(leads, 'w-new', { sessionId: 's-new', title: '', cwd: 'C:\\work\\new', createdAt: '' })
  assert.equal(Object.keys(next).length, 32)
  assert.equal(next['w-new'].sessionId, 's-new')
  assert.equal('w31' in next, false)
  const updated = putWorkspaceLead(next, 'w-new', { sessionId: 's-new2', title: '', cwd: 'C:\\work\\new', createdAt: '' })
  assert.equal(Object.keys(updated).length, 32)
  assert.equal(updated['w-new'].sessionId, 's-new2')
})

test('workspaceKeyForCwd prefers the registry id and falls back to normalized cwd', () => {
  const registry = { list: () => [{ id: 'w-demo', path: 'C:\\Work\\Demo' }] }
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  assert.equal(workspaceKeyForCwd(ctx, 'c:/work/demo/'), 'w-demo')
  assert.equal(workspaceKeyForCwd(ctx, 'C:\\Work\\Other'), 'c:\\work\\other')
  assert.equal(workspaceKeyForCwd({ get: () => undefined }, 'C:\\Work\\Other'), 'c:\\work\\other')
  assert.equal(workspaceKeyForCwd(ctx, ''), '')
})

test('selectWorkspaceLead reads valid mappings and ignores broken ones', () => {
  const mapping = { sessionId: 's1', title: 'demo', cwd: 'C:\\work', createdAt: 'x' }
  const config = normalizeConfig({ workspaceLeads: { w1: mapping } })
  assert.deepEqual(selectWorkspaceLead(config, 'w1'), mapping)
  assert.equal(selectWorkspaceLead(config, 'missing'), null)
  assert.equal(selectWorkspaceLead({}, 'w1'), null)
  assert.equal(selectWorkspaceLead(null, 'w1'), null)
  assert.deepEqual(selectWorkspaceLead({ w1: mapping }, 'w1'), mapping)
  assert.equal(selectWorkspaceLead({ w1: { sessionId: '', cwd: 'C:\\x' } }, 'w1'), null)
})

test('resolveWorkspaceTarget accepts id, title, path and absolute paths', () => {
  const rows = [
    { id: 'w-demo', path: 'C:\\Work\\Demo', title: 'Demo' },
    { id: 'w-other', path: 'C:\\Work\\Other', title: '其他' },
  ]
  assert.equal(resolveWorkspaceTarget('w-demo', rows), 'C:\\Work\\Demo')
  assert.equal(resolveWorkspaceTarget('demo', rows), 'C:\\Work\\Demo')
  assert.equal(resolveWorkspaceTarget(' 其他 ', rows), 'C:\\Work\\Other')
  // 绝对路径按 §4.4 第 2 条直接放行，不查注册表（所以 c:/work/demo/ 原样返回）
  assert.equal(resolveWorkspaceTarget('c:/work/demo/', rows), 'c:/work/demo/')
  assert.equal(resolveWorkspaceTarget('C:\\absolute\\place', rows), 'C:\\absolute\\place')
  // 非绝对字符串的第三个匹配分支：path 归一化比较
  assert.equal(resolveWorkspaceTarget('relative/demo', [{ id: 'r', path: 'relative/demo', title: '' }]), 'relative/demo')
  assert.equal(resolveWorkspaceTarget('/tmp/place', rows), '/tmp/place')
  assert.equal(resolveWorkspaceTarget('unknown', rows), '')
  assert.equal(resolveWorkspaceTarget('', rows), '')
  assert.equal(resolveWorkspaceTarget('unknown', undefined), '')
  assert.equal(isAbsoluteWorkspacePath('C:/x'), true)
  assert.equal(isAbsoluteWorkspacePath('/tmp/x'), true)
  assert.equal(isAbsoluteWorkspacePath('demo'), false)
})

test('buildReceiptText flattens results and asks the main session to report', () => {
  const text = buildReceiptText(
    [
      { id: 't-1', title: 'A', result: '## 结论\n\n- 改了 X\n- 测了 Y' },
      { id: 't-2', title: 'B', result: '' },
    ],
    NOW,
  )
  assert.match(text, /^【任务看板 · 汇报】/)
  assert.match(text, /- t-1 A：## 结论 - 改了 X - 测了 Y/)
  assert.match(text, /- t-2 B：（无结论）/)
  assert.match(text, /向用户汇总以上结论，不要重复执行任务/)
  assert.ok(text.includes('看板时间：' + new Date(NOW).toISOString()))
  const long = buildReceiptText([{ id: 't-3', title: 'C', result: 'x'.repeat(500) }], NOW)
  assert.ok(long.includes('x'.repeat(200)))
  assert.equal(long.includes('x'.repeat(201)), false)
  assert.equal(flattenResultLine('a\n\nb\t c'), 'a b c')
  assert.equal(flattenResultLine(undefined), '')
})

test('selectReceiptTasks picks unreported done tasks in updatedAt order and caps at 10', () => {
  const state = createEmptyBoard()
  for (let i = 0; i < 12; i += 1) {
    const task = addTask(state, { title: 'done-' + i }, NOW + i)
    applyTaskUpdate(state, task.id, { status: 'doing' }, NOW + 100 + i)
    applyTaskUpdate(state, task.id, { status: 'done', result: 'r' + i }, NOW + 200 + i * 10)
  }
  const reported = addTask(state, { title: 'already reported' }, NOW + 500)
  applyTaskUpdate(state, reported.id, { status: 'doing' }, NOW + 501)
  applyTaskUpdate(state, reported.id, { status: 'done' }, NOW + 502)
  reported.reportedAt = new Date(NOW + 503).toISOString()
  const doing = addTask(state, { title: 'doing' }, NOW + 600)
  applyTaskUpdate(state, doing.id, { status: 'doing' }, NOW + 601)

  const selected = selectReceiptTasks(state)
  assert.equal(selected.length, 10)
  assert.deepEqual(
    selected.map((task) => task.id),
    ['t-1', 't-2', 't-3', 't-4', 't-5', 't-6', 't-7', 't-8', 't-9', 't-10'],
  )
  assert.deepEqual(selectReceiptTasks(state, 2).map((task) => task.id), ['t-1', 't-2'])
  assert.equal(selectReceiptTasks(state).some((task) => task.id === reported.id), false)
  assert.equal(selectReceiptTasks(state).some((task) => task.id === doing.id), false)
})

test('reportedAt reset rules follow the completion-receipt contract', () => {
  const state = boardWith('t')
  const task = state.tasks[0]
  applyTaskUpdate(state, 't-1', { status: 'doing' }, NOW)
  applyTaskUpdate(state, 't-1', { status: 'done' }, NOW + 1)
  assert.equal(task.reportedAt, null, '新的完成默认未汇报')

  task.reportedAt = new Date(NOW + 2).toISOString()
  applyTaskUpdate(state, 't-1', { status: 'archived' }, NOW + 3)
  assert.equal(task.reportedAt, new Date(NOW + 2).toISOString(), 'done→archived 不改 reportedAt')

  applyTaskUpdate(state, 't-1', { status: 'todo' }, NOW + 4)
  assert.equal(task.reportedAt, null, '离开 done 重新置空')

  applyTaskUpdate(state, 't-1', { status: 'doing' }, NOW + 5)
  task.reportedAt = new Date(NOW + 6).toISOString()
  applyTaskUpdate(state, 't-1', { status: 'done' }, NOW + 7)
  assert.equal(task.reportedAt, null, '再次 done 重新生成回执')
})

test('normalizeBoard persists reportedAt without leaking it into taskBrief', () => {
  const { state } = normalizeBoard({
    tasks: [
      { id: 't-1', title: 'reported', status: 'done', reportedAt: '2026-11-11T02:00:00.000Z' },
      { id: 't-2', title: 'unreported', status: 'done' },
    ],
  })
  assert.equal(state.tasks[0].reportedAt, '2026-11-11T02:00:00.000Z')
  assert.equal(state.tasks[1].reportedAt, null)
  assert.equal('reportedAt' in taskBrief(state.tasks[0]), false)
})

/* ------------------------------------------------------------------ *
 * v0.2.0：完成回执 flush / 主会话绑定 / 组长条快照
 * ------------------------------------------------------------------ */

test('flushReceipts sends one batched followup to an idle main session and stamps reportedAt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-receipt-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ mainSessionId: 'main-1', mainSessionTitle: '主会话' })
    for (const title of ['A', 'B']) {
      const task = addTask(state, { title }, NOW)
      applyTaskUpdate(state, task.id, { status: 'doing' }, NOW)
      applyTaskUpdate(state, task.id, { status: 'done', result: '完成了 ' + title }, NOW)
    }
    const delivered = []
    const main = {
      id: 'main-1',
      status: 'idle',
      session: { id: 'main-1', header: { title: '主会话' } },
      followup: (message) => delivered.push(message),
    }
    const agents = { get: (id) => (id === 'main-1' ? main : undefined), roots: () => [main] }
    const rt = fakeRuntime(state, { get: (name) => (name === 'agents' ? agents : undefined) }, join(dir, 'board.json'))

    const result = await flushReceipts(rt, NOW + 10)
    assert.equal(result.sent, true)
    assert.equal(result.count, 2)
    assert.equal(result.sessionId, 'main-1')
    assert.equal(delivered.length, 1)
    const text = delivered[0].content[0].text
    assert.match(text, /^【任务看板 · 汇报】/)
    assert.match(text, /完成了 A/)
    assert.match(text, /完成了 B/)
    assert.match(text, /向用户汇总以上结论/)
    for (const task of state.tasks) assert.equal(task.reportedAt, new Date(NOW + 10).toISOString())

    // 再 flush 一次：没有未汇报任务，不重复投递
    const again = await flushReceipts(rt, NOW + 11)
    assert.equal(again.sent, false)
    assert.equal(delivered.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('flushReceipts waits while the main session is busy and skips when unbound or offline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-receipt-wait-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ mainSessionId: 'main-1' })
    const task = addTask(state, { title: 'A' }, NOW)
    applyTaskUpdate(state, task.id, { status: 'doing' }, NOW)
    applyTaskUpdate(state, task.id, { status: 'done', result: 'ok' }, NOW)

    const busy = {
      id: 'main-1',
      status: 'running',
      session: { id: 'main-1', header: {} },
      followup: () => {
        throw new Error('must not deliver while the main session is busy')
      },
    }
    const busyAgents = { get: (id) => (id === 'main-1' ? busy : undefined) }
    const busyRt = fakeRuntime(state, { get: (name) => (name === 'agents' ? busyAgents : undefined) }, join(dir, 'board.json'))
    assert.equal((await flushReceipts(busyRt)).sent, false)
    assert.equal((await flushReceipts(busyRt)).reason, 'main-busy')
    assert.equal(task.reportedAt, null)

    // 主会话离线：不发、不主动唤醒
    const offlineRt = fakeRuntime(
      state,
      { get: (name) => (name === 'agents' ? { get: () => undefined } : undefined) },
      join(dir, 'board.json'),
    )
    assert.equal((await flushReceipts(offlineRt)).reason, 'main-offline')
    assert.equal(task.reportedAt, null)

    // 未绑定主会话：完全不动
    state.config = normalizeConfig({})
    assert.equal((await flushReceipts(busyRt)).reason, 'no-main-session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tick flushes a completion receipt to the main session at the end of the round', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-receipt-tick-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ dispatchMode: 'creator', mainSessionId: 'main-1' })
    const task = addTask(state, { title: 'done task' }, NOW)
    applyTaskUpdate(state, task.id, { status: 'doing' }, NOW)
    applyTaskUpdate(state, task.id, { status: 'done', result: '结论 OK' }, NOW)

    const delivered = []
    const main = {
      id: 'main-1',
      status: 'idle',
      session: { id: 'main-1', header: {} },
      followup: (message) => delivered.push(message),
    }
    const agents = { get: (id) => (id === 'main-1' ? main : undefined), roots: () => [] }
    const rt = fakeRuntime(state, { get: (name) => (name === 'agents' ? agents : undefined) }, join(dir, 'board.json'))

    // done 的任务不参与派发（没有候选），但 tick 末尾照样 flush 完成回执。
    const result = await tick(rt, {})
    assert.equal(result.reason, 'no-candidate')
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].content[0].text, /【任务看板 · 汇报】/)
    assert.ok(task.reportedAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bind-main-session stores the session and clear-main-session resets it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-bind-'))
  try {
    const state = createEmptyBoard()
    const main = { id: 'main-1', status: 'idle', session: { id: 'main-1', header: { title: '我的主会话' } } }
    const agents = { get: (id) => (id === 'main-1' ? main : undefined) }
    const rt = fakeRuntime(state, { get: (name) => (name === 'agents' ? agents : undefined) }, join(dir, 'board.json'))

    const bound = await bindMainSession(rt, 'main-1')
    assert.deepEqual(bound.main, { sessionId: 'main-1', title: '我的主会话', live: true, busy: false, archived: false })
    assert.equal(state.config.mainSessionId, 'main-1')
    assert.equal(state.config.mainSessionTitle, '我的主会话')

    // 历史会话（不在线）也能先绑；取不到 live 标题时保留原值
    const offline = await bindMainSession(rt, 'cold-session')
    assert.equal(offline.main.sessionId, 'cold-session')
    assert.equal(offline.main.live, false)
    assert.equal(state.config.mainSessionTitle, '我的主会话')

    await assert.rejects(bindMainSession(rt, '   '), (error) => error.code === 'bad-request')
    assert.deepEqual(await clearMainSession(rt), { ok: true })
    assert.equal(state.config.mainSessionId, null)
    assert.equal(state.config.mainSessionTitle, '')
    assert.deepEqual(await clearMainSession(rt), { ok: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildSnapshot exposes main-session and workspace-lead runtime views', () => {
  const state = createEmptyBoard()
  state.config = normalizeConfig({
    mainSessionId: 'main-1',
    workspaceLeads: {
      'w-demo': { sessionId: 'lead-1', title: '持久化标题', cwd: 'C:\\work\\demo', createdAt: 'x' },
    },
  })
  const main = { id: 'main-1', status: 'idle', session: { id: 'main-1', header: { title: '主会话标题' } } }
  const lead = {
    id: 'lead-1',
    status: 'running',
    session: { id: 'lead-1', header: { cwd: 'C:\\work\\demo', title: '组长标题' } },
  }
  const agents = {
    get: (id) => (id === 'main-1' ? main : id === 'lead-1' ? lead : undefined),
    roots: () => [main, lead],
  }
  const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo', status: 'ok' }] }
  const rt = {
    ctx: {
      get: (name) => (name === 'agents' ? agents : name === 'workspaceRegistry' ? registry : undefined),
    },
    state,
    filePath: 'C:\\tmp\\board.json',
    poll: { running: true },
    presetInfo: null,
  }

  const snapshot = buildSnapshot(rt, NOW)
  assert.deepEqual(snapshot.leads.main, { sessionId: 'main-1', title: '主会话标题', live: true, busy: false, archived: false })
  assert.equal(snapshot.leads.workspaces.length, 1)
  assert.deepEqual(snapshot.leads.workspaces[0], {
    key: 'w-demo',
    label: 'demo',
    cwd: 'C:\\work\\demo',
    sessionId: 'lead-1',
    title: '组长标题',
    live: true,
    busy: true,
    archived: false,
  })
  assert.deepEqual(buildMainSessionRef(state.config, agents), snapshot.leads.main)
  assert.equal(buildWorkspaceLeadRefs({ workspaceLeads: {} }, agents, []).length, 0)

  // 未绑定主会话 → leads.main = null；组长离线时 title 退回持久化映射
  state.config = normalizeConfig({
    workspaceLeads: { 'w-demo': { sessionId: 'lead-gone', title: '持久化标题', cwd: 'C:\\work\\demo' } },
  })
  const offlineSnapshot = buildSnapshot(rt, NOW)
  assert.equal(offlineSnapshot.leads.main, null)
  assert.equal(offlineSnapshot.leads.workspaces[0].live, false)
  assert.equal(offlineSnapshot.leads.workspaces[0].busy, false)
  assert.equal(offlineSnapshot.leads.workspaces[0].title, '持久化标题')
})

/* ------------------------------------------------------------------ *
 * v0.2.0：tick 工作区组长三路径（复用组长 / 懒创建 / busy 跳过）
 * ------------------------------------------------------------------ */

test('tick in workspace-lead mode reuses the existing workspace lead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-reuse-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({
      dispatchMode: 'workspace-lead',
      workspaceLeads: {
        'w-demo': {
          sessionId: 'lead-1',
          title: '',
          cwd: 'C:\\work\\demo',
          createdAt: new Date(NOW).toISOString(),
        },
      },
    })
    const task = addTask(state, { title: 'lead task', cwd: 'C:\\work\\demo' }, NOW)

    const delivered = []
    const lead = {
      id: 'lead-1',
      status: 'idle',
      session: { id: 'lead-1', header: { cwd: 'C:\\work\\demo', title: 'demo 组长' } },
      followup: (message) => delivered.push(message),
    }
    let createCalls = 0
    const controller = {
      create: async () => {
        createCalls += 1
        return { sessionId: 'must-not-create' }
      },
    }
    const agents = { get: (id) => (id === 'lead-1' ? lead : undefined), roots: () => [lead] }
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo' }] }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    const result = await tick(rt, {})
    assert.equal(result.dispatched, true)
    assert.equal(result.sessionId, 'lead-1')
    assert.equal(result.task.id, task.id)
    assert.equal(createCalls, 0, '已有组长映射时不得新建会话')
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].content[0].text, /【任务看板 · 待开始】t-1 lead task/)
    assert.equal(task.status, 'doing')
    assert.equal(task.dispatchedSessionId, 'lead-1')
    assert.equal(task.dispatchedSessionTitle, 'demo 组长')
    assert.equal(rt.poll.lastSkipReason, null)
    assert.equal(state.config.workspaceLeads['w-demo'].sessionId, 'lead-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tick lazily creates one lead per workspace and reuses it for the next task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-create-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ dispatchMode: 'workspace-lead' })
    const first = addTask(state, { title: 'first', cwd: 'C:\\work\\demo' }, NOW)
    const second = addTask(state, { title: 'second', cwd: 'C:\\work\\demo' }, NOW + 1)

    const delivered = []
    const lead = {
      id: 'lead-new',
      status: 'idle',
      session: { id: 'lead-new', header: { cwd: 'C:\\work\\demo' } },
      followup: (message) => delivered.push(message),
    }
    const createCalls = []
    const controller = {
      create: async (request) => {
        createCalls.push(request)
        return { sessionId: 'lead-new' }
      },
      resolveAgent: async () => ({ agent: lead }),
    }
    const agents = { get: (id) => (id === 'lead-new' ? lead : undefined), roots: () => [lead] }
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo' }] }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    // 第一次 tick：没有映射 → 懒创建组长（落在工作区分组里，带 taskboard-dispatch 预设）。
    const firstTick = await tick(rt, {})
    assert.equal(firstTick.dispatched, true)
    assert.equal(firstTick.sessionId, 'lead-new')
    assert.equal(createCalls.length, 1)
    assert.equal(createCalls[0].workspaceId, 'w-demo')
    assert.equal(createCalls[0].agentPreset, 'taskboard-dispatch')
    assert.equal(createCalls[0].cwd, undefined, '能映射到 workspaceId 时按工作区创建')
    assert.equal(state.config.workspaceLeads['w-demo'].sessionId, 'lead-new')
    assert.equal(first.status, 'doing')

    // 第二次 tick：同工作区的第二条任务复用同一个组长，绝不为任务再新建会话。
    const secondTick = await tick(rt, {})
    assert.equal(secondTick.dispatched, true)
    assert.equal(secondTick.task.id, second.id)
    assert.equal(createCalls.length, 1, '一个工作区只能有一个常驻组长')
    assert.equal(delivered.length, 2)
    assert.equal(second.status, 'doing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tick skips a busy workspace lead and tries the next candidate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-busy-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({
      dispatchMode: 'workspace-lead',
      workspaceLeads: {
        'w-a': { sessionId: 'lead-a', title: '', cwd: 'C:\\work\\a', createdAt: new Date(NOW).toISOString() },
        'w-b': { sessionId: 'lead-b', title: '', cwd: 'C:\\work\\b', createdAt: new Date(NOW).toISOString() },
      },
    })
    const busyTask = addTask(state, { title: 'busy lead task', cwd: 'C:\\work\\a' }, NOW)
    const idleTask = addTask(state, { title: 'idle lead task', cwd: 'C:\\work\\b' }, NOW + 1)

    const delivered = []
    const busyLead = {
      id: 'lead-a',
      status: 'running',
      session: { id: 'lead-a', header: { cwd: 'C:\\work\\a' } },
      followup: () => {
        throw new Error('must not deliver to a busy lead')
      },
    }
    const idleLead = {
      id: 'lead-b',
      status: 'idle',
      session: { id: 'lead-b', header: { cwd: 'C:\\work\\b' } },
      followup: (message) => delivered.push(message),
    }
    const agents = {
      get: (id) => (id === 'lead-a' ? busyLead : id === 'lead-b' ? idleLead : undefined),
      roots: () => [busyLead, idleLead],
    }
    const registry = {
      list: () => [
        { id: 'w-a', path: 'C:\\work\\a', title: 'a' },
        { id: 'w-b', path: 'C:\\work\\b', title: 'b' },
      ],
    }
    const controller = {
      create: async () => {
        throw new Error('workspace-lead 模式绝不为已有映射重建会话')
      },
    }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    const result = await tick(rt, {})
    // 组长忙的任务留 todo 写 lead-busy，继续试下一条候选；本轮仍只投递 1 条。
    assert.equal(result.dispatched, true)
    assert.equal(result.task.id, idleTask.id)
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].content[0].text, /idle lead task/)
    assert.equal(busyTask.status, 'todo')
    assert.match(busyTask.lastError, /工作区组长正在运行/)
    assert.equal(idleTask.status, 'doing')
    assert.equal(rt.poll.lastSkipReason, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tick does not rebuild an existing mapping when the lead cannot be revived', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-gone-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({
      dispatchMode: 'workspace-lead',
      workspaceLeads: {
        'w-demo': {
          sessionId: 'lead-gone',
          title: '旧组长',
          cwd: 'C:\\work\\demo',
          createdAt: new Date(NOW).toISOString(),
        },
      },
    })
    const task = addTask(state, { title: 'orphan task', cwd: 'C:\\work\\demo' }, NOW)

    let createCalls = 0
    const controller = {
      create: async () => {
        createCalls += 1
        return { sessionId: 'must-not-create' }
      },
      resolveAgent: async () => ({ error: { code: 'session/not-found' } }),
    }
    const agents = { get: () => undefined, roots: () => [] }
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo' }] }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    const result = await tick(rt, {})
    assert.equal(result.dispatched, false)
    assert.equal(result.reason, 'lead-unavailable')
    assert.equal(rt.poll.lastSkipReason, 'lead-unavailable')
    assert.equal(task.status, 'todo')
    assert.match(task.lastError, /工作区组长不可用/)
    assert.equal(createCalls, 0, 'tick 不自动重建已有映射（修复走 ensure-workspace-lead）')
    assert.equal(state.config.workspaceLeads['w-demo'].sessionId, 'lead-gone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tick reports lead-no-workspace when the task has no resolvable workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-nows-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ dispatchMode: 'workspace-lead' })
    const task = addTask(state, { title: 'no workspace' }, NOW)
    const agents = { get: () => undefined, roots: () => [] }
    const ctx = { get: (name) => (name === 'agents' ? agents : undefined) }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    const result = await tick(rt, {})
    assert.equal(result.dispatched, false)
    assert.equal(result.reason, 'lead-no-workspace')
    assert.equal(rt.poll.lastSkipReason, 'lead-no-workspace')
    assert.equal(task.status, 'todo')
    assert.match(task.lastError, /无法解析任务的工作区/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dispatch-now(force) queues into a busy lead and never reroutes to another workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-force-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({
      dispatchMode: 'workspace-lead',
      workspaceLeads: {
        'w-demo': { sessionId: 'lead-1', title: '', cwd: 'C:\\work\\demo', createdAt: new Date(NOW).toISOString() },
      },
    })
    const task = addTask(state, { title: 'force task', cwd: 'C:\\work\\demo' }, NOW)
    const delivered = []
    const busyLead = {
      id: 'lead-1',
      status: 'running',
      session: { id: 'lead-1', header: { cwd: 'C:\\work\\demo' } },
      followup: (message) => delivered.push(message),
    }
    const agents = { get: (id) => (id === 'lead-1' ? busyLead : undefined), roots: () => [busyLead] }
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo' }] }
    const controller = {
      create: async () => {
        throw new Error('force 也不得改派 / 新建会话')
      },
    }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    const forced = await tick(rt, { taskId: task.id, force: true })
    assert.equal(forced.dispatched, true)
    assert.equal(forced.sessionId, 'lead-1')
    assert.equal(delivered.length, 1)
    assert.equal(task.status, 'doing')

    // 组长离线 + force：先尝试唤醒，失败返回 lead-unavailable，不改派别的工区。
    const offlineState = createEmptyBoard()
    offlineState.config = normalizeConfig({
      dispatchMode: 'workspace-lead',
      workspaceLeads: {
        'w-demo': { sessionId: 'lead-gone', title: '', cwd: 'C:\\work\\demo', createdAt: new Date(NOW).toISOString() },
      },
    })
    const offlineTask = addTask(offlineState, { title: 'offline force', cwd: 'C:\\work\\demo' }, NOW)
    let offlineCreateCalls = 0
    const offlineController = {
      create: async () => {
        offlineCreateCalls += 1
        return { sessionId: 'x' }
      },
      resolveAgent: async () => ({ error: { code: 'session/not-found' } }),
    }
    const offlineAgents = { get: () => undefined, roots: () => [busyLead] }
    const offlineCtx = {
      get: (name) =>
        name === 'agents'
          ? offlineAgents
          : name === 'sessionController'
            ? offlineController
            : name === 'workspaceRegistry'
              ? registry
              : undefined,
    }
    const offlineRt = fakeRuntime(offlineState, offlineCtx, join(dir, 'board-offline.json'))
    const offlineResult = await tick(offlineRt, { taskId: offlineTask.id, force: true })
    assert.equal(offlineResult.dispatched, false)
    assert.equal(offlineResult.reason, 'lead-unavailable')
    assert.equal(offlineTask.status, 'todo')
    assert.equal(offlineCreateCalls, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * v0.2.0：ensure-workspace-lead 修复入口
 * ------------------------------------------------------------------ */

test('ensure-workspace-lead reuses a live lead and repairs the mapping title', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-ensure-reuse-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({
      workspaceLeads: {
        'w-demo': { sessionId: 'old-lead', title: '', cwd: 'C:\\work\\demo', createdAt: 'x' },
      },
    })
    const lead = {
      id: 'old-lead',
      status: 'idle',
      session: { id: 'old-lead', header: { cwd: 'C:\\work\\demo', title: '组长标题' } },
    }
    const agents = { get: (id) => (id === 'old-lead' ? lead : undefined) }
    let createCalls = 0
    const controller = {
      create: async () => {
        createCalls += 1
        return { sessionId: 'must-not-create' }
      },
    }
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo' }] }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    const { lead: ref } = await ensureWorkspaceLead(rt, 'C:\\work\\demo')
    assert.equal(ref.key, 'w-demo')
    assert.equal(ref.sessionId, 'old-lead')
    assert.equal(ref.live, true)
    assert.equal(ref.busy, false)
    assert.equal(ref.title, '组长标题')
    assert.equal(createCalls, 0, '已有 live 组长时直接复用')
    assert.equal(state.config.workspaceLeads['w-demo'].title, '组长标题', '顺手修复映射里为空的 title')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensure-workspace-lead replaces a mapping whose lead cannot be revived', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-ensure-replace-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({
      workspaceLeads: {
        'w-demo': { sessionId: 'old-lead', title: '旧组长', cwd: 'C:\\work\\demo', createdAt: '2026-01-01T00:00:00.000Z' },
      },
    })
    const live = new Map()
    const newLead = {
      id: 'new-lead',
      status: 'idle',
      session: { id: 'new-lead', header: { cwd: 'C:\\work\\demo', title: '新组长' } },
    }
    const agents = { get: (id) => live.get(id) }
    const createCalls = []
    const controller = {
      resolveAgent: async () => ({ error: { code: 'session/not-found' } }),
      create: async (request) => {
        createCalls.push(request)
        live.set('new-lead', newLead)
        return { sessionId: 'new-lead' }
      },
    }
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo' }] }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    const { lead: ref } = await ensureWorkspaceLead(rt, 'C:\\work\\demo')
    assert.equal(ref.sessionId, 'new-lead')
    assert.equal(ref.live, true)
    assert.equal(ref.busy, false)
    assert.equal(createCalls.length, 1)
    assert.equal(createCalls[0].workspaceId, 'w-demo')
    assert.equal(createCalls[0].agentPreset, 'taskboard-dispatch')
    assert.equal(state.config.workspaceLeads['w-demo'].sessionId, 'new-lead', '失效映射被替换')
    assert.equal(state.config.workspaceLeads['w-demo'].title, '新组长')

    // 参数 / 错误分支：空 cwd → bad-request；没有 sessionController → internal
    await assert.rejects(ensureWorkspaceLead(rt, '   '), (error) => error.code === 'bad-request')
    const bareState = createEmptyBoard()
    const bareRt = fakeRuntime(
      bareState,
      { get: (name) => (name === 'agents' ? { get: () => undefined } : undefined) },
      join(dir, 'board-bare.json'),
    )
    await assert.rejects(
      ensureWorkspaceLead(bareRt, 'C:\\work\\demo'),
      (error) => error.code === 'internal' && /无法创建工作区组长/.test(error.message),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workspace lead creation falls back to cwd when the workspace-group create is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-fallback-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ dispatchMode: 'workspace-lead' })
    const task = addTask(state, { title: 'fallback task', cwd: 'C:\\work\\demo' }, NOW)
    const delivered = []
    const lead = {
      id: 'lead-cwd',
      status: 'idle',
      session: { id: 'lead-cwd', header: { cwd: 'C:\\work\\demo' } },
      followup: (message) => delivered.push(message),
    }
    const createCalls = []
    const controller = {
      create: async (request) => {
        createCalls.push(request)
        if (request.workspaceId) throw new Error('workspace/denied')
        return { sessionId: 'lead-cwd' }
      },
    }
    const agents = { get: (id) => (id === 'lead-cwd' ? lead : undefined), roots: () => [lead] }
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo' }] }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    const result = await tick(rt, {})
    assert.equal(result.dispatched, true)
    assert.equal(createCalls.length, 2, '按工作区创建失败后要退回按 cwd 创建')
    assert.equal(createCalls[0].workspaceId, 'w-demo')
    assert.equal(createCalls[1].workspaceId, undefined)
    assert.equal(createCalls[1].cwd, 'C:\\work\\demo')
    assert.equal(state.config.workspaceLeads['w-demo'].sessionId, 'lead-cwd')
    assert.equal(delivered.length, 1)
    assert.equal(task.status, 'doing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * v0.2.0：taskboard_add.workspace / taskboard_update 完成回执
 * ------------------------------------------------------------------ */

test('taskboard_add resolves the optional workspace argument', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-add-workspace-'))
  try {
    const state = createEmptyBoard()
    const registry = {
      list: () => [
        { id: 'w-demo', path: 'C:\\work\\demo', title: 'Demo' },
        { id: 'w-other', path: 'C:\\work\\other', title: '其他' },
      ],
    }
    const rt = fakeRuntime(
      state,
      { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) },
      join(dir, 'board.json'),
    )
    const registered = []
    registerTools({ tools: { register: (definition) => registered.push(definition) } }, rt)
    const addTool = registered.find((tool) => tool.name === 'taskboard_add')
    assert.ok(addTool)
    assert.deepEqual(
      addTool.parameters.properties.workspace.type,
      'string',
      'taskboard_add 的 parameters 必须声明可选 workspace',
    )
    assert.equal(addTool.parameters.required.includes('workspace'), false)

    const exec = { agent: { session: { id: 'caller-session', header: { cwd: 'C:\\caller' } } } }
    const byTitle = await addTool.execute({ title: '跨工作区任务', workspace: 'demo' }, exec)
    assert.deepEqual(schemaProblems(byTitle, TASK_ONE_OUTPUT_SCHEMA), [])
    assert.equal(state.tasks[0].cwd, 'C:\\work\\demo')
    assert.equal(state.tasks[0].sessionId, 'caller-session')
    assert.equal(state.tasks[0].title, '跨工作区任务')

    await addTool.execute({ title: '按绝对路径', workspace: 'D:\\elsewhere' }, exec)
    assert.equal(state.tasks[1].cwd, 'D:\\elsewhere')

    await addTool.execute({ title: '省略工作区' }, exec)
    assert.equal(state.tasks[2].cwd, 'C:\\caller')

    // workspace 解析失败是工具调用错误（§3.3）：execute 同步抛错，不建任务。
    assert.throws(() => addTool.execute({ title: '未知', workspace: 'nope' }, exec), /未知工作区：nope/)
    assert.equal(state.tasks.length, 3, '未知工作区不得创建任务')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('taskboard_update tool flushes a receipt when the task reaches done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-tool-receipt-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ mainSessionId: 'main-1' })
    const task = addTask(state, { title: 'tool done task' }, NOW)
    const delivered = []
    const main = {
      id: 'main-1',
      status: 'idle',
      session: { id: 'main-1', header: {} },
      followup: (message) => delivered.push(message),
    }
    const agents = { get: (id) => (id === 'main-1' ? main : undefined) }
    const rt = fakeRuntime(state, { get: (name) => (name === 'agents' ? agents : undefined) }, join(dir, 'board.json'))
    const registered = []
    registerTools({ tools: { register: (definition) => registered.push(definition) } }, rt)
    const updateTool = registered.find((tool) => tool.name === 'taskboard_update')

    const doing = await updateTool.execute({ id: task.id, status: 'doing' })
    assert.deepEqual(schemaProblems(doing, TASK_ONE_OUTPUT_SCHEMA), [])
    assert.equal(delivered.length, 0, 'doing 不触发完成回执')

    const done = await updateTool.execute({ id: task.id, status: 'done', result: '工具里完成的' })
    assert.deepEqual(schemaProblems(done, TASK_ONE_OUTPUT_SCHEMA), [])
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].content[0].text, /【任务看板 · 汇报】/)
    assert.match(delivered[0].content[0].text, /工具里完成的/)
    assert.ok(task.reportedAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * v0.2.0 回归补强：回执 flush 边界 / 懒创建无 live / 回执失败 / 双 create 失败
 * ------------------------------------------------------------------ */

test('regression: paused polling still flushes completion receipts but does not dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-paused-receipt-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({
      pollEnabled: false,
      dispatchMode: 'workspace-lead',
      mainSessionId: 'main-1',
      workspaceLeads: {
        'w-demo': {
          sessionId: 'lead-1',
          title: '',
          cwd: 'C:\\work\\demo',
          createdAt: new Date(NOW).toISOString(),
        },
      },
    })
    const doneTask = addTask(state, { title: 'paused done', cwd: 'C:\\work\\demo' }, NOW)
    applyTaskUpdate(state, doneTask.id, { status: 'doing' }, NOW + 1)
    applyTaskUpdate(state, doneTask.id, { status: 'done', result: 'paused 结论' }, NOW + 2)
    const todoTask = addTask(state, { title: 'paused todo', cwd: 'C:\\work\\demo' }, NOW + 3)

    const mainDelivered = []
    const main = {
      id: 'main-1',
      status: 'idle',
      session: { id: 'main-1', header: {} },
      followup: (message) => mainDelivered.push(message),
    }
    const leadDelivered = []
    const lead = {
      id: 'lead-1',
      status: 'idle',
      session: { id: 'lead-1', header: { cwd: 'C:\\work\\demo' } },
      followup: (message) => leadDelivered.push(message),
    }
    const agents = {
      get: (id) => (id === 'main-1' ? main : id === 'lead-1' ? lead : undefined),
      roots: () => [main, lead],
    }
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo' }] }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    const result = await tick(rt, {})
    // 轮询暂停：不派发任务……
    assert.equal(result.dispatched, false)
    assert.equal(result.reason, 'poll-disabled')
    assert.equal(leadDelivered.length, 0, 'pollEnabled=false 时不得投递任务')
    assert.equal(todoTask.status, 'todo')
    assert.equal(todoTask.notificationCount, 0)
    // ……但 tick 末尾仍 flush 完成回执（§1.6）。
    assert.equal(mainDelivered.length, 1)
    assert.match(mainDelivered[0].content[0].text, /【任务看板 · 汇报】/)
    assert.match(mainDelivered[0].content[0].text, /paused 结论/)
    assert.ok(doneTask.reportedAt, '回执成功后写 reportedAt')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('regression: lazily created lead without a live agent keeps mapping and is reused without a second create', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-pending-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ dispatchMode: 'workspace-lead' })
    const task = addTask(state, { title: 'pending lead task', cwd: 'C:\\work\\demo' }, NOW)

    const delivered = []
    const createCalls = []
    let agent = null
    const controller = {
      create: async (request) => {
        createCalls.push(request)
        return { sessionId: 'lead-pending' }
      },
      resolveAgent: async () => (agent ? { agent } : { error: { code: 'session/pending' } }),
    }
    const agents = {
      get: (id) => (id === 'lead-pending' && agent ? agent : undefined),
      roots: () => (agent ? [agent] : []),
    }
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo' }] }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    // 第一次 tick：create 拿到 sessionId，但 agent 还没物化 → lead-unavailable，任务留 todo，
    // 映射必须写进 config.workspaceLeads（否则下一轮会重复建组长）。
    const first = await tick(rt, {})
    assert.equal(first.dispatched, false)
    assert.equal(first.reason, 'lead-unavailable')
    assert.equal(createCalls.length, 1)
    assert.equal(state.config.workspaceLeads['w-demo'].sessionId, 'lead-pending')
    assert.equal(task.status, 'todo')
    assert.match(task.lastError, /工作区组长不可用/)

    // 第二次 tick：agent 可被唤醒 → 复用映射里的同一个 sessionId，不再 create。
    agent = {
      id: 'lead-pending',
      status: 'idle',
      session: { id: 'lead-pending', header: { cwd: 'C:\\work\\demo' } },
      followup: (message) => delivered.push(message),
    }
    const second = await tick(rt, {})
    assert.equal(second.dispatched, true)
    assert.equal(second.sessionId, 'lead-pending')
    assert.equal(createCalls.length, 1, '第二轮必须复用已持久化的映射，不得重复 create')
    assert.equal(delivered.length, 1)
    assert.equal(task.status, 'doing')
    assert.equal(task.dispatchedSessionId, 'lead-pending')
    assert.equal(state.config.workspaceLeads['w-demo'].sessionId, 'lead-pending')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('regression: a failing receipt followup keeps reportedAt null and retries next flush', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-receipt-fail-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ mainSessionId: 'main-1' })
    const task = addTask(state, { title: 'receipt retry', result: '' }, NOW)
    applyTaskUpdate(state, task.id, { status: 'doing' }, NOW + 1)
    applyTaskUpdate(state, task.id, { status: 'done', result: '重试结论' }, NOW + 2)

    let followupCalls = 0
    const main = {
      id: 'main-1',
      status: 'idle',
      session: { id: 'main-1', header: {} },
      followup: () => {
        followupCalls += 1
        throw new Error('followup boom')
      },
    }
    const agents = { get: (id) => (id === 'main-1' ? main : undefined) }
    const rt = fakeRuntime(state, { get: (name) => (name === 'agents' ? agents : undefined) }, join(dir, 'board.json'))

    const failed = await flushReceipts(rt, NOW + 10)
    assert.equal(failed.sent, false)
    assert.equal(failed.reason, 'followup-failed')
    assert.equal(followupCalls, 1)
    assert.equal(task.reportedAt, null, 'followup 抛错不得写 reportedAt（下一轮重试）')

    // 恢复投递能力后重试：同一批任务补发成功并记账。
    main.followup = () => {
      followupCalls += 1
    }
    const retried = await flushReceipts(rt, NOW + 11)
    assert.equal(retried.sent, true)
    assert.equal(retried.count, 1)
    assert.equal(followupCalls, 2)
    assert.ok(task.reportedAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('regression: workspace-lead tick reports lead-unavailable when both create attempts fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-create-fail-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ dispatchMode: 'workspace-lead' })
    const task = addTask(state, { title: 'create fail task', cwd: 'C:\\work\\demo' }, NOW)

    const createCalls = []
    const controller = {
      create: async (request) => {
        createCalls.push(request)
        throw new Error('create rejected')
      },
    }
    const agents = { get: () => undefined, roots: () => [] }
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo' }] }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    const result = await tick(rt, {})
    assert.equal(result.dispatched, false)
    assert.equal(result.reason, 'lead-unavailable')
    assert.equal(createCalls.length, 2, '按工作区创建失败后应退回按 cwd 再试一次')
    assert.equal(createCalls[0].workspaceId, 'w-demo')
    assert.equal(createCalls[1].workspaceId, undefined)
    assert.equal(createCalls[1].cwd, 'C:\\work\\demo')
    assert.equal(task.status, 'todo')
    assert.match(task.lastError, /工作区组长不可用/)
    assert.deepEqual(normalizeConfig(state.config).workspaceLeads, {}, '两次 create 都失败时不得生成映射')
    assert.equal(rt.poll.lastSkipReason, 'lead-unavailable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * v0.2.0：组长 / 主会话被归档（archived-session-gate 兜底）
 * ------------------------------------------------------------------ */

test('requeueTasksOfLead moves the archived lead doing tasks back to todo', () => {
  const state = createEmptyBoard()
  const doing = addTask(state, { title: 'doing task', cwd: 'C:\\work\\demo' }, NOW)
  doing.status = 'doing'
  doing.startedAt = new Date(NOW).toISOString()
  doing.notifiedAt = new Date(NOW).toISOString()
  doing.notificationCount = 2
  doing.assignee = 'worker-1'
  doing.dispatchedSessionId = 'lead-archived'
  doing.dispatchedSessionTitle = '旧组长'
  const other = addTask(state, { title: 'done task', cwd: 'C:\\work\\demo' }, NOW + 1)
  other.status = 'done'
  other.dispatchedSessionId = 'lead-archived'

  assert.equal(requeueTasksOfLead(state, 'lead-archived', NOW + 2), 1)
  assert.equal(doing.status, 'todo')
  assert.equal(doing.notifiedAt, null)
  assert.equal(doing.notificationCount, 0)
  assert.equal(doing.dispatchedSessionId, null)
  assert.match(doing.lastError, /已归档/)
  assert.equal(other.status, 'done', 'done 任务不动')
  assert.equal(requeueTasksOfLead(state, 'no-such-lead'), 0)
})

test('archivedSessionIdSet reads the workspace registry archive set', () => {
  const registry = { archivedSessionIds: ['a', '', 42, 'b'] }
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
  assert.deepEqual([...archivedSessionIdSet({ ctx })].sort(), ['a', 'b'])
  assert.equal(archivedSessionIdSet({ ctx: { get: () => undefined } }).size, 0)
})

test('flushReceipts skips an archived main session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-main-archived-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ mainSessionId: 'main-archived', dispatchMode: 'workspace-lead' })
    const task = addTask(state, { title: 'done task' }, NOW)
    task.status = 'done'
    task.result = 'ok'
    task.reportedAt = null
    const main = {
      id: 'main-archived',
      status: 'idle',
      session: { id: 'main-archived', header: {} },
      followup: () => {
        throw new Error('must not deliver to an archived main session')
      },
    }
    const agents = { get: (id) => (id === 'main-archived' ? main : undefined) }
    const registry = { archivedSessionIds: ['main-archived'] }
    const ctx = {
      get: (name) => (name === 'agents' ? agents : name === 'workspaceRegistry' ? registry : undefined),
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    const result = await flushReceipts(rt, NOW + 1)
    assert.equal(result.sent, false)
    assert.equal(result.reason, 'main-archived')
    assert.equal(task.reportedAt, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tick replaces an archived workspace lead with a fresh one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-archived-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({
      dispatchMode: 'workspace-lead',
      workspaceLeads: {
        'w-demo': { sessionId: 'lead-archived', title: '', cwd: 'C:\\work\\demo', createdAt: new Date(NOW).toISOString() },
      },
    })
    const task = addTask(state, { title: 'archived lead task', cwd: 'C:\\work\\demo' }, NOW)
    const delivered = []
    const oldLead = {
      id: 'lead-archived',
      status: 'idle',
      session: { id: 'lead-archived', header: { cwd: 'C:\\work\\demo' } },
      followup: () => {
        throw new Error('archived lead must not receive followups')
      },
    }
    const newLead = {
      id: 'lead-new',
      status: 'idle',
      session: { id: 'lead-new', header: { cwd: 'C:\\work\\demo' } },
      followup: (message) => delivered.push(message),
    }
    const createCalls = []
    const controller = {
      create: async (request) => {
        createCalls.push(request)
        return { sessionId: 'lead-new' }
      },
      resolveAgent: async () => ({ agent: newLead }),
    }
    const agents = {
      get: (id) => (id === 'lead-archived' ? oldLead : id === 'lead-new' ? newLead : undefined),
      roots: () => [oldLead, newLead],
    }
    const registry = {
      list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo' }],
      archivedSessionIds: ['lead-archived'],
    }
    const ctx = {
      get: (name) =>
        name === 'agents' ? agents : name === 'sessionController' ? controller : name === 'workspaceRegistry' ? registry : undefined,
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))

    const result = await tick(rt, {})
    assert.equal(result.dispatched, true)
    assert.equal(result.sessionId, 'lead-new')
    assert.equal(delivered.length, 1)
    assert.equal(task.status, 'doing')
    assert.equal(task.dispatchedSessionId, 'lead-new')
    assert.equal(createCalls.length, 1)
    assert.equal(state.config.workspaceLeads['w-demo'].sessionId, 'lead-new')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * §1.8 组长直聊派活 → 自动建看板任务
 * ------------------------------------------------------------------ */

/** 一个 taskboard-dispatch 预设的组长 Agent + 能回答 preset 投影的 ctx。 */
function leadFixture(options = {}) {
  const preset = options.preset || 'taskboard-dispatch'
  const lead = {
    id: options.id || 'lead-1',
    status: options.status || 'idle',
    session: {
      id: options.id || 'lead-1',
      header: { cwd: options.cwd || 'C:\\work\\demo', title: options.title || 'demo 组长', agentPreset: preset },
    },
  }
  const presetOf = () => preset
  const ctx = {
    get: (name) =>
      name === 'agentPresets'
        ? { presetForSession: presetOf }
        : name === 'agents'
          ? { get: (id) => (lead.id === id ? lead : undefined), roots: () => [lead] }
          : undefined,
  }
  return { lead, ctx }
}

test('normalizeTask keeps only the known autoDispatch marker', () => {
  const { state } = normalizeBoard({
    version: 1,
    tasks: [
      { id: 't-1', title: '宿主自动任务', autoDispatch: 'lead-dispatch' },
      { id: 't-2', title: '非法标记', autoDispatch: 'poller' },
      { id: 't-3', title: '老任务（没有这个字段）' },
    ],
  })
  assert.equal(state.tasks[0].autoDispatch, LEAD_AUTO_MARK)
  assert.equal(state.tasks[1].autoDispatch, null, '非 lead-dispatch 一律规范成 null')
  assert.equal(state.tasks[2].autoDispatch, null, '老 board.json 缺字段 = null')
  assert.equal(isLeadAutoTask(state.tasks[0]), true)
  assert.equal(isLeadAutoTask(state.tasks[1]), false)
})

test('a lead dispatching in a direct chat creates one doing board task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-'))
  try {
    const state = createEmptyBoard()
    const { lead, ctx } = leadFixture()
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    const result = handleSubagentDispatch(
      rt,
      { agent: lead, childId: 'worker-1', args: { description: '把 X 改成 Y', prompt: '## 任务\n把 X 改成 Y\n验收标准：跑测试' } },
      NOW,
    )

    assert.equal(result.created, true)
    assert.equal(result.taskId, 't-1')
    assert.equal(state.tasks.length, 1)
    const task = state.tasks[0]
    assert.equal(task.title, '把 X 改成 Y', 'title 取 description')
    assert.equal(task.status, 'doing')
    assert.equal(task.startedAt, new Date(NOW).toISOString())
    assert.equal(task.assignee, 'worker-1', 'assignee = worker 会话 id')
    assert.equal(task.cwd, 'C:\\work\\demo', 'workspace = 组长当前工作区')
    assert.equal(task.sessionId, 'lead-1')
    assert.equal(task.dispatchedSessionId, 'lead-1')
    assert.equal(task.dispatchedSessionTitle, 'demo 组长')
    assert.equal(task.source, 'agent')
    assert.equal(task.autoDispatch, LEAD_AUTO_MARK, '打上「宿主自动建」标记：只有它能被 subagent/end 自动收尾')
    assert.equal(isLeadAutoTask(task), true)
    assert.equal(task.note, '## 任务\n把 X 改成 Y\n验收标准：跑测试')
    assert.equal(task.notifiedAt, null, '自动任务不参与轮询')
    assert.equal(rt.leadAuto.created, 1)
    assert.equal(rt.leadAuto.lastTaskId, 't-1')
    assert.equal(rt.leadAuto.lastWorkerSessionId, 'worker-1')

    // 落盘：与 RPC / 工具同一条写盘路径，revision 正常递增。
    const saved = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'))
    assert.equal(saved.tasks.length, 1)
    assert.equal(saved.tasks[0].status, 'doing')
    assert.equal(saved.tasks[0].autoDispatch, LEAD_AUTO_MARK, '标记要落盘（跨进程 / 重启后仍只收尾自动任务）')
    assert.ok(saved.revision > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a worker completion writes the task done with its report and sends the receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-done-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ mainSessionId: 'main-1' })
    const { lead, ctx } = leadFixture()
    const followups = []
    const mainAgent = {
      id: 'main-1',
      status: 'idle',
      session: { id: 'main-1', header: { cwd: 'C:\\work\\demo' } },
      followup: (message) => followups.push(message),
    }
    ctx.get = (name) => {
      if (name === 'agentPresets') return { presetForSession: () => 'taskboard-dispatch' }
      if (name === 'agents') {
        return { get: (id) => (id === 'main-1' ? mainAgent : id === 'lead-1' ? lead : undefined), roots: () => [lead] }
      }
      if (name === 'sessions') return { flush: async () => {} }
      return undefined
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    handleSubagentDispatch(rt, { agent: lead, childId: 'worker-1', args: { description: '修复登录', prompt: '修好登录' } }, NOW)
    const outcome = await handleSubagentEnd(
      rt,
      {
        runId: 'run-1',
        provider: 'spawn',
        id: 'worker-1',
        local: true,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: '## 结论\n\n- 改了 a.js\n- 测试通过' }],
      },
      NOW + 1000,
    )

    assert.equal(outcome.updated, true)
    const task = state.tasks[0]
    assert.equal(task.status, 'done')
    assert.equal(task.finishedAt, new Date(NOW + 1000).toISOString())
    assert.match(task.result, /## 结论/)
    assert.match(task.result, /测试通过/)
    assert.ok(task.reportedAt, '沿用 §1.6 完成回执链路：reportedAt 已写')
    assert.equal(followups.length, 1)
    assert.match(followups[0].content[0].text, /【任务看板 · 汇报】[\s\S]*- t-1 修复登录/)
    assert.equal(rt.leadAuto.completed, 1)
    assert.equal(rt.leadAuto.lastError, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failing auto task creation never blocks the dispatch and records leadAuto.lastError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-fail-'))
  try {
    const state = createEmptyBoard()
    // 模拟损坏的看板状态：tasks 不是数组 → addTask 抛 TypeError。
    state.tasks = null
    const { lead, ctx } = leadFixture()
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    const result = handleSubagentDispatch(rt, { agent: lead, childId: 'worker-x', args: { description: '写不进去' } }, NOW)

    assert.equal(result.created, false, '建任务失败不抛出、不阻断派发')
    assert.equal(result.reason, 'error')
    assert.equal(rt.leadAuto.created, 0)
    assert.match(rt.leadAuto.lastError, /自动建看板任务失败/)
    assert.equal(rt.leadAuto.lastErrorAt, new Date(NOW).toISOString())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unwritable board file keeps the task in memory and records lastError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-disk-'))
  try {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const state = createEmptyBoard()
    const { lead, ctx } = leadFixture()
    // board.json 的父目录其实是个文件 → mkdirSync 抛 ENOTDIR → commitBoard 返回 saved:false。
    const rt = fakeRuntime(state, ctx, join(blocker, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    const result = handleSubagentDispatch(rt, { agent: lead, childId: 'worker-disk', args: { description: '写盘失败' } }, NOW)

    assert.equal(result.created, true, '写盘失败不影响内存任务，更不影响派发')
    assert.equal(state.tasks.length, 1)
    assert.match(rt.leadAuto.lastError, /看板写盘失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the same worker never creates a second task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-dedup-'))
  try {
    const state = createEmptyBoard()
    const { lead, ctx } = leadFixture()
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    handleSubagentDispatch(rt, { agent: lead, childId: 'worker-1', args: { description: '第一次' } }, NOW)
    const again = handleSubagentDispatch(rt, { agent: lead, childId: 'worker-1', args: { description: '第二次' } }, NOW + 10)

    assert.equal(again.created, false)
    assert.equal(again.reason, 'dedup-worker')
    assert.equal(state.tasks.length, 1)
    assert.equal(state.tasks[0].title, '第一次')
    assert.equal(rt.leadAuto.deduped, 1)
    assert.equal(findTaskByWorker(state, 'worker-1').id, 't-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lead already handling a polled task does not get a duplicate task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-inflight-'))
  try {
    const state = createEmptyBoard()
    const polled = addTask(state, { title: '轮询投递的任务', cwd: 'C:\\work\\demo' }, NOW)
    polled.status = 'doing'
    polled.dispatchedSessionId = 'lead-1'
    polled.notifiedAt = new Date(NOW).toISOString()
    const { lead, ctx } = leadFixture()
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    const skipped = handleSubagentDispatch(rt, { agent: lead, childId: 'worker-polled', args: { description: '轮询任务的 worker' } }, NOW + 10)

    assert.equal(skipped.created, false)
    assert.equal(skipped.reason, 'lead-task-in-flight')
    assert.equal(state.tasks.length, 1, '不会为同一次派发再建一条')
    assert.equal(polled.assignee, '', '也不改那条任务的字段')
    assert.equal(findLeadInFlightTask(state, 'lead-1', NOW + 10).id, polled.id, '未陈旧 → 仍算 in-flight')

    // 那条轮询任务做完之后，直聊派活可以连续建多条（自动任务 notifiedAt=null，不自我阻塞）。
    polled.status = 'done'
    polled.notifiedAt = null
    handleSubagentDispatch(rt, { agent: lead, childId: 'worker-a', args: { description: '直聊任务一' } }, NOW + 20)
    const second = handleSubagentDispatch(rt, { agent: lead, childId: 'worker-b', args: { description: '直聊任务二' } }, NOW + 30)
    assert.equal(second.created, true, '直聊派活可以连续建多条')
    assert.equal(state.tasks.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale polled in-flight task stops blocking direct dispatches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-stale-'))
  try {
    const state = createEmptyBoard()
    const polled = addTask(state, { title: '卡住的轮询任务', cwd: 'C:\\work\\demo' }, NOW)
    polled.status = 'doing'
    polled.dispatchedSessionId = 'lead-1'
    polled.notifiedAt = new Date(NOW).toISOString()
    polled.startedAt = new Date(NOW).toISOString()
    polled.updatedAt = new Date(NOW).toISOString()
    const { lead, ctx } = leadFixture()
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    // 未到窗口：算 in-flight，直聊派活被去重（这是「轮询投递 → 组长派 worker」的正常路径）。
    assert.ok(findLeadInFlightTask(state, 'lead-1', NOW + LEAD_IN_FLIGHT_TTL_MS - 1))
    // 超过窗口（worker 长跑 / 组长卡死）：不再挡住直聊派活，宁可多一条可见任务。
    assert.equal(findLeadInFlightTask(state, 'lead-1', NOW + LEAD_IN_FLIGHT_TTL_MS + 1), null)
    const created = handleSubagentDispatch(
      rt,
      { agent: lead, childId: 'worker-fresh', args: { description: '直聊派活不该被吞' } },
      NOW + LEAD_IN_FLIGHT_TTL_MS + 1,
    )
    assert.equal(created.created, true, '陈旧 in-flight 不再吞掉直聊派活')
    assert.equal(state.tasks.length, 2)
    assert.equal(state.tasks[1].autoDispatch, LEAD_AUTO_MARK)
    assert.equal(polled.status, 'doing', '不改那条卡住的轮询任务')
    assert.equal(rt.leadAuto.deduped, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the auto task uses the canonical workspace path from the registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-ws-'))
  try {
    const state = createEmptyBoard()
    const { lead, ctx } = leadFixture({ cwd: 'c:/WORK/demo/' })
    const registry = { list: () => [{ id: 'w-demo', path: 'C:\\work\\demo', title: 'demo' }] }
    const baseGet = ctx.get
    ctx.get = (name) => (name === 'workspaceRegistry' ? registry : baseGet(name))
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    handleSubagentDispatch(rt, { agent: lead, childId: 'worker-cwd', args: { description: '规范化工作区' } }, NOW)

    assert.equal(state.tasks[0].cwd, 'C:\\work\\demo', '命中工作区注册表时用注册表的规范 path')
    assert.equal(workspacePathForCwd(ctx, 'C:\\WORK\\demo'), 'C:\\work\\demo')
    assert.equal(workspacePathForCwd(ctx, 'D:\\other'), 'D:\\other', '不属于任何工作区时原样保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dispatch from a non-lead preset never touches the board', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-preset-'))
  try {
    const state = createEmptyBoard()
    const { lead, ctx } = leadFixture({ preset: 'standard' })
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    const result = handleSubagentDispatch(rt, { agent: lead, childId: 'worker-std', args: { description: '普通会话派活' } }, NOW)

    assert.equal(result.created, false)
    assert.equal(result.reason, 'not-lead')
    assert.equal(state.tasks.length, 0)
    assert.equal(rt.leadAuto.skipped, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-completed worker keeps the task doing and records lastError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-error-'))
  try {
    const state = createEmptyBoard()
    const { lead, ctx } = leadFixture()
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    handleSubagentDispatch(rt, { agent: lead, childId: 'worker-err', args: { description: '会失败的活' } }, NOW)
    const outcome = await handleSubagentEnd(
      rt,
      { runId: 'run-err', provider: 'spawn', id: 'worker-err', local: true, stopReason: 'error', lastAssistantMessage: [{ type: 'text', text: 'boom' }] },
      NOW + 1000,
    )

    assert.equal(outcome.updated, false)
    const task = state.tasks[0]
    assert.equal(task.status, 'doing')
    assert.match(task.lastError, /worker 结束（error）：boom/)
    // 建议 6：非 completed 的 stopReason 只写任务 lastError，不装进 leadAuto.lastError（那只记挂钩自身异常）。
    assert.equal(rt.leadAuto.lastError, '', 'leadAuto.lastError 不装派发结果')
    assert.equal(rt.leadAuto.lastErrorAt, null)
    assert.equal(rt.leadAuto.completed, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing or unknown stopReason is never treated as completed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-noreason-'))
  try {
    const state = createEmptyBoard()
    const { lead, ctx } = leadFixture()
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    handleSubagentDispatch(rt, { agent: lead, childId: 'worker-noreason', args: { description: '没有 stopReason' } }, NOW)
    const outcome = await handleSubagentEnd(rt, { id: 'worker-noreason', lastAssistantMessage: [{ type: 'text', text: '半成品' }] }, NOW + 10)

    assert.equal(outcome.updated, false, '缺 stopReason 不能静默置 done')
    const task = state.tasks[0]
    assert.equal(task.status, 'doing', '任务保持 doing，等组长处理')
    assert.match(task.lastError, /worker 结束（unknown）：半成品/)
    assert.equal(task.result, '', '不写结论')
    assert.equal(rt.leadAuto.completed, 0)
    assert.equal(rt.leadAuto.lastError, '')

    // 未知值同理（例如未来新增的 stopReason）：一律按非 completed。
    const second = await handleSubagentEnd(rt, { id: 'worker-noreason', stopReason: 'weird-new-reason' }, NOW + 20)
    assert.equal(second.reason, 'worker-weird-new-reason')
    assert.equal(state.tasks[0].status, 'doing')
    assert.match(state.tasks[0].lastError, /worker 结束（weird-new-reason）：没有返回结论/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a polled task whose assignee is the worker id is never auto-completed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-polled-'))
  try {
    const state = createEmptyBoard()
    state.config = normalizeConfig({ mainSessionId: 'main-1' })
    const polled = addTask(state, { title: '轮询投递的任务', cwd: 'C:\\work\\demo' }, NOW)
    polled.status = 'doing'
    polled.dispatchedSessionId = 'lead-1'
    polled.notifiedAt = new Date(NOW).toISOString()
    polled.startedAt = new Date(NOW).toISOString()
    // 组长处理轮询任务时把 assignee 写成了 worker 会话 id（合法操作）。
    polled.assignee = 'worker-polled'
    const { lead, ctx } = leadFixture()
    const followups = []
    const mainAgent = {
      id: 'main-1',
      status: 'idle',
      session: { id: 'main-1', header: { cwd: 'C:\\work\\demo' } },
      followup: (message) => followups.push(message),
    }
    ctx.get = (name) => {
      if (name === 'agentPresets') return { presetForSession: () => 'taskboard-dispatch' }
      if (name === 'agents') {
        return { get: (id) => (id === 'main-1' ? mainAgent : id === 'lead-1' ? lead : undefined), roots: () => [lead] }
      }
      if (name === 'sessions') return { flush: async () => {} }
      return undefined
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    const outcome = await handleSubagentEnd(
      rt,
      { id: 'worker-polled', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'worker 说完成了' }] },
      NOW + 1000,
    )

    assert.equal(outcome.updated, false, '轮询任务不能被宿主自动 done')
    assert.equal(outcome.reason, 'no-task')
    assert.equal(polled.status, 'doing', '任务仍 doing，等组长取证审核')
    assert.equal(polled.result, '', '不替组长写结论')
    assert.equal(polled.reportedAt, null, '不发完成回执')
    assert.equal(followups.length, 0, '不 flush 回执给主会话')
    assert.equal(rt.leadAuto.completed, 0)
    assert.equal(rt.leadAuto.lastError, '')

    // 同一 worker 的结束不会误建任务、也不会改动轮询任务。
    assert.equal(findTaskByWorker(state, 'worker-polled'), null, 'findTaskByWorker 只认带 autoDispatch 标记的任务')
    assert.equal(state.tasks.length, 1)

    // 兜底判据：即使某条任务意外同时带标记和 notifiedAt（未来回写路径变了），也绝不被自动 done。
    const forced = addTask(state, { title: '带标记但 notifiedAt 非空', cwd: 'C:\\work\\demo' }, NOW)
    forced.status = 'doing'
    forced.assignee = 'worker-forced'
    forced.dispatchedSessionId = 'lead-1'
    forced.autoDispatch = LEAD_AUTO_MARK
    forced.notifiedAt = new Date(NOW).toISOString()
    const forcedOutcome = await handleSubagentEnd(rt, { id: 'worker-forced', stopReason: 'completed' }, NOW + 2000)
    assert.equal(forcedOutcome.reason, 'not-auto')
    assert.equal(forced.status, 'doing')
    assert.equal(forced.result, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a second end of the same worker only refreshes an already done result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-refresh-'))
  try {
    const state = createEmptyBoard()
    const { lead, ctx } = leadFixture()
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    handleSubagentDispatch(rt, { agent: lead, childId: 'worker-1', args: { description: '两轮结束' } }, NOW)
    await handleSubagentEnd(rt, { id: 'worker-1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '第一版' }] }, NOW + 10)
    const again = await handleSubagentEnd(rt, { id: 'worker-1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '第二版' }] }, NOW + 20)

    assert.equal(again.updated, true)
    assert.equal(again.refreshed, true, '第二次结束只刷 result')
    assert.equal(state.tasks[0].status, 'done')
    assert.match(state.tasks[0].result, /第二版/)
    assert.equal(state.tasks.length, 1)
    // 建议 7：只有真正的 doing→done 才计 completed；第二次结束只刷 result，不重复计数。
    assert.equal(rt.leadAuto.completed, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registerLeadAutoHooks covers the standard tool call and the PTC nested call alike', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-hooks-'))
  try {
    const state = createEmptyBoard()
    const { lead } = leadFixture()
    const listeners = {}
    const onCalls = []
    const ctx = {
      on: (name, listener, options) => {
        onCalls.push({ name, options })
        listeners[name] = listener
        return () => {
          delete listeners[name]
        }
      },
      get: (name) => (name === 'agentPresets' ? { presetForSession: () => 'taskboard-dispatch' } : undefined),
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    assert.equal(registerLeadAutoHooks(ctx, rt), true)
    assert.equal(rt.leadAuto.enabled, true)
    assert.equal(typeof listeners['tools/result'], 'function')
    assert.equal(typeof listeners['subagent/end'], 'function')
    // 必须断言第三参：假 ctx 丢掉 {global:true} 时测试仍会绿，真机却收不到事件（§4.6）。
    assert.deepEqual(
      onCalls.map((call) => call.name),
      ['tools/result', 'subagent/end'],
    )
    for (const call of onCalls) {
      assert.deepEqual(call.options, { global: true }, '两次 ctx.on 的第三参都必须是 {global:true}')
    }

    // 标准 tool-call：exec.agent / exec.arguments 来自普通工具调用。
    listeners['tools/result'](
      { name: 'subagent', agent: lead, arguments: { description: '标准 tool-call 派发', prompt: '干活' } },
      { isError: false, value: { kind: 'activation', subagentId: 'worker-std' }, content: [] },
    )
    assert.equal(state.tasks.length, 1)
    assert.equal(state.tasks[0].title, '标准 tool-call 派发')
    assert.equal(state.tasks[0].assignee, 'worker-std')

    // PTC（run_code）：程序化子调用走同一个 ToolExecutionPipeline，
    // exec 结构一致（callId 形如 "<callId>:ptc:1"，agent / arguments 都在），命中方式相同。
    listeners['tools/result'](
      { name: 'subagent', callId: 'call-1:ptc:1', rootCallId: 'call-1', agent: lead, arguments: { description: 'PTC 派发', prompt: '干活' } },
      { isError: false, value: { kind: 'activation', subagentId: 'worker-ptc' }, content: [] },
    )
    assert.equal(state.tasks.length, 2)
    assert.equal(state.tasks[1].title, 'PTC 派发')
    assert.equal(state.tasks[1].assignee, 'worker-ptc')

    // 失败的派发结果、没有 subagentId 的其它工具：都不建任务。
    listeners['tools/result']({ name: 'subagent', agent: lead, arguments: { description: '失败的派发' } }, { isError: true, content: [] })
    listeners['tools/result']({ name: 'read', agent: lead, arguments: {} }, { isError: false, value: { content: 'x' }, content: [] })
    assert.equal(state.tasks.length, 2)
    assert.equal(rt.leadAuto.skipped, 0, '非派发结果在监听器里就返回了，不计数')

    // subagent/end 收尾（emit 监听器是异步的，等一个 tick）。
    listeners['subagent/end']({
      runId: 'run-ptc',
      provider: 'spawn',
      id: 'worker-ptc',
      local: true,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'PTC worker 完成' }],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(state.tasks[1].status, 'done')
    assert.match(state.tasks[1].result, /PTC worker 完成/)
    assert.equal(state.tasks[0].status, 'doing', '只收尾对应 assignee 的任务')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the tools/result hook only fires on a successful subagent activation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-hit-'))
  try {
    const state = createEmptyBoard()
    const { lead } = leadFixture()
    const listeners = {}
    const ctx = {
      on: (name, listener) => {
        listeners[name] = listener
      },
      get: (name) => (name === 'agentPresets' ? { presetForSession: () => 'taskboard-dispatch' } : undefined),
    }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()
    assert.equal(registerLeadAutoHooks(ctx, rt), true)

    const ignored = [
      // 别的工具即使返回值里也带 subagentId，也不命中（只看 subagent 工具）。
      [{ name: 'workflow', agent: lead, arguments: {} }, { isError: false, value: { kind: 'activation', subagentId: 'w-other' } }],
      // kind 不是 activation（旧形状 / 未来形状）。
      [{ name: 'subagent', agent: lead, arguments: {} }, { isError: false, value: { subagentId: 'w-nokind' } }],
      [{ name: 'subagent', agent: lead, arguments: {} }, { isError: false, value: { kind: 'result', subagentId: 'w-kind' } }],
      // 空 / 空白 subagentId、没有 value。
      [{ name: 'subagent', agent: lead, arguments: {} }, { isError: false, value: { kind: 'activation', subagentId: '   ' } }],
      [{ name: 'subagent', agent: lead, arguments: {} }, { isError: false }],
      // 没有 exec / 没有调用方 Agent。
      [undefined, { isError: false, value: { kind: 'activation', subagentId: 'w-noexec' } }],
      [{ name: 'subagent', arguments: {} }, { isError: false, value: { kind: 'activation', subagentId: 'w-noagent' } }],
      // 失败的派发。
      [{ name: 'subagent', agent: lead, arguments: {} }, { isError: true, value: { kind: 'activation', subagentId: 'w-failed' } }],
    ]
    for (const [exec, result] of ignored) listeners['tools/result'](exec, result)
    assert.equal(state.tasks.length, 0, '以上都不建任务（命中条件收紧）')
    assert.equal(rt.leadAuto.skipped, 0, '监听器入口就返回，不计数（§3.2 的 skipped 口径）')

    // 真正的成功派发才建任务。
    listeners['tools/result'](
      { name: 'subagent', agent: lead, arguments: { description: '真正的派发' } },
      { isError: false, value: { kind: 'activation', subagentId: 'worker-ok' }, content: [] },
    )
    assert.equal(state.tasks.length, 1)
    assert.equal(state.tasks[0].assignee, 'worker-ok')
    assert.equal(state.tasks[0].autoDispatch, LEAD_AUTO_MARK)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an auto task that goes back to the queue loses its autoDispatch marker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-requeue-'))
  try {
    const state = createEmptyBoard()
    const { lead, ctx } = leadFixture()
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = createLeadAutoState()

    handleSubagentDispatch(rt, { agent: lead, childId: 'worker-a', args: { description: '会被打回' } }, NOW)
    handleSubagentDispatch(rt, { agent: lead, childId: 'worker-b', args: { description: '组长归档重排' } }, NOW)
    const [first, second] = state.tasks
    assert.equal(first.autoDispatch, LEAD_AUTO_MARK)
    assert.equal(second.autoDispatch, LEAD_AUTO_MARK)

    // 组长打回 / 人工回退 todo：重新排队后由轮询投递，不再是「宿主自动任务」。
    applyTaskUpdate(state, first.id, { status: 'todo' }, NOW + 10)
    assert.equal(first.autoDispatch, null)
    assert.equal(first.assignee, '')

    // 组长会话归档兜底的重排同样清标记。
    requeueTasksOfLead(state, 'lead-1', NOW + 20)
    assert.equal(second.autoDispatch, null)
    assert.equal(findTaskByWorker(state, 'worker-b'), null)

    // 之后同一个 worker 再结束也不会被自动 done。
    const outcome = await handleSubagentEnd(rt, { id: 'worker-b', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '完成' }] }, NOW + 30)
    assert.equal(outcome.updated, false)
    assert.equal(second.status, 'todo')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('leadTaskTitle falls back from description to the prompt first line to the worker id', () => {
  assert.equal(leadTaskTitle({ description: '修 X' }, 'w-1'), '修 X')
  assert.equal(leadTaskTitle({ prompt: '\n# 把 Y 改成 Z\n细节' }, 'w-1'), '把 Y 改成 Z')
  assert.equal(leadTaskTitle({}, 'worker-abcdefgh'), 'worker abcdefgh')
  assert.equal(leadTaskTitle({ prompt: '只有 prompt' }, 'w-1'), '只有 prompt')
})

test('workerResultText keeps text blocks only and subagentPromptText accepts blocks', () => {
  assert.equal(
    workerResultText({ lastAssistantMessage: [{ type: 'text', text: 'A' }, { type: 'image', url: 'x' }, { type: 'text', text: 'B' }] }),
    'A\nB',
  )
  assert.equal(workerResultText({}), '')
  assert.equal(subagentPromptText({ prompt: [{ type: 'text', text: 'X' }, { type: 'text', text: 'Y' }] }), 'X\nY')
  assert.equal(subagentPromptText({ prompt: 'plain' }), 'plain')
  assert.equal(subagentPromptText(null), '')
  assert.equal(firstDispatchLine('***\n## 标题\n正文'), '标题')
})

test('snapshot exposes the leadAuto runtime counters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-lead-auto-snap-'))
  try {
    const state = createEmptyBoard()
    const ctx = { get: () => undefined }
    const rt = fakeRuntime(state, ctx, join(dir, 'board.json'))
    rt.leadAuto = { enabled: true, created: 2, lastError: 'boom', lastTaskId: 't-9' }

    const snapshot = buildSnapshot(rt, NOW)
    assert.equal(snapshot.leadAuto.enabled, true)
    assert.equal(snapshot.leadAuto.created, 2)
    assert.equal(snapshot.leadAuto.deduped, 0)
    assert.equal(snapshot.leadAuto.completed, 0)
    assert.equal(snapshot.leadAuto.lastError, 'boom')
    assert.equal(snapshot.leadAuto.lastTaskId, 't-9')
    assert.equal(snapshot.leadAuto.lastErrorAt, null)

    // 没有 leadAuto 的老 runtime 也要能出快照；normalizeLeadAuto 对缺字段给出默认值。
    const legacy = fakeRuntime(state, ctx, join(dir, 'board.json'))
    const legacySnapshot = buildSnapshot(legacy, NOW)
    assert.equal(legacySnapshot.leadAuto.enabled, false)
    assert.deepEqual(normalizeLeadAuto(undefined), {
      enabled: false,
      created: 0,
      deduped: 0,
      completed: 0,
      skipped: 0,
      lastError: '',
      lastErrorAt: null,
      lastTaskId: null,
      lastWorkerSessionId: null,
      updatedAt: null,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ══════════════════════════════════════════════════════════════
 * v0.2.0 粘贴图片附件（§2.1：上传成功 / 非法 MIME / 超限 /
 * 路径穿越 / 未知 id / 非 loopback / 附件服务复用）
 * ══════════════════════════════════════════════════════════════ */

/** 1x1 透明 PNG（真实 PNG 文件头，用来过 magic-byte 校验）。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lp3J8QAAAABJRU5ErkJggg=='
const PNG_DATA_URL = 'data:image/png;base64,' + PNG_BASE64
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function attachmentTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-taskboard-attachments-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function isBoardError(code) {
  return (error) => {
    assert.ok(error instanceof BoardError, 'error must be a BoardError, got ' + String(error && error.message))
    assert.equal(error.code, code)
    return true
  }
}

function fakeAttachmentService() {
  const objects = new Map()
  let sequence = 0
  return {
    async saveImages(inputs) {
      sequence += 1
      return inputs.map((input) => {
        const ref = {
          attachmentId: 'sha256:' + String(sequence).padStart(64, '0'),
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
        }
        objects.set(ref.attachmentId, Buffer.from(input.data))
        return ref
      })
    },
    async readImage(ref) {
      return { ref, data: objects.get(ref.attachmentId) }
    },
  }
}

test('attachmentsDir defaults below storages/dsh-taskboard and honors DSH_TASKBOARD_PATH', () => {
  const previous = process.env.DSH_TASKBOARD_PATH
  try {
    delete process.env.DSH_TASKBOARD_PATH
    const path = attachmentsDir()
    assert.match(path, /storages[\\/]dsh-taskboard[\\/]attachments$/)
    assert.equal(attachmentRef('abc'), 'attachment://abc')
    assert.ok(MAX_UPLOAD_BODY_BYTES > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4, 'upload body limit covers base64 expansion')

    process.env.DSH_TASKBOARD_PATH = join(tmpdir(), 'dsh-taskboard-isolated', 'board.json')
    assert.equal(attachmentsDir(), join(tmpdir(), 'dsh-taskboard-isolated', 'attachments'))
  } finally {
    if (previous === undefined) delete process.env.DSH_TASKBOARD_PATH
    else process.env.DSH_TASKBOARD_PATH = previous
  }
})

test('saveAttachment stores a pasted PNG locally; readAttachment returns the same data URL', async (t) => {
  const dir = attachmentTempDir(t)
  const saved = await saveAttachment(PNG_DATA_URL, { dir, name: 'shot.png', now: NOW })
  assert.match(saved.id, UUID_PATTERN)
  assert.equal(saved.ref, 'attachment://' + saved.id)
  assert.equal(saved.mime, 'image/png')
  assert.ok(saved.size > 0)
  assert.equal(saved.name, 'shot.png')

  const index = loadAttachmentIndex(dir)
  const entry = index[saved.id]
  assert.ok(entry, 'index must contain the new attachment')
  assert.equal(entry.backend, 'local')
  assert.ok(existsSync(join(dir, entry.file)), 'attachment bytes must be stored under the attachment dir')

  const read = await readAttachment(saved.id, { dir })
  assert.equal(read.id, saved.id)
  assert.equal(read.mime, 'image/png')
  assert.equal(read.size, saved.size)
  assert.equal(read.dataUrl, PNG_DATA_URL, 'read must round-trip the exact data URL / bytes')
})

test('upload rejects non-image / unsupported MIME, MIME-mismatched bytes and malformed data URLs', async (t) => {
  const dir = attachmentTempDir(t)
  for (const dataUrl of [
    'data:text/plain;base64,aGVsbG8=',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/jpg;base64,' + PNG_BASE64,
    'data:image/png;base64,not-base64!!',
    'not-a-data-url',
    '',
  ]) {
    await assert.rejects(saveAttachment(dataUrl, { dir }), isBoardError('bad-request'))
  }
  // 声明 jpeg、实际文件头也必须是 jpeg；再拿短到只有文件头的 jpeg 验证 magic-byte 通过。
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64')
  const savedJpeg = await saveAttachment('data:image/jpeg;base64,' + jpeg, { dir })
  assert.equal(savedJpeg.mime, 'image/jpeg')
  // 声明 png、实际是 jpeg 文件头：magic bytes 与 MIME 不一致。
  await assert.rejects(saveAttachment('data:image/png;base64,' + jpeg, { dir }), (error) => {
    assert.ok(error instanceof BoardError)
    assert.equal(error.code, 'bad-request')
    assert.match(error.message, /文件头|内容与声明类型|无法识别/)
    return true
  })
  // svg / text / image/jpg 不是白名单 MIME——应在上传入口被拒，不落盘。
  assert.equal(Object.keys(loadAttachmentIndex(dir)).length, 1, 'only the valid jpeg upload is indexed')
})

test('upload rejects images above the 5 MB decoded limit', async (t) => {
  const dir = attachmentTempDir(t)
  const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)
  // 文件头是合法 PNG，确保拒绝原因落在大小上而不是类型上。
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversized)
  const dataUrl = 'data:image/png;base64,' + oversized.toString('base64')
  await assert.rejects(saveAttachment(dataUrl, { dir }), (error) => {
    assert.ok(error instanceof BoardError)
    assert.equal(error.code, 'bad-request')
    assert.match(error.message, /5 MB|大小上限/)
    return true
  })
  assert.equal(Object.keys(loadAttachmentIndex(dir)).length, 0, 'oversized image must not be indexed')
})

test('readAttachment rejects path traversal and unknown ids with unified error codes', async (t) => {
  const dir = attachmentTempDir(t)
  // id 只接受 UUID：任何路径片段 / 协议前缀都在拼路径之前被 bad-request 挡掉。
  for (const bad of [
    '../../board.json',
    '..\\..\\board.json',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'sha256:' + 'a'.repeat(64),
    'not-a-uuid',
  ]) {
    await assert.rejects(readAttachment(bad, { dir }), isBoardError('bad-request'))
  }
  // 格式合法但索引里没有：not-found（不泄漏文件系统信息）。
  await assert.rejects(readAttachment(randomUUID(), { dir }), isBoardError('not-found'))
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '10.0.0.5' }, headers: {} }), false)

  // 索引即使被篡改成 ../ 路径，也不会读到附件目录之外：文件名白名单 + 前缀校验 → internal。
  const id = randomUUID()
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({ version: 1, entries: { [id]: { id, backend: 'local', mime: 'image/png', file: '../evil.png' } } }),
  )
  await assert.rejects(readAttachment(id, { dir }), isBoardError('internal'))
})

test('readAttachment reports a corrupt index as internal and a missing file as not-found', async (t) => {
  const dir = attachmentTempDir(t)
  writeFileSync(join(dir, 'index.json'), '{ not json')
  await assert.rejects(readAttachment(randomUUID(), { dir }), isBoardError('internal'))

  writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, entries: {} }))
  const saved = await saveAttachment(PNG_DATA_URL, { dir })
  rmSync(join(dir, loadAttachmentIndex(dir)[saved.id].file))
  await assert.rejects(readAttachment(saved.id, { dir }), isBoardError('not-found'))
})

test('note attachment references are capped at 8 distinct ids', () => {
  const ids = Array.from({ length: MAX_TASK_ATTACHMENTS }, () => randomUUID())
  const note = ids.map((id) => `![image](attachment://${id})`).join('\n')
  assert.equal(countAttachmentRefs(note), MAX_TASK_ATTACHMENTS)
  assert.doesNotThrow(() => assertNoteAttachments(note))
  // 同一 id 重复出现只算一个，不应误报。
  assert.equal(countAttachmentRefs(note + '\n![image](attachment://' + ids[0] + ')'), MAX_TASK_ATTACHMENTS)
  assert.doesNotThrow(() => assertNoteAttachments(note + '\n![image](attachment://' + ids[0] + ')'))
  // 普通文本 / 无效引用不计数。
  assert.equal(countAttachmentRefs('![image](attachment://not-a-uuid)'), 0)
  assert.equal(countAttachmentRefs('没有引用'), 0)
  const tooMany = note + '\n![image](attachment://' + randomUUID() + ')'
  assert.throws(() => assertNoteAttachments(tooMany), isBoardError('bad-request'))
})

test('saveAttachment prefers the DSH attachment service and readAttachment reads it back', async (t) => {
  const dir = attachmentTempDir(t)
  const service = fakeAttachmentService()
  const saved = await saveAttachment(PNG_DATA_URL, { dir, attachmentsService: service, name: 'from-service.png' })
  const entry = loadAttachmentIndex(dir)[saved.id]
  assert.equal(entry.backend, 'dsh')
  assert.match(entry.ref.attachmentId, /^sha256:[a-f0-9]{64}$/)

  const read = await readAttachment(saved.id, { dir, attachmentsService: service })
  assert.equal(read.mime, 'image/png')
  assert.equal(read.dataUrl, PNG_DATA_URL)
  // 服务不可用时，已存到服务的附件读取报 internal（不会静默回退到本机路径）。
  await assert.rejects(readAttachment(saved.id, { dir }), isBoardError('internal'))
})

test('saveAttachment maps attachment-service admission failures to bad-request', async (t) => {
  const dir = attachmentTempDir(t)
  const failing = {
    async saveImages() {
      const error = new Error('image type refused')
      error.code = 'UNSUPPORTED_IMAGE_TYPE'
      throw error
    },
  }
  await assert.rejects(saveAttachment(PNG_DATA_URL, { dir, attachmentsService: failing }), isBoardError('bad-request'))
})

test('sniffImageMime / decodeImageDataUrl accept the four whitelisted raster formats', () => {
  const gif = Buffer.from('GIF89a' + '\u0000'.repeat(8), 'binary')
  const webp = Buffer.from('RIFF' + '\u0000'.repeat(4) + 'WEBP', 'binary')
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  const png = Buffer.from(PNG_BASE64, 'base64')
  assert.equal(sniffImageMime(png), 'image/png')
  assert.equal(sniffImageMime(jpeg), 'image/jpeg')
  assert.equal(sniffImageMime(gif), 'image/gif')
  assert.equal(sniffImageMime(webp), 'image/webp')
  assert.equal(sniffImageMime(Buffer.from('hello')), '')
  assert.deepEqual(ATTACHMENT_MEDIA_TYPES, ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  const decoded = decodeImageDataUrl(PNG_DATA_URL)
  assert.equal(decoded.mime, 'image/png')
  assert.ok(decoded.bytes.length > 0)
})


/* ══════════════════════════════════════════════════════════════
 * t-34 收尾：note 截断不切坏附件引用 / 请求体上限只放宽 upload 端点 /
 * handleHttp 405·415·403
 * ══════════════════════════════════════════════════════════════ */

const REF_ID_A = '11111111-1111-4111-8111-111111111111'
const REF_ID_B = '22222222-2222-4222-8222-222222222222'
const REF_A = '![image](attachment://' + REF_ID_A + ')'

test('truncateNote：4000 字符截断不切出半截 attachment:// 引用', () => {
  // 短文本原样返回（只 trim）
  assert.equal(truncateNote('  验收标准  '), '验收标准')
  assert.equal(truncateNote(''), '')
  assert.equal(truncateNote(null), '')

  // 无引用的长文本：普通截断
  assert.equal(truncateNote('x'.repeat(5000)).length, 4000)

  // 截断点落在引用 URL 中间：整个引用丢掉，不留 `attachment:/` 半截
  const cutInUrl = 'x'.repeat(3990) + REF_A
  assert.equal(truncateNote(cutInUrl), 'x'.repeat(3990))
  assert.equal(truncateNote(cutInUrl).includes('attachment'), false)

  // 截断点落在引用开头（`![ima`）：半截图片语法也不留
  assert.equal(truncateNote('x'.repeat(3995) + REF_A), 'x'.repeat(3995))

  // 完整引用在 4000 以内：保留引用，只砍掉后面的文字
  const keepRef = 'x'.repeat(4000 - REF_A.length) + REF_A + 'tail'
  assert.equal(truncateNote(keepRef), 'x'.repeat(4000 - REF_A.length) + REF_A)

  // 裸协议前缀被切半（没有图片语法）：也不留 `attachmen`
  const cutBare = 'x'.repeat(3990) + 'see attachment://' + REF_ID_B
  const truncatedBare = truncateNote(cutBare)
  assert.equal(truncatedBare.includes('attachment'), false)
  assert.ok(truncatedBare.length <= 4000)
  assert.ok(truncatedBare.startsWith('x'.repeat(3990) + 'see'))
})

test('truncateNote：裸 attachment:// 的 UUID 被切断也整段清掉，完整 UUID 保留', () => {
  // 前缀完整、UUID 被切半：不留 `attachment://2222…-42` 这种坏链接
  const cutId = 'x'.repeat(3970) + 'see attachment://' + REF_ID_B
  const truncated = truncateNote(cutId)
  assert.equal(truncated, 'x'.repeat(3970) + 'see')
  assert.equal(truncated.includes('attachment'), false)

  // 完整裸引用落在 4000 以内：照常保留（只砍后面的文字）
  const keepBare = 'x'.repeat(4000 - 13 - REF_ID_B.length) + 'attachment://' + REF_ID_B + 'tail'
  assert.equal(truncateNote(keepBare), 'x'.repeat(4000 - 13 - REF_ID_B.length) + 'attachment://' + REF_ID_B)

  // add-task / update-task 同口径：note 里不出现半截 id
  const state = createEmptyBoard()
  const task = addTask(state, { title: '裸引用截断', note: cutId })
  assert.equal(task.note.includes('attachment'), false)
  applyTaskUpdate(state, task.id, { result: cutId })
  assert.equal(task.result.includes('attachment'), false)
})

test('addTask / applyTaskUpdate / normalizeBoard 的 note·result 截断复用 truncateNote', () => {
  const state = createEmptyBoard()
  const longNote = 'x'.repeat(3995) + REF_A
  const task = addTask(state, { title: '长备注', note: longNote })
  assert.equal(task.note, 'x'.repeat(3995), 'addTask must not leave half an attachment ref')

  applyTaskUpdate(state, task.id, { note: longNote })
  assert.equal(task.note, 'x'.repeat(3995), 'update-task note keeps the same truncation口径')
  applyTaskUpdate(state, task.id, { result: longNote })
  assert.equal(task.result, 'x'.repeat(3995), 'result keeps the same truncation口径')

  const normalized = normalizeBoard({ version: 1, nextId: 10, tasks: [{ id: 't-9', title: 't', note: longNote, result: longNote }] })
  assert.equal(normalized.state.tasks[0].note, 'x'.repeat(3995))
  assert.equal(normalized.state.tasks[0].result, 'x'.repeat(3995))
})

test('bodyLimitFor：只有 upload-attachment 放宽到约 7 MB，其它端点仍是 512 KB', () => {
  assert.equal(MAX_BODY_BYTES, 512 * 1024)
  assert.equal(bodyLimitFor('upload-attachment'), MAX_UPLOAD_BODY_BYTES)
  assert.ok(bodyLimitFor('upload-attachment') > MAX_BODY_BYTES)
  for (const endpoint of ['snapshot', 'add-task', 'update-task', 'attachment', 'session-info', '']) {
    assert.equal(bodyLimitFor(endpoint), MAX_BODY_BYTES, 'endpoint must keep the 512 KB limit: ' + endpoint)
  }
})

function fakeHttpRequest(options = {}) {
  const handlers = {}
  return {
    method: options.method || 'POST',
    url: options.url || '/taskboard/snapshot',
    headers: options.headers || { 'content-type': 'application/json' },
    socket: { remoteAddress: options.remoteAddress || '127.0.0.1' },
    on(event, handler) {
      handlers[event] = handlers[event] || []
      handlers[event].push(handler)
      return this
    },
    destroy() {},
  }
}

function fakeHttpResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(text) {
      this.body = text === undefined ? '' : String(text)
    },
  }
}

test('handleHttp：非 POST → 405，非 JSON → 415，非 loopback → 403', async () => {
  const rt = { ctx: { get: () => undefined }, state: createEmptyBoard(), filePath: join(tmpdir(), 'dsh-taskboard-http-none.json') }

  const getRes = fakeHttpResponse()
  await handleHttp(rt, fakeHttpRequest({ method: 'GET' }), getRes)
  assert.equal(getRes.statusCode, 405)
  assert.match(getRes.body, /method not allowed/)

  const putRes = fakeHttpResponse()
  await handleHttp(rt, fakeHttpRequest({ method: 'PUT' }), putRes)
  assert.equal(putRes.statusCode, 405)

  const textRes = fakeHttpResponse()
  await handleHttp(rt, fakeHttpRequest({ headers: { 'content-type': 'text/plain' } }), textRes)
  assert.equal(textRes.statusCode, 415)
  assert.match(textRes.body, /expected application\/json/)

  const remoteRes = fakeHttpResponse()
  await handleHttp(rt, fakeHttpRequest({ remoteAddress: '203.0.113.7' }), remoteRes)
  assert.equal(remoteRes.statusCode, 403)
  assert.match(remoteRes.body, /loopback only/)
})

/** 带请求体的假 req：handleHttp 在第一个 await 前就挂好 data/end 监听，随后手动喂 body。 */
function fakeHttpRequestWithBody(options, bodyText) {
  const handlers = {}
  const req = fakeHttpRequest(options)
  req.on = function on(event, handler) {
    handlers[event] = handlers[event] || []
    handlers[event].push(handler)
    return req
  }
  req.send = function send() {
    for (const handler of handlers.data || []) handler(Buffer.from(bodyText))
    for (const handler of handlers.end || []) handler()
  }
  req.destroy = function destroy() {
    // 真实 req 在这里会被 socket.destroy()；测试里吞掉，响应仍可写出。
  }
  return req
}

test('handleHttp：512 KB 上限对普通端点生效，upload-attachment 允许更大的请求体', async () => {
  const rt = { ctx: { get: () => undefined }, state: createEmptyBoard(), filePath: join(tmpdir(), 'dsh-taskboard-http-none.json') }
  const envelope = (method, payload) => JSON.stringify({ type: 'client-request', rpcId: 'x', method, payload })
  const bigPadding = 'a'.repeat(600 * 1024)

  // 普通端点：600 KB 超过 512 KB → 体量错误（不是网络错误）
  const snapshotReq = fakeHttpRequestWithBody({ url: '/taskboard/snapshot' }, envelope('snapshot', { padding: bigPadding }))
  const snapshotRes = fakeHttpResponse()
  const snapshotPending = handleHttp(rt, snapshotReq, snapshotRes)
  snapshotReq.send()
  await snapshotPending
  const snapshotBody = JSON.parse(snapshotRes.body)
  assert.equal(snapshotBody.result.ok, false)
  assert.equal(snapshotBody.result.error.code, 'bad-request')
  assert.match(snapshotBody.result.error.message, /请求体超过 524288 字节/)

  // upload-attachment：同样 600 KB 不会被 512 KB 上限拦下，进到 dataUrl 校验（bad-request 但不是体量错误）
  const uploadReq = fakeHttpRequestWithBody(
    { url: '/taskboard/upload-attachment' },
    envelope('upload-attachment', { dataUrl: '', padding: bigPadding }),
  )
  const uploadRes = fakeHttpResponse()
  const uploadPending = handleHttp(rt, uploadReq, uploadRes)
  uploadReq.send()
  await uploadPending
  const uploadBody = JSON.parse(uploadRes.body)
  assert.equal(uploadBody.result.ok, false)
  assert.equal(uploadBody.result.error.code, 'bad-request')
  assert.doesNotMatch(uploadBody.result.error.message, /请求体超过/)
})