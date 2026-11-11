/**
 * dsh-taskboard —— Host 半（Cordis 插件，ESM，无构建）。
 *
 * 单一 Loader 行（见 cordis.patch.yml）挂载本模块，职责：
 *  1. 在 webServer 上注册 /taskboard 前缀路由，用 Connection RPC 信封
 *     （{type:'client-request', rpcId, method, payload} → {type:'server-response', rpcId, result}）
 *     给浏览器端提供 snapshot / add-task / update-task / delete-task / dispatch-now /
 *     set-config / archive-done / install-preset 八个端点；
 *  2. 持久化任务看板到 $DSH_HOME/storages/dsh-taskboard/board.json（原子写）；
 *  3. 轮询「待开始」列：命中且目标主 Agent 空闲时，用 agent.followup() 推一条【任务看板】消息，
 *     主 Agent 据此派发子 Agent（本插件不直接起子 Agent——派单是主 Agent 的职责）；
 *  4. 注册三个面向模型的工具：taskboard_list / taskboard_add / taskboard_update；
 *  5. 插件 bundle 自带两个模式声明（presets/taskboard.patch.yml 里的
 *     @deepseek-ai/dsh-agent-preset 行：taskboard-dispatch 主 + taskboard-worker 执行者），
 *     随 Loader 组合加载；本文件只从 agentPresets 注册表读回实时状态给 UI。
 *
 * 本文件顶层只 import node: 内建模块，不 import 任何 @deepseek-ai/*。
 * 原因：外部插件包的 profile node_modules 里没有 dsh-tools / dsh-llm，
 * 需要的数据结构（UserMessage / 工具定义）在本文件内手工构造（见 createBoardUserMessage）。
 * 这样也保证 node --test 能在没有 DSH 进程时直接 import 本文件做纯函数单测。
 *
 * 契约（字段/端点/状态机）以 docs/architecture.md 为唯一事实来源。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'taskboard'

/**
 * 只有 timer 是硬依赖（轮询定时器）。
 * webServer 用 ctx.inject(['webServer'], cb) 等它就绪——这样插件在非 Web profile 里也照常
 * 加载（看板工具与轮询可用，只是没有浏览器路由），而不是整包静默 PENDING 不加载。
 */
export const inject = ['timer']

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const PACKAGE_NAME = 'dsh-taskboard'
const RPC_CHANNEL = '/taskboard'
const BOARD_VERSION = 1
const STORAGE_DIRNAME = 'dsh-taskboard'
const BOARD_FILENAME = 'board.json'
const MAX_BODY_BYTES = 512 * 1024
const MIN_POLL_INTERVAL_MS = 5000
const MAX_POLL_INTERVAL_MS = 300000
const DEFAULT_POLL_INTERVAL_MS = 15000
const DEFAULT_MAX_NOTIFICATIONS = 5
const MAX_NOTE_CHARS = 4000
const MAX_TITLE_CHARS = 200

/** 看板四列。顺序即 UI 列顺序。 */
export const STATUSES = ['todo', 'doing', 'done', 'archived']

/** 合法状态迁移（含原地更新）。轮询只扫 todo。 */
const TRANSITIONS = {
  todo: ['todo', 'doing', 'archived'],
  doing: ['doing', 'done', 'todo', 'archived'],
  done: ['done', 'archived', 'doing', 'todo'],
  archived: ['archived', 'todo'],
}

/** 预设状态缓存时长：registry.list() 会重新审计挂载树，别在每个 2s 快照里都跑。 */
const PRESET_CACHE_MS = 15000

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/** 统一错误：带稳定 code，HTTP 层转成 RPC error 信封。 */
export class BoardError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BoardError'
    this.code = code
    this.details = details
  }
}

function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function trimmed(value, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** $DSH_HOME：优先环境变量，缺省 ~/.dsh（与 dsh-ollama-statistical 的做法一致）。 */
export function resolveDshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

export function boardPath() {
  return join(resolveDshHome(), 'storages', STORAGE_DIRNAME, BOARD_FILENAME)
}

/** 原子写 JSON：tmp + rename。失败抛给调用方，由调用方决定降级。 */
export function writeJsonAtomic(filePath, value) {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, filePath)
}

