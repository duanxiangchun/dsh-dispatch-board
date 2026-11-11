import test from 'node:test'
import assert from 'node:assert/strict'

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
  notifyCooldownMs,
  parseRpcEnvelope,
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
