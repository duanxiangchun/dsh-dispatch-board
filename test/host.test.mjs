import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BoardError,
  STATUSES,
  addTask,
  applyTaskUpdate,
  archiveDoneTasks,
  boardPath,
  buildDispatchText,
  buildSnapshot,
  canTransition,
  commitBoard,
  createBoardUserMessage,
  createEmptyBoard,
  deleteTask,
  endpointFromUrl,
  findTask,
  hostnameOfHostHeader,
  inspectPresets,
  isLoopbackRequest,
  normalizeBoard,
  normalizeConfig,
  normalizeConfig as normalizeConfigAlias,
  reloadBoardIfStale,
  notifyCooldownMs,
  parseRpcEnvelope,
  listWorkspaces,
  normalizePathForCompare,
  workspaceIdForCwd,
  resolveSessionCwd,
  resolveSessionCwdViaQuery,
  tick,
  resolveTargetAgent,
  selectDispatchCandidate,
} from '../lib/index.js'

const NOW = Date.parse('2026-11-11T02:00:00.000Z')

function boardWith(...titles) {
  const state = createEmptyBoard()
  for (const title of titles) addTask(state, { title }, NOW)
  return state
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
              { id: 'taskboard-dispatch', name: '派单看板模式', description: 'x' },
              { id: 'taskboard-worker', name: '执行者' },
            ],
          }
        : undefined,
  })
  assert.equal(healthy.installed, true)
  assert.equal(healthy.broken, '')
  assert.equal(healthy.presets.length, 2)
  assert.equal(healthy.presets[0].name, '派单看板模式')
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
test('normalizeConfig defaults dispatchMode to new and validates values', () => {
  assert.equal(normalizeConfig({}).dispatchMode, 'new')
  assert.equal(normalizeConfig({ dispatchMode: 'creator' }).dispatchMode, 'creator')
  assert.equal(normalizeConfig({ dispatchMode: 'auto' }).dispatchMode, 'auto')
  assert.equal(normalizeConfig({ dispatchMode: 'bogus' }).dispatchMode, 'new')
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