function readJsonFile(filePath) {
  try {
    const text = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 看板状态：构造 / 规范化 / 落盘
 * ------------------------------------------------------------------ */

export function createEmptyBoard() {
  return {
    version: BOARD_VERSION,
    nextId: 1,
    revision: 0,
    updatedAt: iso(Date.now()),
    config: {
      pollEnabled: true,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      maxNotifications: DEFAULT_MAX_NOTIFICATIONS,
    },
    tasks: [],
  }
}

export function normalizeConfig(raw) {
  const config = isPlainObject(raw) ? raw : {}
  const interval = Number(config.pollIntervalMs)
  const maxNotifications = Number(config.maxNotifications)
  return {
    pollEnabled: config.pollEnabled !== false,
    pollIntervalMs:
      Number.isFinite(interval) && interval >= MIN_POLL_INTERVAL_MS && interval <= MAX_POLL_INTERVAL_MS
        ? Math.round(interval)
        : DEFAULT_POLL_INTERVAL_MS,
    maxNotifications:
      Number.isFinite(maxNotifications) && maxNotifications >= 1 && maxNotifications <= 50
        ? Math.round(maxNotifications)
        : DEFAULT_MAX_NOTIFICATIONS,
  }
}

function normalizeTask(raw, index) {
  if (!isPlainObject(raw)) return null
  const status = STATUSES.includes(raw.status) ? raw.status : 'todo'
  const title = trimmed(raw.title, MAX_TITLE_CHARS)
  if (title === '') return null
  const id = trimmed(raw.id, 40) || 't-' + String(index + 1)
  return {
    id,
    title,
    note: trimmed(raw.note, MAX_NOTE_CHARS),
    status,
    source: raw.source === 'agent' ? 'agent' : 'user',
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
    cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : null,
    assignee: trimmed(raw.assignee, 200),
    result: trimmed(raw.result, MAX_NOTE_CHARS),
    createdAt: asString(raw.createdAt) || iso(Date.now()),
    updatedAt: asString(raw.updatedAt) || asString(raw.createdAt) || iso(Date.now()),
    startedAt: asString(raw.startedAt) || null,
    finishedAt: asString(raw.finishedAt) || null,
    archivedAt: asString(raw.archivedAt) || null,
    notifiedAt: asString(raw.notifiedAt) || null,
    notificationCount: Number.isFinite(Number(raw.notificationCount)) ? Math.max(0, Math.round(Number(raw.notificationCount))) : 0,
    lastError: trimmed(raw.lastError, 500),
  }
}

/** 把磁盘上的原始值规范化成可信状态；坏任务被丢弃并计入 dropped。 */
export function normalizeBoard(raw) {
  if (!isPlainObject(raw)) return { state: createEmptyBoard(), dropped: 0 }
  const state = createEmptyBoard()
  state.config = normalizeConfig(raw.config)
  const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : []
  const tasks = []
  const seen = new Set()
  for (let i = 0; i < rawTasks.length; i++) {
    const task = normalizeTask(rawTasks[i], i)
    if (!task || seen.has(task.id)) continue
    seen.add(task.id)
    tasks.push(task)
  }
  state.tasks = tasks
  let maxId = 0
  for (const task of tasks) {
    const match = /^t-(\d+)$/.exec(task.id)
    if (match) maxId = Math.max(maxId, Number(match[1]))
  }
  const rawNext = Number(raw.nextId)
  state.nextId = Math.max(Number.isFinite(rawNext) ? Math.round(rawNext) : 1, maxId + 1, 1)
  const rawRev = Number(raw.revision)
  state.revision = Number.isFinite(rawRev) ? Math.max(0, Math.round(rawRev)) : 0
  state.updatedAt = asString(raw.updatedAt) || iso(Date.now())
  return { state, dropped: rawTasks.length - tasks.length }
}

/** 读板；坏文件改名保留现场后从空板开始。 */
export function loadBoardFromDisk(filePath = boardPath()) {
  if (!existsSync(filePath)) return { state: createEmptyBoard(), warnings: [] }
  const parsed = readJsonFile(filePath)
  if (!parsed) {
    const backup = filePath + '.corrupt-' + Date.now()
    try {
      renameSync(filePath, backup)
    } catch {
      /* 留不住现场也不阻塞启动 */
    }
    return { state: createEmptyBoard(), warnings: ['board.json 解析失败，已备份到 ' + backup] }
  }
  const { state, dropped } = normalizeBoard(parsed)
  const warnings = dropped > 0 ? [String(dropped) + ' 个任务记录不合法已丢弃'] : []
  return { state, warnings }
}

/** 提交变更：revision+1、updatedAt、落盘。写盘失败不抛（内存仍是真源）。 */
export function commitBoard(state, filePath = boardPath()) {
  state.revision = (Number(state.revision) || 0) + 1
  state.updatedAt = iso(Date.now())
  try {
    writeJsonAtomic(filePath, state)
    return { saved: true }
  } catch (error) {
    console.warn('[taskboard] 看板写盘失败：' + describeError(error))
    return { saved: false, error: describeError(error) }
  }
}

/* ------------------------------------------------------------------ *
 * 任务操作（纯函数，便于单测）
 * ------------------------------------------------------------------ */

export function findTask(state, id) {
  const target = trimmed(id, 40)
  if (target === '') throw new BoardError('bad-request', '缺少任务 id')
  const task = state.tasks.find((item) => item.id === target)
  if (!task) throw new BoardError('not-found', '任务不存在：' + target, { id: target })
  return task
}

export function nextTaskId(state) {
  const id = 't-' + state.nextId
  state.nextId += 1
  return id
}

export function addTask(state, input, now = Date.now()) {
  if (!isPlainObject(input)) throw new BoardError('bad-request', '参数必须是对象')
  const title = trimmed(input.title, MAX_TITLE_CHARS)
  if (title === '') throw new BoardError('bad-request', '标题不能为空')
  const stamp = iso(now)
  const task = {
    id: nextTaskId(state),
    title,
    note: trimmed(input.note, MAX_NOTE_CHARS),
    status: 'todo',
    source: input.source === 'agent' ? 'agent' : 'user',
    sessionId: typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null,
    cwd: typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : null,
    assignee: '',
    result: '',
    createdAt: stamp,
    updatedAt: stamp,
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    notifiedAt: null,
    notificationCount: 0,
    lastError: '',
  }
  state.tasks.push(task)
  return task
}

export function canTransition(from, to) {
  const allowed = TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

export function applyTaskUpdate(state, id, patch, now = Date.now()) {
  const task = findTask(state, id)
  if (!isPlainObject(patch)) throw new BoardError('bad-request', 'patch 必须是对象')
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) {
      throw new BoardError('bad-request', '非法状态：' + String(patch.status), { allowed: STATUSES })
    }
    if (!canTransition(task.status, patch.status)) {
      throw new BoardError('conflict', '不允许的状态迁移：' + task.status + ' → ' + patch.status, {
        from: task.status,
        to: patch.status,
        allowed: TRANSITIONS[task.status] || [],
      })
    }
  }
  const stamp = iso(now)
  const previousStatus = task.status
  if (patch.status !== undefined && patch.status !== previousStatus) {
    task.status = patch.status
    // 状态变了，上一轮「派发跳过」的原因就过期了，别让它挂在卡片上误导人。
    if (patch.clearError !== true) task.lastError = ''
    if (patch.status === 'doing') {
      task.startedAt = stamp
      task.finishedAt = null
      task.archivedAt = null
    } else if (patch.status === 'done') {
      task.finishedAt = stamp
    } else if (patch.status === 'archived') {
      task.archivedAt = stamp
    } else if (patch.status === 'todo') {
      // 回到待开始：重新排队派发，清掉上一轮的派发记账。
      task.startedAt = null
      task.finishedAt = null
      task.archivedAt = null
      task.notifiedAt = null
      task.notificationCount = 0
      task.assignee = ''
    }
  }
  if (patch.title !== undefined) {
    const title = trimmed(patch.title, MAX_TITLE_CHARS)
    if (title === '') throw new BoardError('bad-request', '标题不能为空')
    task.title = title
  }
  if (patch.note !== undefined) task.note = trimmed(patch.note, MAX_NOTE_CHARS)
  if (patch.result !== undefined) task.result = trimmed(patch.result, MAX_NOTE_CHARS)
  if (patch.assignee !== undefined) task.assignee = trimmed(patch.assignee, 200)
  if (patch.lastError !== undefined) task.lastError = trimmed(patch.lastError, 500)
  if (patch.clearError === true) task.lastError = ''
  if (patch.sessionId !== undefined) {
    task.sessionId = typeof patch.sessionId === 'string' && patch.sessionId !== '' ? patch.sessionId : null
  }
  task.updatedAt = stamp
  return task
}

export function archiveDoneTasks(state, now = Date.now()) {
  let archived = 0
  for (const task of state.tasks) {
    if (task.status !== 'done') continue
    task.status = 'archived'
    task.archivedAt = iso(now)
    task.updatedAt = iso(now)
    archived += 1
  }
  return archived
}

export function deleteTask(state, id) {
  const task = findTask(state, id)
  const index = state.tasks.indexOf(task)
  if (index >= 0) state.tasks.splice(index, 1)
  return task
}

/* ------------------------------------------------------------------ *
 * 派单：候选选择 / 目标 Agent / 消息构造
 * ------------------------------------------------------------------ */

/** 通知冷却：两倍轮询间隔，最长 120s。 */
export function notifyCooldownMs(config) {
  const interval = normalizeConfig(config).pollIntervalMs
  return Math.min(Math.max(interval * 2, 10000), 120000)
}

/**
 * 选下一条要派发的任务（纯函数）：
 *  - 只看 todo；
 *  - 通知次数达上限的不再投递；
 *  - 冷却期内不重复投递；
 *  - 按 createdAt、再按 id 数字序取最早的一条。
 */
export function selectDispatchCandidate(state, now = Date.now()) {
  const config = normalizeConfig(state.config)
  const cooldown = notifyCooldownMs(config)
  const candidates = state.tasks
    .filter((task) => task.status === 'todo')
    .filter((task) => task.notificationCount < config.maxNotifications)
    .filter((task) => {
      if (!task.notifiedAt) return true
      const at = Date.parse(task.notifiedAt)
      if (!Number.isFinite(at)) return true
      return now - at >= cooldown
    })
    .sort((a, b) => {
      const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt)
      if (byTime !== 0 && Number.isFinite(byTime)) return byTime
      return idNumber(a.id) - idNumber(b.id)
    })
  return candidates[0] || null
}

function idNumber(id) {
  const match = /^t-(\d+)$/.exec(String(id))
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

/**
 * 解析派发目标：
 *  1. 任务显式指定 sessionId → 只用它（离线就跳过，不改派别的会话）；
 *  2. 否则优先「派单看板模式」的空闲 root Agent（最近注册的那个）；
 *  3. 再退化到任意空闲 root Agent（普通模式的会话也能接任务）；
 *  4. 都没有 → agent-busy / no-live-agent。
 * @returns {{agent: object|null, reason: string}}
 */
export function resolveTargetAgent(agentsService, task, presetOf = headerPresetOf) {
  if (!agentsService || typeof agentsService.get !== 'function') {
    return { agent: null, reason: 'no-agents-service' }
  }
  if (task && task.sessionId) {
    const agent = agentsService.get(task.sessionId)
    if (!agent) return { agent: null, reason: 'agent-offline' }
    return { agent, reason: 'task-session' }
  }
  let roots = []
  try {
    roots = typeof agentsService.roots === 'function' ? agentsService.roots() : []
  } catch {
    roots = []
  }
  const idle = roots.filter((agent) => agent && agent.status === 'idle')
  const dispatchers = idle.filter((agent) => {
    try {
      return presetOf(agent) === DISPATCH_PRESET_ID
    } catch {
      return false
    }
  })
  if (dispatchers.length > 0) return { agent: dispatchers[dispatchers.length - 1], reason: 'dispatcher-root' }
  if (idle.length > 0) return { agent: idle[idle.length - 1], reason: 'recent-root' }
  if (roots.length > 0) return { agent: null, reason: 'agent-busy' }
  return { agent: null, reason: 'no-live-agent' }
}

/** 兜底：只读 session.header.agentPreset（创建时的预设，之后可能被切换过）。 */
function headerPresetOf(agent) {
  try {
    const header = agent && agent.session && agent.session.header
    return header && typeof header.agentPreset === 'string' ? header.agentPreset : ''
  } catch {
    return ''
  }
}

/**
 * 权威读法：agentPresets.presetForSession(session) 读的是 Session 的 agentPreset 投影
 * （header 初始化 + agent-preset/selected 事件推进），能反映创建后切换过的模式。
 */
function sessionPresetOfContext(ctx, agent) {
  try {
    const registry = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
    if (registry && typeof registry.presetForSession === 'function' && agent && agent.session) {
      const id = registry.presetForSession(agent.session)
      if (typeof id === 'string' && id !== '') return id
    }
  } catch {
    /* 退回头部字段 */
  }
  return headerPresetOf(agent)
}

/** 派发消息正文（模型看到的用户消息）。 */
export function buildDispatchText(task, now = Date.now()) {
  const lines = ['【任务看板 · 待开始】' + task.id + ' ' + task.title]
  if (task.note) lines.push('备注：' + task.note)
  if (task.cwd) lines.push('工作目录：' + task.cwd)
  lines.push('')
  lines.push(
    '请按派单规则处理这条看板任务：先用 taskboard_update 把它置为 doing，' +
      '再派发子 Agent 执行（背景执行，不要自己在对话里等），然后结束本轮。' +
      '子 Agent 回报后审核：通过就 taskboard_update 置为 done 并把结论写进 result；' +
      '不通过就 send_message 打回同一个子 Agent 重做，任务保持 doing。',
  )
  if (task.notificationCount > 0) {
    lines.push('（这是第 ' + (task.notificationCount + 1) + ' 次提醒；任务仍未派发。）')
  }
  lines.push('看板时间：' + iso(now))
  return lines.join('\n')
}

/**
 * 手工构造一条 UserMessage（等价于 @deepseek-ai/dsh-llm 的 createUserMessage，
 * 但本包不 import 它）。source 用内置的 {kind:'user'}，保证会话日志解码器一定认识。
 */
export function createBoardUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/* ------------------------------------------------------------------ *
 * 预设（模式）状态
 * ------------------------------------------------------------------ */

/**
 * 0.2.2 起 preset 不再是 $DSH_HOME/.agent-presets 目录，而是 bundle patch 里的
 * 一条 @deepseek-ai/dsh-agent-preset 声明行（见 presets/taskboard.patch.yml）：
 * 插件装进 profile 就声明了两个模式，随 Loader 组合加载，不需要写盘、也不需要额外重启。
 * 这里只负责把 registry 的实时名单读出来给 UI 用。
 */
export const DISPATCH_PRESET_ID = 'taskboard-dispatch'
export const WORKER_PRESET_ID = 'taskboard-worker'
export const PRESET_PATCH_PATH = 'presets/taskboard.patch.yml'

function readPluginVersion() {
  try {
    const pkg = readJsonFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))
    const version = pkg && typeof pkg.version === 'string' ? pkg.version : ''
    return version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const PLUGIN_VERSION = readPluginVersion()

/**
 * 读 agentPresets 注册表，返回两个模式的实时状态。
 * @returns {Promise<{installed:boolean, version:string, path:string, restartRequired:boolean, broken:string, presets:object[]}>}
 */
export async function inspectPresets(ctx, version = PLUGIN_VERSION) {
  const base = {
    installed: false,
    version,
    path: 'bundle:' + PRESET_PATCH_PATH,
    restartRequired: false,
    broken: '',
    presets: [],
  }
  const registry = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
  if (!registry || typeof registry.list !== 'function') {
    return { ...base, reason: '当前部署没有 agentPresets 服务（需要 dsh-web-app profile）' }
  }
  let roster = []
  try {
    roster = await registry.list()
  } catch (error) {
    return { ...base, reason: '读取模式名单失败：' + describeError(error) }
  }
  const ours = (Array.isArray(roster) ? roster : []).filter(
    (item) => item && (item.id === DISPATCH_PRESET_ID || item.id === WORKER_PRESET_ID),
  )
  const dispatch = ours.find((item) => item.id === DISPATCH_PRESET_ID)
  return {
    ...base,
    installed: !!dispatch && !dispatch.broken,
    broken: dispatch && dispatch.broken ? dispatch.broken : '',
    presets: ours.map((item) => ({
      id: item.id,
      name: typeof item.name === 'string' ? item.name : item.id,
      description: typeof item.description === 'string' ? item.description : '',
      broken: typeof item.broken === 'string' ? item.broken : '',
    })),
  }
}

/* ------------------------------------------------------------------ *
 * RPC 信封与 HTTP 处理
 * ------------------------------------------------------------------ */

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 从 Host 头里取精确 hostname（IPv6 保留方括号，去掉端口）。 */
export function hostnameOfHostHeader(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end === -1 ? raw.toLowerCase() : raw.slice(0, end + 1).toLowerCase()
  }
  const colon = raw.lastIndexOf(':')
  return (colon === -1 ? raw : raw.slice(0, colon)).toLowerCase()
}

/**
 * 只服务 loopback。判据是 TCP 对端地址（请求头伪造不了它），**不看 Host 头**——
 * Host 头只用来给出可读的 403 提示，绝不作为放行依据（否则 Host: 127.0.0.1.evil.com 可绕过）。
 * 本机反向代理转发时对端仍是 127.0.0.1，照常放行。
 */
export function isLoopbackRequest(req) {
  const address = req && req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : ''
  return LOOPBACK_ADDRESSES.has(address)
}

function sendPlain(res, status, text) {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(text)
  } catch {
    /* 响应可能已写出 */
  }
}

function sendJson(res, status, value) {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(value))
  } catch {
    /* 响应可能已写出 */
  }
}

function readRequestBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new BoardError('bad-request', '请求体超过 ' + limit + ' 字节'))
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => reject(error))
  })
}

/** 解析 RPC 信封（纯函数）。 */
export function parseRpcEnvelope(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new BoardError('bad-request', '请求体不是合法 JSON')
  }
  if (!isPlainObject(parsed)) throw new BoardError('bad-request', '信封必须是 JSON 对象')
  if (parsed.type !== 'client-request') throw new BoardError('bad-request', '信封 type 必须是 client-request')
  const rpcId = typeof parsed.rpcId === 'string' && parsed.rpcId !== '' ? parsed.rpcId : null
  const method = typeof parsed.method === 'string' ? parsed.method.trim() : ''
  if (method === '') throw new BoardError('bad-request', '信封缺少 method')
  const payload = isPlainObject(parsed.payload) ? parsed.payload : {}
  return { rpcId, method, payload }
}

/** 从 /taskboard/<endpoint> 提取 endpoint（纯函数）。 */
export function endpointFromUrl(rawUrl) {
  const text = typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : '/'
  const path = text.split('?')[0].split('#')[0]
  if (!path.startsWith(RPC_CHANNEL)) return ''
  const rest = path.slice(RPC_CHANNEL.length).replace(/^\/+/, '')
  if (rest === '') return ''
  const first = rest.split('/')[0]
  return decodeURIComponent(first)
}

function errorPayload(error) {
  if (error instanceof BoardError) {
    return { ok: false, error: { code: error.code, message: error.message, details: error.details || {} } }
  }
  return { ok: false, error: { code: 'internal', message: describeError(error), details: {} } }
}

async function handleHttp(rt, req, res) {
  if (!req || !res) return
  if (req.method !== 'POST') return sendPlain(res, 405, 'method not allowed')
  if (!isLoopbackRequest(req)) return sendPlain(res, 403, 'forbidden: loopback only')
  const contentType = String((req.headers && req.headers['content-type']) || '')
  if (!contentType.toLowerCase().includes('application/json')) {
    return sendPlain(res, 415, 'expected application/json')
  }
  const endpoint = endpointFromUrl(typeof req.url === 'string' ? req.url : '/')
  let rpcId = null
  try {
    const body = await readRequestBody(req)
    const envelope = parseRpcEnvelope(body)
    rpcId = envelope.rpcId
    if (endpoint !== '' && envelope.method !== endpoint) {
      throw new BoardError('bad-request', '路径端点 ' + endpoint + ' 与信封 method ' + envelope.method + ' 不一致')
    }
    const value = await dispatchRpc(rt, envelope.method, envelope.payload)
    return sendJson(res, 200, { type: 'server-response', rpcId, result: { ok: true, value } })
  } catch (error) {
    if (!(error instanceof BoardError)) console.error('[taskboard] RPC 处理失败：' + describeError(error))
    return sendJson(res, 200, { type: 'server-response', rpcId, result: errorPayload(error) })
  }
}

/* ------------------------------------------------------------------ *
 * 快照与 RPC 端点
 * ------------------------------------------------------------------ */

function sessionTitle(agent) {
  try {
    const header = agent && agent.session && agent.session.header
    const title = header && typeof header.title === 'string' ? header.title.trim() : ''
    if (title !== '') return title.length > SESSION_TITLE_MAX ? title.slice(0, SESSION_TITLE_MAX) : title
  } catch {
    /* ignore */
  }
  return ''
}

function sessionCwd(agent) {
  try {
    const header = agent && agent.session && agent.session.header
    return header && typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : null
  } catch {
    return null
  }
}

function agentSessionId(agent) {
  if (!agent) return null
  if (typeof agent.id === 'string' && agent.id !== '') return agent.id
  return sessionCwd(agent) === null && agent.session && typeof agent.session.id === 'string' ? agent.session.id : null
}

/** 读缓存（过期才重新问 registry）。 */
async function refreshPresetInfo(rt, force = false) {
  const now = Date.now()
  if (!force && rt.presetInfo && now - (rt.presetInfoAt || 0) < PRESET_CACHE_MS) return rt.presetInfo
  const info = await inspectPresets(rt.ctx)
  rt.presetInfo = info
  rt.presetInfoAt = now
  return info
}

function listAgents(rt) {
  const agents = typeof rt.ctx.get === 'function' ? rt.ctx.get('agents') : undefined
  if (!agents) return []
  let roots = []
  try {
    roots = typeof agents.roots === 'function' ? agents.roots() : []
  } catch {
    roots = []
  }
  const rows = []
  for (const agent of roots) {
    const sessionId = agentSessionId(agent)
    if (!sessionId) continue
    rows.push({
      sessionId,
      status: agent.status === 'running' ? 'running' : 'idle',
      cwd: sessionCwd(agent),
      title: sessionTitle(agent),
      preset: sessionPresetOfContext(rt.ctx, agent) || null,
      root: true,
    })
  }
  return rows
}

export function buildSnapshot(rt, now = Date.now(), preset = rt.presetInfo || null) {
  const config = normalizeConfig(rt.state.config)
  return {
    version: BOARD_VERSION,
    revision: Number(rt.state.revision) || 0,
    updatedAt: rt.state.updatedAt,
    config,
    tasks: rt.state.tasks.map((task) => ({ ...task })),
    poll: {
      running: rt.poll.running === true,
      lastRunAt: rt.poll.lastRunAt || null,
      lastDispatchAt: rt.poll.lastDispatchAt || null,
      lastDispatchSessionId: rt.poll.lastDispatchSessionId || null,
      lastDispatchSessionTitle: rt.poll.lastDispatchSessionTitle || null,
      lastSkipReason: rt.poll.lastSkipReason || null,
    },
    agents: listAgents(rt),
    preset,
    boardPath: rt.filePath,
    pluginVersion: PLUGIN_VERSION,
    now: iso(now),
  }
}

async function dispatchRpc(rt, method, payload) {
  switch (method) {
    case 'snapshot':
      return buildSnapshot(rt, Date.now(), await refreshPresetInfo(rt))
    case 'add-task': {
      const task = addTask(rt.state, payload)
      commitBoard(rt.state, rt.filePath)
      return { task }
    }
    case 'update-task': {
      const id = payload.id
      const rest = {}
      for (const key of Object.keys(payload)) if (key !== 'id' && key !== 'patch') rest[key] = payload[key]
      const patch = isPlainObject(payload.patch) ? payload.patch : rest
      const task = applyTaskUpdate(rt.state, id, patch)
      commitBoard(rt.state, rt.filePath)
      return { task }
    }
    case 'delete-task': {
      const task = deleteTask(rt.state, payload.id)
      commitBoard(rt.state, rt.filePath)
      return { deleted: true, id: task.id }
    }
    case 'dispatch-now': {
      const result = await tick(rt, { taskId: payload.id, force: true })
      return result
    }
    case 'set-config': {
      const next = normalizeConfig({ ...normalizeConfig(rt.state.config), ...payload })
      const intervalChanged = next.pollIntervalMs !== normalizeConfig(rt.state.config).pollIntervalMs
      rt.state.config = next
      commitBoard(rt.state, rt.filePath)
      if (intervalChanged) startPolling(rt)
      return { config: next }
    }
    case 'archive-done': {
      const archived = archiveDoneTasks(rt.state)
      if (archived > 0) commitBoard(rt.state, rt.filePath)
      return { archived }
    }
    case 'install-preset': {
      // 兼容旧客户端：0.2.2 起预设随 bundle 安装，这个端点只刷新状态、不再写盘。
      const preset = await refreshPresetInfo(rt, true)
      return { ...preset, action: 'none', reason: '预设随插件包声明，无需写盘或额外重启' }
    }
    default:
      throw new BoardError('bad-request', '未知端点：' + method)
  }
}

/* ------------------------------------------------------------------ *
 * 轮询派单
 * ------------------------------------------------------------------ */

const SKIP_TEXT = {
  'poll-disabled': '轮询已暂停',
  'agent-busy': '目标会话正在运行，稍后再派',
  'agent-offline': '任务指定的会话不在线',
  'no-live-agent': '没有在线的会话',
  'no-agents-service': 'agents 服务不可用',
  'followup-failed': '投递消息失败',
}

function skipText(reason) {
  return SKIP_TEXT[reason] || ''
}

export async function tick(rt, options = {}) {
  const now = Date.now()
  rt.poll.lastRunAt = iso(now)
  const config = normalizeConfig(rt.state.config)
  if (!config.pollEnabled && !options.taskId) {
    rt.poll.lastSkipReason = 'poll-disabled'
    return { dispatched: false, reason: 'poll-disabled' }
  }
  let task = null
  if (options.taskId) {
    task = findTask(rt.state, options.taskId)
    if (task.status !== 'todo') throw new BoardError('conflict', '只有待开始的任务可以立即派发（当前状态：' + task.status + '）')
  } else {
    task = selectDispatchCandidate(rt.state, now)
    if (!task) {
      rt.poll.lastSkipReason = null
      return { dispatched: false, reason: 'no-candidate' }
    }
  }
  const agents = typeof rt.ctx.get === 'function' ? rt.ctx.get('agents') : undefined
  const resolved = resolveTargetAgent(agents, task, (agent) => sessionPresetOfContext(rt.ctx, agent))
  if (!resolved.agent) {
    rt.poll.lastSkipReason = resolved.reason
    const text = skipText(resolved.reason)
    if (text !== '' && task.lastError !== text) {
      task.lastError = text
      task.updatedAt = iso(now)
      commitBoard(rt.state, rt.filePath)
    }
    return { dispatched: false, reason: resolved.reason }
  }
  if (!options.force && resolved.agent.status !== 'idle') {
    rt.poll.lastSkipReason = 'agent-busy'
    return { dispatched: false, reason: 'agent-busy' }
  }
  const sessionId = agentSessionId(resolved.agent)
  const message = createBoardUserMessage(buildDispatchText(task, now))
  try {
    resolved.agent.followup(message)
    // 关键：等 inbox splice 落盘再记账，否则重启会丢消息但 notificationCount 已 +1。
    // 官方 dsh-schedule 的投递路径同样在 followup 之后 await sessions.flush。
    try {
      const sessions = typeof rt.ctx.get === 'function' ? rt.ctx.get('sessions') : undefined
      if (sessions && typeof sessions.flush === 'function') await sessions.flush(resolved.agent.session)
    } catch (flushError) {
      console.warn('[taskboard] 会话 flush 失败（消息已入队）：' + describeError(flushError))
    }
  } catch (error) {
    rt.poll.lastSkipReason = 'followup-failed'
    task.lastError = skipText('followup-failed') + '：' + describeError(error)
    task.updatedAt = iso(now)
    commitBoard(rt.state, rt.filePath)
    console.warn('[taskboard] 派发失败：' + describeError(error))
    return { dispatched: false, reason: 'followup-failed', error: describeError(error) }
  }
  task.notifiedAt = iso(now)
  task.notificationCount = (Number(task.notificationCount) || 0) + 1
  task.updatedAt = iso(now)
  task.lastError =
    task.notificationCount >= config.maxNotifications
      ? '派发超时：已提醒 ' + task.notificationCount + ' 次仍无响应'
      : ''
  rt.poll.lastDispatchAt = iso(now)
  rt.poll.lastDispatchSessionId = sessionId
  rt.poll.lastDispatchSessionTitle = sessionTitle(resolved.agent)
  rt.poll.lastSkipReason = null
  commitBoard(rt.state, rt.filePath)
  return { dispatched: true, sessionId, task: { ...task } }
}

function stopPolling(rt) {
  if (rt.timer) {
    try {
      rt.timer()
    } catch {
      /* disposer 已失效 */
    }
    rt.timer = null
  }
  rt.poll.running = false
}

/** 定时器的执行函数：防重入 + 用 withoutInitiator 避免把看板工作记到某个 Agent 的因果链上。 */
function pollTick(rt) {
  if (rt.polling) return
  rt.polling = true
  const run = () => {
    tick(rt)
      .catch((error) => console.warn('[taskboard] 轮询异常：' + describeError(error)))
      .finally(() => {
        rt.polling = false
      })
  }
  try {
    const agents = typeof rt.ctx.get === 'function' ? rt.ctx.get('agents') : undefined
    if (agents && typeof agents.withoutInitiator === 'function') {
      agents.withoutInitiator(run)
      return
    }
  } catch {
    /* withoutInitiator 不可用时退化为普通调用 */
  }
  run()
}

/**
 * 启动/重建轮询定时器。优先 ctx.interval（插件卸载自动清理），退化 setInterval。
 * 改间隔时先 stopPolling 再 startPolling。
 */
function startPolling(rt) {
  stopPolling(rt)
  const interval = normalizeConfig(rt.state.config).pollIntervalMs
  rt.poll.running = true
  rt.polling = false
  try {
    if (rt.ctx && typeof rt.ctx.interval === 'function') {
      rt.timer = rt.ctx.interval(() => pollTick(rt), interval)
      return
    }
  } catch (error) {
    console.warn('[taskboard] ctx.interval 不可用，退化为 setInterval：' + describeError(error))
  }
  const handle = setInterval(() => pollTick(rt), interval)
  if (typeof handle.unref === 'function') handle.unref()
  rt.timer = () => clearInterval(handle)
}

/* ------------------------------------------------------------------ *
 * 模型工具
 * ------------------------------------------------------------------ */

const TASK_LIST_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['count', 'tasks'],
  properties: {
    count: { type: 'integer' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'status'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string', enum: [...STATUSES] },
          note: { type: 'string' },
          assignee: { type: 'string' },
          result: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
    },
  },
}

function taskBrief(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    note: task.note || '',
    assignee: task.assignee || '',
    result: task.result || '',
    updatedAt: task.updatedAt,
  }
}

function renderTaskList(value) {
  if (value.count === 0) return [{ type: 'text', text: '看板没有匹配的任务。' }]
  const lines = ['看板任务（' + value.count + ' 条）：']
  for (const task of value.tasks) {
    const bits = ['[' + task.status + ']', task.id, task.title]
    if (task.assignee) bits.push('@' + task.assignee)
    lines.push('- ' + bits.join(' '))
    if (task.note) lines.push('  备注：' + task.note)
    if (task.result) lines.push('  结论：' + task.result)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderTaskOne(prefix, task) {
  const lines = [prefix + task.id + ' [' + task.status + '] ' + task.title]
  if (task.note) lines.push('备注：' + task.note)
  if (task.result) lines.push('结论：' + task.result)
  lines.push('更新时间：' + task.updatedAt)
  return [{ type: 'text', text: lines.join('\n') }]
}

const TASK_ONE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['task'],
  properties: {
    task: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'status'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', enum: [...STATUSES] },
        note: { type: 'string' },
        assignee: { type: 'string' },
        result: { type: 'string' },
        updatedAt: { type: 'string' },
      },
    },
  },
}

/**
 * 注册三个模型工具。宿主级注册 = 全局可见（所有预设的 Agent 都能用），
 * 这也是「非派单模式也能往看板里塞任务」的实现方式。
 */
function registerTools(toolCtx, rt) {
  const tools = toolCtx.tools
  if (!tools || typeof tools.register !== 'function') {
    console.warn('[taskboard] tools 服务不可用，跳过模型工具注册')
    return
  }
  tools.register({
    name: 'taskboard_list',
    description:
      '列出任务看板上的任务（默认全部状态：todo=待开始 / doing=进行中 / done=已完成 / archived=已归档）。' +
      '派单前用它确认要处理哪条任务，审核后用 taskboard_update 更新状态。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: [...STATUSES],
          description: '只看某一列；省略则返回全部状态。',
        },
      },
    },
    output: {
      schema: TASK_LIST_OUTPUT_SCHEMA,
      render: (_args, value) => renderTaskList(value),
    },
    execute(args) {
      const want = args && args.status !== undefined ? args.status : ''
      if (want !== '' && !STATUSES.includes(want)) throw new Error('非法状态：' + String(want))
      const tasks = rt.state.tasks
        .filter((task) => (want === '' ? true : task.status === want))
        .map(taskBrief)
      return Promise.resolve({ count: tasks.length, tasks })
    },
  })
  tools.register({
    name: 'taskboard_add',
    description:
      '往任务看板添加一条待开始任务。用户口述的需求、你自己拆出来的后续任务都可以加进看板，' +
      '轮询器会把它派给主 Agent。title 必填，note 写验收标准或补充信息。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', description: '任务标题（一句话，必填）' },
        note: { type: 'string', description: '备注：背景、范围、验收标准' },
      },
    },
    output: {
      schema: TASK_ONE_OUTPUT_SCHEMA,
      render: (_args, value) => renderTaskOne('已添加任务 ', value.task),
    },
    execute(args, exec) {
      const title = trimmed(args && args.title, MAX_TITLE_CHARS)
      if (title === '') throw new Error('title 不能为空')
      let sessionId = null
      let cwd = null
      try {
        const agent = exec && exec.agent
        if (agent && agent.session) {
          sessionId = typeof agent.session.id === 'string' ? agent.session.id : null
          const header = agent.session.header
          cwd = header && typeof header.cwd === 'string' ? header.cwd : null
        }
      } catch {
        /* 非 agent 调用时忽略 */
      }
      const task = addTask(rt.state, { title, note: args && args.note, source: 'agent', sessionId, cwd })
      commitBoard(rt.state, rt.filePath)
      return Promise.resolve({ task: taskBrief(task) })
    },
  })
  tools.register({
    name: 'taskboard_update',
    description:
      '更新看板任务：置为 doing（已派发）、done（审核通过）、todo（打回重做）、archived（归档）；' +
      '也可以用 result 写审核结论、assignee 写子 Agent 标识。状态迁移非法时会返回错误。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '任务 id，例如 t-3' },
        status: { type: 'string', enum: [...STATUSES], description: '目标状态' },
        result: { type: 'string', description: '审核结论 / 子 Agent 汇报摘要' },
        assignee: { type: 'string', description: '子 Agent 的 label 或会话 id' },
        note: { type: 'string', description: '备注（覆盖原备注）' },
      },
    },
    output: {
      schema: TASK_ONE_OUTPUT_SCHEMA,
      render: (_args, value) => renderTaskOne('已更新任务 ', value.task),
    },
    execute(args) {
      if (!args || !args.id) throw new Error('缺少任务 id')
      const patch = {}
      for (const key of ['status', 'result', 'assignee', 'note']) {
        if (args[key] !== undefined) patch[key] = args[key]
      }
      const task = applyTaskUpdate(rt.state, args.id, patch)
      commitBoard(rt.state, rt.filePath)
      return Promise.resolve({ task: taskBrief(task) })
    },
  })
  console.log('[taskboard] 模型工具已注册：taskboard_list / taskboard_add / taskboard_update')
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const runtime = {
    ctx,
    filePath: boardPath(),
    state: createEmptyBoard(),
    warnings: [],
    timer: null,
    polling: false,
    presetInfo: null,
    presetInfoAt: 0,
    poll: {
      running: false,
      lastRunAt: null,
      lastDispatchAt: null,
      lastDispatchSessionId: null,
      lastSkipReason: null,
    },
  }

  try {
    const loaded = loadBoardFromDisk(runtime.filePath)
    runtime.state = loaded.state
    runtime.warnings = loaded.warnings
    for (const warning of loaded.warnings) console.warn('[taskboard] ' + warning)
  } catch (error) {
    console.warn('[taskboard] 读取看板失败，从空板开始：' + describeError(error))
  }

  // 模式状态：agentPresets 服务就绪后读名单（预设本身由 bundle patch 声明，不在这里安装）。
  // 预设行的激活是异步的，所以前几次读不到不算失败——最多重试 3 次再告警。
  try {
    ctx.inject(['agentPresets'], () => {
      const report = (attempt) => {
        refreshPresetInfo(runtime, true)
          .then((preset) => {
            if (preset.installed) {
              console.log('[taskboard] 派单模式已就绪：' + preset.presets.map((item) => item.name + '(' + item.id + ')').join(' / '))
              return
            }
            if (attempt < 3) {
              try {
                ctx.timeout(() => report(attempt + 1), 2500)
                return
              } catch {
                /* 没有 timer 就退化为直接告警 */
              }
            }
            console.warn('[taskboard] 派单模式未加载：' + (preset.broken || preset.reason || '未知原因'))
          })
          .catch((error) => console.warn('[taskboard] 读取模式状态失败：' + describeError(error)))
      }
      report(0)
    })
  } catch (error) {
    console.warn('[taskboard] agentPresets 注入失败：' + describeError(error))
  }

  // RPC 路由：webServer 是 Web profile 才有的服务，用 ctx.inject 等它就绪（缺失时插件照常运行）。
  try {
    ctx.inject(['webServer'], (webCtx) => {
      try {
        webCtx.effect(
          () =>
            webCtx.webServer.register({
              kind: 'prefix',
              path: RPC_CHANNEL,
              handler: (req, res) => {
                handleHttp(runtime, req, res).catch((error) => {
                  console.error('[taskboard] 处理 RPC 请求失败：' + describeError(error))
                  sendPlain(res, 500, 'internal error')
                })
              },
            }),
          'taskboard: rpc bridge',
        )
        console.log('[taskboard] RPC 路由已注册：' + RPC_CHANNEL)
      } catch (error) {
        console.error('[taskboard] RPC 路由注册失败：' + describeError(error))
      }
    })
  } catch (error) {
    console.error('[taskboard] webServer 注入失败：' + describeError(error))
  }

  // 轮询派单：定时器自己管理，config 改间隔时重建。
  try {
    startPolling(runtime)
    ctx.effect(
      () => () => {
        stopPolling(runtime)
      },
      'taskboard: poll cleanup',
    )
    console.log('[taskboard] 轮询已启动：' + normalizeConfig(runtime.state.config).pollIntervalMs + 'ms')
  } catch (error) {
    console.error('[taskboard] 轮询启动失败：' + describeError(error))
  }

  // 模型工具：tools 服务是可选的（headless/minimal profile 可能没有）。
  try {
    ctx.inject(['tools'], (toolCtx) => {
      try {
        registerTools(toolCtx, runtime)
      } catch (error) {
        console.error('[taskboard] 工具注册失败：' + describeError(error))
      }
    })
  } catch (error) {
    console.warn('[taskboard] tools 服务注入失败：' + describeError(error))
  }
}
