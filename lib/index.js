/**
 * dsh-taskboard —— Host 半（Cordis 插件，ESM，无构建）。
 *
 * 单一 Loader 行（见 cordis.patch.yml）挂载本模块，职责：
 *  1. 在 webServer 上注册 /taskboard 前缀路由，用 Connection RPC 信封
 *     （{type:'client-request', rpcId, method, payload} → {type:'server-response', rpcId, result}）
 *     给浏览器端提供 snapshot / add-task / update-task / delete-task / dispatch-now /
 *     set-config / archive-done / install-preset / bind-main-session / clear-main-session /
 *     ensure-workspace-lead / upload-attachment / attachment 等端点；
 *  2. 持久化任务看板到 $DSH_HOME/storages/dsh-taskboard/board.json（原子写）；
 *  3. 轮询「待开始」列（v0.2.0 默认 workspace-lead 模式）：按任务工作区复用/懒创建常驻工作区组长
 *     （taskboard-dispatch 预设），用 agent.followup() 推一条【任务看板 · 待开始】消息；
 *     组长据此派 taskboard-worker 子 Agent 干活并审核写回（本插件不直接起子 Agent）；
 *  4. 任务 done 且未汇报时，把完成回执合并成【任务看板 · 汇报】推给主会话（config.mainSessionId）；
 *  5. 注册三个面向模型的工具：taskboard_list / taskboard_add / taskboard_update；
 *  6. 插件 bundle 自带两个模式声明（presets/taskboard.patch.yml 里的
 *     @deepseek-ai/dsh-agent-preset 行：taskboard-dispatch 主 + taskboard-worker 执行者），
 *     随 Loader 组合加载；本文件只从 agentPresets 注册表读回实时状态给 UI。
 *  7. v0.2.0 补充：工作区组长在直聊里被直接要求派活时，监听 tools/result 识别 subagent 派发、
 *     监听 subagent/end 收尾，自动建 / 完结一条看板任务（§1.8；标准 tool-call 与 PTC 都覆盖）。
 *
 * 本文件顶层只 import node: 内建模块，不 import 任何 @deepseek-ai/*。
 * 原因：外部插件包的 profile node_modules 里没有 dsh-tools / dsh-llm，
 * 需要的数据结构（UserMessage / 工具定义）在本文件内手工构造（见 createBoardUserMessage）。
 * 这样也保证 node --test 能在没有 DSH 进程时直接 import 本文件做纯函数单测。
 *
 * 契约（字段/端点/状态机）以 docs/architecture.md 为唯一事实来源。
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
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
export const MAX_BODY_BYTES = 512 * 1024
const MIN_POLL_INTERVAL_MS = 5000
const MAX_POLL_INTERVAL_MS = 300000
const DEFAULT_POLL_INTERVAL_MS = 15000
const DEFAULT_MAX_NOTIFICATIONS = 5
const MAX_NOTE_CHARS = 4000
const MAX_TITLE_CHARS = 200
/** 会话标题（主会话 / 工作区组长）最长字符数。 */
const SESSION_TITLE_MAX = 200
/** config.workspaceLeads 最多保存多少条工作区 → 组长映射（§2）。 */
const MAX_WORKSPACE_LEADS = 32
/** 完成回执每批最多合并多少条任务（§1.6）。 */
const MAX_RECEIPT_BATCH = 10
/** 完成回执里每条任务结论压成单行后的最大字符数（§1.6）。 */
const RECEIPT_RESULT_CHARS = 200

/* ------------------------------------------------------------------ *
 * 粘贴图片附件（v0.2.0，§2.1）
 * ------------------------------------------------------------------ */

const ATTACHMENT_DIRNAME = 'attachments'
const ATTACHMENT_INDEX_FILENAME = 'index.json'
const ATTACHMENT_INDEX_VERSION = 1
/** 解码后单张图片上限（§2.1）。 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
/** 单条任务 note 里最多几个不同附件引用（§2.1）。 */
export const MAX_TASK_ATTACHMENTS = 8
/** 允许的图片 MIME（与 DSH 附件服务 v1 白名单一致）。 */
export const ATTACHMENT_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** 上传端点单独放宽的请求体上限：base64 膨胀 4/3 + data URL 前缀 + JSON 外壳。 */
export const MAX_UPLOAD_BODY_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 64 * 1024
const ATTACHMENT_EXTENSIONS = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })
const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ATTACHMENT_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/
/** note 里的短引用：![image](attachment://<uuid>)。 */
const ATTACHMENT_REF_PATTERN = /!\[[^\]]*\]\(attachment:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/g

/**
 * §1.8 自动建任务的持久化标记：只有带这个标记的任务才会被 `subagent/end` 自动置 done。
 * 轮询投递任务 / 人工任务恒为 null —— 组长把它们的 assignee 写成 worker 会话 id 也不会被宿主抢答。
 */
export const LEAD_AUTO_MARK = 'lead-dispatch'
/**
 * §1.8 in-flight 去重的陈旧窗口：组长名下「doing + notifiedAt」的轮询任务超过这个时长没有更新
 * （worker 长跑 / 组长卡死）就不再挡住直聊派活——宁可多一条可见任务，也不让派活无声消失。
 */
export const LEAD_IN_FLIGHT_TTL_MS = 30 * 60 * 1000

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

/** 丢掉被截断切开的图片引用尾巴（缺收尾 `)` / 缺 `]`，以及半个 `attachment://` 协议前缀）。 */
function stripPartialAttachmentRef(head) {
  // 1) 引用 URL 被切断：`![alt](attachment://<uuid>` 没有收尾 `)`，整段丢掉。
  const unclosedRef = /!\[[^\]]*\]\([^)]*$/.exec(head)
  if (unclosedRef) return head.slice(0, unclosedRef.index)
  // 2) 引用还没写到 `]`：`![ima`（截断点落在 alt / 协议前缀前段）。
  const openRef = /!\[[^\]]*$/.exec(head)
  if (openRef) return head.slice(0, openRef.index).replace(/\s+$/, '')
  // 3) 兜底：尾巴是 `attachment://` 的半个协议前缀（裸引用，没走图片语法）。
  const needle = 'attachment://'
  for (let len = needle.length - 1; len >= 1; len -= 1) {
    if (head.endsWith(needle.slice(0, len))) {
      return head.slice(0, head.length - len).replace(/\s+$/, '')
    }
  }
  // 4) 兜底：裸引用前缀完整、UUID 被切断（`see attachment://2222…-42`）——整段丢掉，
  //    别把半截 id 留在 note / result 里变成坏链接；完整 UUID 照常保留。
  const cutBareId = /attachment:\/\/[0-9a-f-]*$/.exec(head)
  if (cutBareId && !ATTACHMENT_ID_PATTERN.test(cutBareId[0].slice(needle.length))) {
    return head.slice(0, cutBareId.index).replace(/\s+$/, '')
  }
  return head
}

/**
 * note / result 的 4000 字符截断（§2.1）：**不得切出半截 `attachment://` 引用**。
 * 截断点落在某个 `![...](attachment://<uuid>)` 内部时退到该引用开头再截——宁可少保留最后一个引用，
 * 也不给详情浮层留坏链接（其余完整引用照常保留）。
 */
export function truncateNote(text, max = MAX_NOTE_CHARS) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw.length <= max) return raw
  return stripPartialAttachmentRef(raw.slice(0, max)).replace(/\s+$/, '')
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
  // 测试/多实例隔离：显式指定 board.json 路径时优先用它，避免两个进程抢同一个文件。
  const override = typeof process.env.DSH_TASKBOARD_PATH === 'string' ? process.env.DSH_TASKBOARD_PATH.trim() : ''
  if (override !== '') return override
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
      dispatchMode: DEFAULT_DISPATCH_MODE,
      mainSessionId: null,
      mainSessionTitle: '',
      workspaceLeads: {},
    },
    tasks: [],
  }
}

/**
 * 派发去处（v0.2.0）：
 *  - workspace-lead（默认）：按任务工作区投给该工作区的常驻组长（§1.5）；
 *  - new / creator / auto：兼容旧模式（§1.7），已持久化的合法旧值原样保留。
 */
export const DISPATCH_MODES = ['workspace-lead', 'new', 'creator', 'auto']
export const DEFAULT_DISPATCH_MODE = 'workspace-lead'

/**
 * 规范化 config.workspaceLeads：普通对象，key 为工作区 id 或归一化 cwd；
 * 条目要求 sessionId / cwd 均是非空字符串；非法条目丢弃；最多 32 条（按对象键顺序保留前 32）。
 */
export function normalizeWorkspaceLeads(raw) {
  const leads = {}
  if (!isPlainObject(raw)) return leads
  let kept = 0
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= MAX_WORKSPACE_LEADS) break
    if (typeof key !== 'string' || key === '') continue
    if (!isPlainObject(value)) continue
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : ''
    const cwd = typeof value.cwd === 'string' ? value.cwd.trim() : ''
    if (sessionId === '' || cwd === '') continue
    leads[key] = {
      sessionId,
      title: trimmed(value.title, SESSION_TITLE_MAX),
      cwd,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    }
    kept += 1
  }
  return leads
}

/**
 * 写一条工作区组长映射：键存在则原位更新；超过 32 条时优先淘汰对象键顺序末尾的旧键，
 * 保证刚写入的新映射不会被下一次 normalizeConfig 丢弃（否则 tick 会每轮重复创建组长）。
 */
export function putWorkspaceLead(leads, key, entry) {
  const next = isPlainObject(leads) ? { ...leads } : {}
  if (typeof key !== 'string' || key === '') return next
  next[key] = entry
  const keys = Object.keys(next)
  while (keys.length > MAX_WORKSPACE_LEADS) {
    let victim = ''
    for (let i = keys.length - 1; i >= 0; i--) {
      if (keys[i] !== key) {
        victim = keys[i]
        break
      }
    }
    if (victim === '') break
    delete next[victim]
    keys.splice(keys.indexOf(victim), 1)
  }
  return next
}

export function normalizeConfig(raw) {
  const config = isPlainObject(raw) ? raw : {}
  const interval = Number(config.pollIntervalMs)
  const maxNotifications = Number(config.maxNotifications)
  return {
    pollEnabled: config.pollEnabled !== false,
    dispatchMode: DISPATCH_MODES.includes(config.dispatchMode) ? config.dispatchMode : DEFAULT_DISPATCH_MODE,
    pollIntervalMs:
      Number.isFinite(interval) && interval >= MIN_POLL_INTERVAL_MS && interval <= MAX_POLL_INTERVAL_MS
        ? Math.round(interval)
        : DEFAULT_POLL_INTERVAL_MS,
    maxNotifications:
      Number.isFinite(maxNotifications) && maxNotifications >= 1 && maxNotifications <= 50
        ? Math.round(maxNotifications)
        : DEFAULT_MAX_NOTIFICATIONS,
    // v0.2.0 完成回执收件人：未绑定 / 空白 = null。
    mainSessionId: (() => {
      const id = typeof config.mainSessionId === 'string' ? config.mainSessionId.trim() : ''
      return id !== '' ? id : null
    })(),
    mainSessionTitle: trimmed(config.mainSessionTitle, SESSION_TITLE_MAX),
    workspaceLeads: normalizeWorkspaceLeads(config.workspaceLeads),
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
    note: truncateNote(raw.note, MAX_NOTE_CHARS),
    status,
    source: raw.source === 'agent' ? 'agent' : 'user',
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : null,
    // 最近一次投递给哪个会话（看板详情里「打开执行对话」用）。
    dispatchedSessionId: typeof raw.dispatchedSessionId === 'string' && raw.dispatchedSessionId !== '' ? raw.dispatchedSessionId : null,
    dispatchedSessionTitle: trimmed(raw.dispatchedSessionTitle, 200),
    // v0.2.0 完成回执记账：null = 尚未把结论推给主会话；只在 board.json / Snapshot.tasks 出现。
    reportedAt: asString(raw.reportedAt) || null,
    // v0.2.0 自动建任务标记（§1.8）：只有 'lead-dispatch' 合法，其它一律 null（= 普通任务）。
    autoDispatch: raw.autoDispatch === LEAD_AUTO_MARK ? LEAD_AUTO_MARK : null,
    cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : null,
    assignee: trimmed(raw.assignee, 200),
    result: truncateNote(raw.result, MAX_NOTE_CHARS),
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

/**
 * 写前重读：如果盘上的 revision 比内存新，说明别的进程写过（例如同时开了测试实例），
 * 就整体采用盘上的状态再改，避免「整份内存状态覆盖掉别人的修改」（丢更新）。
 * @returns {boolean} 是否发生了重载
 */
export function reloadBoardIfStale(rt) {
  try {
    if (!rt || !rt.filePath || !existsSync(rt.filePath)) return false
    const loaded = loadBoardFromDisk(rt.filePath)
    const disk = loaded && loaded.state
    if (!disk) return false
    if (Number(disk.revision) > Number(rt.state && rt.state.revision)) {
      rt.state = disk
      return true
    }
  } catch (error) {
    console.warn('[taskboard] 重读看板失败：' + describeError(error))
  }
  return false
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
 * 粘贴图片附件（v0.2.0，§2.1）
 *
 * 设计要点：
 *  - 优先复用 DSH 附件服务（ctx.attachments）；服务不可用时退到本插件目录自建存储；
 *  - note 只存短引用 attachment://<uuid>，绝不存 base64（note 会进派单消息 / prompt）；
 *  - id 是 randomUUID（不可猜）；读取只按索引里的 id 查，不把用户输入拼进文件路径。
 * ------------------------------------------------------------------ */

/** 附件目录：默认与 board.json 同级的 attachments/（即 $DSH_HOME/storages/dsh-taskboard/attachments）。 */
export function attachmentsDir() {
  return join(dirname(boardPath()), ATTACHMENT_DIRNAME)
}

export function attachmentRef(id) {
  return 'attachment://' + String(id)
}

/** 从 data URL 解出图片字节；校验 MIME 白名单、5 MB 上限与文件头。纯函数，便于单测。 */
export function decodeImageDataUrl(dataUrl) {
  const text = typeof dataUrl === 'string' ? dataUrl.trim() : ''
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(text)
  if (!match) throw new BoardError('bad-request', '图片数据格式不合法：需要 data:<mime>;base64,<...>')
  const mime = match[1].toLowerCase()
  if (!ATTACHMENT_MEDIA_TYPES.includes(mime)) {
    throw new BoardError('bad-request', '不支持的图片类型：' + mime + '（仅支持 png / jpeg / webp / gif）')
  }
  const base64 = match[2]
  let bytes
  try {
    bytes = Buffer.from(base64, 'base64')
  } catch {
    throw new BoardError('bad-request', '图片 base64 解码失败')
  }
  // FileReader 产出的 data URL 是规范 base64；非规范形式（空白 / URL-safe 字符 / 多余填充）直接拒绝。
  if (bytes.length === 0 || bytes.toString('base64') !== base64) {
    throw new BoardError('bad-request', '图片 base64 不是规范编码')
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new BoardError(
      'bad-request',
      '图片超过大小上限：' + bytes.length + ' 字节（最多 ' + MAX_ATTACHMENT_BYTES + ' 字节 / 5 MB）',
      { size: bytes.length, max: MAX_ATTACHMENT_BYTES },
    )
  }
  const sniffed = sniffImageMime(bytes)
  if (sniffed === '') throw new BoardError('bad-request', '无法识别的图片数据（文件头不是 png / jpeg / webp / gif）')
  if (sniffed !== mime) throw new BoardError('bad-request', '图片内容与声明类型不一致：声明 ' + mime + '，实际 ' + sniffed)
  return { mime, bytes }
}

/** 按 magic bytes 识别图片类型；识别不了返回空串。纯函数。 */
export function sniffImageMime(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(0)
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6) {
    const head = String.fromCharCode(data[0], data[1], data[2], data[3], data[4], data[5])
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12) {
    const riff = String.fromCharCode(data[0], data[1], data[2], data[3])
    const webp = String.fromCharCode(data[8], data[9], data[10], data[11])
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp'
  }
  return ''
}

/** note 里不同附件引用的个数（同一 id 重复出现只算一个）。纯函数。 */
export function countAttachmentRefs(note) {
  if (typeof note !== 'string' || note === '') return 0
  const ids = new Set()
  ATTACHMENT_REF_PATTERN.lastIndex = 0
  let match
  while ((match = ATTACHMENT_REF_PATTERN.exec(note)) !== null) ids.add(match[1])
  return ids.size
}

/** `add-task` / `update-task` 的 note 校验：单任务最多 8 个不同附件引用（§2.1）。 */
export function assertNoteAttachments(note) {
  if (typeof note !== 'string') return
  const count = countAttachmentRefs(note)
  if (count > MAX_TASK_ATTACHMENTS) {
    throw new BoardError('bad-request', '一条任务最多 ' + MAX_TASK_ATTACHMENTS + ' 个图片附件（当前 ' + count + ' 个）', {
      count,
      max: MAX_TASK_ATTACHMENTS,
    })
  }
}

function attachmentIndexPath(dir) {
  return join(dir, ATTACHMENT_INDEX_FILENAME)
}

/** 读索引：文件缺失 = 空索引；JSON / 结构损坏时标记 corrupt（读端点报 internal）。 */
function readAttachmentIndexState(dir) {
  const file = attachmentIndexPath(dir)
  if (!existsSync(file)) return { entries: {}, corrupt: false }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!isPlainObject(parsed) || !isPlainObject(parsed.entries)) return { entries: {}, corrupt: true }
    const entries = {}
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (!ATTACHMENT_ID_PATTERN.test(id) || !isPlainObject(entry)) continue
      entries[id] = entry
    }
    return { entries, corrupt: false }
  } catch {
    return { entries: {}, corrupt: true }
  }
}

/** 供 UI / 测试读取索引（只返回合法条目）。 */
export function loadAttachmentIndex(dir = attachmentsDir()) {
  return readAttachmentIndexState(dir).entries
}

let attachmentWriteChain = Promise.resolve()

/** 串行化索引写：一次连贴多张图时 Promise.all 也不会互相覆盖。 */
function enqueueAttachmentWrite(task) {
  const run = attachmentWriteChain.then(task, task)
  attachmentWriteChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function mapAttachmentServiceError(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  const message = describeError(error)
  if (code === 'ATTACHMENT_NOT_FOUND') return new BoardError('not-found', '附件不存在：' + message, { cause: code })
  if (
    /^(?:UNSUPPORTED_IMAGE_TYPE|INVALID_IMAGE_BASE64|INVALID_IMAGE|IMAGE_TYPE_MISMATCH|IMAGE_TOO_LARGE|IMAGES_TOO_LARGE|TOO_MANY_IMAGES|IMAGE_TOO_MANY_PIXELS|IMAGE_DIMENSION_TOO_LARGE)$/.test(
      code,
    )
  ) {
    return new BoardError('bad-request', '图片校验失败：' + message, { cause: code })
  }
  return new BoardError('internal', '附件存储失败：' + message, { cause: code })
}

/**
 * 保存一张粘贴图片（异步）。
 * @param {string} dataUrl `data:image/<png|jpeg|webp|gif>;base64,…`
 * @param {{dir?:string, name?:string, attachmentsService?:object, now?:number}} [options]
 * @returns {Promise<{id:string, ref:string, mime:string, size:number, name:string}>}
 */
export async function saveAttachment(dataUrl, options = {}) {
  const dir = typeof options.dir === 'string' && options.dir !== '' ? options.dir : attachmentsDir()
  const name = trimmed(options.name, 200)
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const { mime, bytes } = decodeImageDataUrl(dataUrl)
  const id = randomUUID()
  const service = options.attachmentsService
  const entry = { id, mime, size: bytes.length, name, createdAt: iso(now), backend: 'local' }
  if (service && typeof service.saveImages === 'function') {
    let ref
    try {
      const refs = await service.saveImages([
        { data: bytes, mediaType: mime, ...(name === '' ? {} : { name }) },
      ])
      ref = Array.isArray(refs) ? refs[0] : null
    } catch (error) {
      throw mapAttachmentServiceError(error)
    }
    if (!ref || typeof ref.attachmentId !== 'string' || ref.attachmentId === '') {
      throw new BoardError('internal', '附件服务没有返回有效引用')
    }
    entry.backend = 'dsh'
    entry.ref = ref
    // 附件服务会按部署策略归一化（例如带 alpha 的 PNG 转 WebP）：以服务返回的 ref 为准。
    if (typeof ref.mediaType === 'string' && ATTACHMENT_MEDIA_TYPES.includes(ref.mediaType)) entry.mime = ref.mediaType
    if (typeof ref.bytes === 'number' && ref.bytes > 0) entry.size = ref.bytes
  } else {
    const file = id + '.' + ATTACHMENT_EXTENSIONS[mime]
    try {
      mkdirSync(dir, { recursive: true })
      const tmp = join(dir, file + '.tmp-' + process.pid)
      writeFileSync(tmp, bytes)
      renameSync(tmp, join(dir, file))
    } catch (error) {
      throw new BoardError('internal', '附件写盘失败：' + describeError(error))
    }
    entry.file = file
  }
  await enqueueAttachmentWrite(() => {
    let state = readAttachmentIndexState(dir)
    if (state.corrupt) {
      // 索引损坏：保留现场（改名），从空索引继续，避免上传永远失败。
      try {
        renameSync(attachmentIndexPath(dir), attachmentIndexPath(dir) + '.corrupt-' + now)
      } catch {
        /* best-effort */
      }
      state = { entries: {}, corrupt: false }
    }
    state.entries[id] = entry
    try {
      mkdirSync(dir, { recursive: true })
      writeJsonAtomic(attachmentIndexPath(dir), {
        version: ATTACHMENT_INDEX_VERSION,
        updatedAt: iso(now),
        entries: state.entries,
      })
    } catch (error) {
      throw new BoardError('internal', '附件索引写盘失败：' + describeError(error))
    }
  })
  return { id, ref: attachmentRef(id), mime: entry.mime, size: entry.size, name }
}

/**
 * 读取一张附件（异步）。id 只接受 UUID 形式，且必须命中本插件索引；
 * 自建后端额外把解析后的绝对路径限制在附件目录内（§2.1）。
 * @param {string} id
 * @param {{dir?:string, attachmentsService?:object}} [options]
 * @returns {Promise<{id:string, mime:string, size:number, dataUrl:string}>}
 */
export async function readAttachment(id, options = {}) {
  const raw = typeof id === 'string' ? id.trim() : ''
  if (raw === '') throw new BoardError('bad-request', '缺少附件 id')
  if (!ATTACHMENT_ID_PATTERN.test(raw)) throw new BoardError('bad-request', '附件 id 格式不合法')
  const dir = typeof options.dir === 'string' && options.dir !== '' ? options.dir : attachmentsDir()
  const state = readAttachmentIndexState(dir)
  if (state.corrupt) throw new BoardError('internal', '附件索引损坏，无法读取')
  const entry = state.entries[raw]
  if (!entry) throw new BoardError('not-found', '附件不存在：' + raw, { id: raw })
  const mime = typeof entry.mime === 'string' ? entry.mime : ''
  if (!ATTACHMENT_MEDIA_TYPES.includes(mime)) throw new BoardError('internal', '附件索引损坏：MIME 不合法')
  if (entry.backend === 'dsh') {
    const service = options.attachmentsService
    if (!service || typeof service.readImage !== 'function') {
      throw new BoardError('internal', '附件服务不可用，无法读取已存储的图片')
    }
    let stored
    try {
      stored = await service.readImage(entry.ref)
    } catch (error) {
      throw mapAttachmentServiceError(error)
    }
    const data = stored && stored.data
    if (!data || typeof data.byteLength !== 'number' || data.byteLength === 0) {
      throw new BoardError('internal', '附件服务没有返回有效图片数据')
    }
    return {
      id: raw,
      mime,
      size: data.byteLength,
      dataUrl: 'data:' + mime + ';base64,' + Buffer.from(data).toString('base64'),
    }
  }
  const file = typeof entry.file === 'string' ? entry.file : ''
  if (!ATTACHMENT_FILE_PATTERN.test(file)) throw new BoardError('internal', '附件索引损坏：文件名不合法')
  const base = resolve(dir)
  const full = resolve(base, file)
  const prefix = base.endsWith(sep) ? base : base + sep
  // 防御性路径校验：正常文件名已在上面限死，这里再确认解析结果仍在附件目录内。
  if (!full.startsWith(prefix)) {
    throw new BoardError('bad-request', '附件路径非法')
  }
  let bytes
  try {
    bytes = readFileSync(full)
  } catch {
    throw new BoardError('not-found', '附件文件不存在：' + raw, { id: raw })
  }
  return {
    id: raw,
    mime,
    size: bytes.length,
    dataUrl: 'data:' + mime + ';base64,' + bytes.toString('base64'),
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
    note: truncateNote(input.note, MAX_NOTE_CHARS),
    status: 'todo',
    source: input.source === 'agent' ? 'agent' : 'user',
    // 仅记录「哪个会话创建的」，不参与派发路由（派发永远是主 Agent 全自动）。
    sessionId: typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null,
    dispatchedSessionId: null,
    dispatchedSessionTitle: '',
    reportedAt: null,
    autoDispatch: null,
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
      // 返工 / 重开：下次再 done 要重新生成完成回执（§1.6 重置规则）。
      task.reportedAt = null
    } else if (patch.status === 'done') {
      task.finishedAt = stamp
      // 新的完成一定还没汇报过；已汇报过的历史结论只在 done→archived 时保留。
      task.reportedAt = null
    } else if (patch.status === 'archived') {
      // done→archived 不改 reportedAt：不会重发历史回执。
      task.archivedAt = stamp
    } else if (patch.status === 'todo') {
      // 回到待开始：重新排队派发，清掉上一轮的派发记账。
      task.startedAt = null
      task.finishedAt = null
      task.archivedAt = null
      task.notifiedAt = null
      task.notificationCount = 0
      task.assignee = ''
      task.reportedAt = null
      // 重新排队后由轮询投递、归组长审核：不再是「宿主自动任务」，别再被 subagent/end 自动 done（§1.8）。
      task.autoDispatch = null
    }
  }
  if (patch.title !== undefined) {
    const title = trimmed(patch.title, MAX_TITLE_CHARS)
    if (title === '') throw new BoardError('bad-request', '标题不能为空')
    task.title = title
  }
  if (patch.note !== undefined) task.note = truncateNote(patch.note, MAX_NOTE_CHARS)
  if (patch.result !== undefined) task.result = truncateNote(patch.result, MAX_NOTE_CHARS)
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
 * 选所有可派发的任务（纯函数，按优先级排序）：
 *  - 只看 todo；
 *  - 通知次数达上限的不再投递；
 *  - 冷却期内不重复投递；
 *  - 按 createdAt、再按 id 数字序。
 * 返回数组而不是单条：tick 会逐条试目标（某个任务的目标会话正忙时，不能挡住其它任务）。
 */
export function selectDispatchCandidates(state, now = Date.now()) {
  const config = normalizeConfig(state.config)
  const cooldown = notifyCooldownMs(config)
  return state.tasks
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
}

/** 选下一条要派发的任务（= 候选列表的第一条）。 */
export function selectDispatchCandidate(state, now = Date.now()) {
  return selectDispatchCandidates(state, now)[0] || null
}

function idNumber(id) {
  const match = /^t-(\d+)$/.exec(String(id))
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

/**
 * 解析派发目标（全自动，用户不需要选会话）：
 *  1. 任务来自某个对话（task.sessionId 有值）且该会话在线 → 优先回那个对话（工作区绑定）：
 *     空闲就派；正在跑就等下一轮（creator-busy），不改派别的会话；
 *     历史/冷会话唤醒不了就等（creator-cold）；
 *  2. 任务指定了工作区（task.cwd，平台看板创建的）→ 优先找**同一工作区**的空闲会话；
 *     找不到就等（workspace-offline / workspace-busy），不改派到别的工作区（除非 force）；
 *  3. 都没有 → 优先「任务看板 · 工作区组长（自动）」的空闲 root Agent；再退化到任意空闲 root Agent；
 *  4. 完全没有会话 → agent-busy / no-live-agent。
 * @returns {{agent: object|null, reason: string}}
 */
export function resolveTargetAgent(agentsService, task = null, presetOf = headerPresetOf, options = {}) {
  if (!agentsService || typeof agentsService.get !== 'function') {
    return { agent: null, reason: 'no-agents-service' }
  }
  if (options.ignoreCreator !== true && task && typeof task.sessionId === 'string' && task.sessionId !== '') {
    const creator = agentsService.get(task.sessionId)
    if (creator) {
      // force = 用户手动点「立即派发」：即使创建它的对话正忙，也把消息排进它的下一轮。
      if (creator.status === 'idle' || options.force === true) return { agent: creator, reason: 'creator-session' }
      return { agent: null, reason: 'creator-busy' }
    }
    // 创建它的对话不在线、又唤醒不了（历史会话被 UI 持有 writer 等）：
    // 默认**不**改派到别的工作区，等用户在那边发一条消息把它变成 live；只有手动「立即派发」才退化。
    if (options.force !== true) return { agent: null, reason: 'creator-cold' }
  }
  let roots = []
  try {
    roots = typeof agentsService.roots === 'function' ? agentsService.roots() : []
  } catch {
    roots = []
  }
  const idle = roots.filter((agent) => agent && agent.status === 'idle')
  const wantPath = task && typeof task.cwd === 'string' ? normalizePathForCompare(task.cwd) : ''
  if (wantPath !== '') {
    const inWorkspace = idle.filter((agent) => normalizePathForCompare(sessionCwd(agent)) === wantPath)
    if (inWorkspace.length > 0) return { agent: inWorkspace[inWorkspace.length - 1], reason: 'workspace-session' }
    if (options.force !== true) {
      const anyInWorkspace = roots.some((agent) => normalizePathForCompare(sessionCwd(agent)) === wantPath)
      return { agent: null, reason: anyInWorkspace ? 'workspace-busy' : 'workspace-offline' }
    }
  }
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

/**
 * 任务工作区的 key（§1.5 第 3 步）：命中 workspaceRegistry 用工作区 id，
 * 否则用归一化 cwd。key 同时是 config.workspaceLeads 的键与 snapshot.leads.workspaces[].key。
 */
/**
 * 归档会话 id 集合（v0.2.0 兜底）：workspaceRegistry.archivedSessionIds。
 * 归档会话会被 archived-session-gate 拒绝模型步进，组长/主会话被归档后必须视为不可用。
 * 服务缺失（headless / 单测）时返回空集合。
 */
export function archivedSessionIdSet(rt) {
  try {
    const registry = serviceOf(rt && rt.ctx, 'workspaceRegistry')
    const ids = registry && Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : []
    return new Set(ids.filter((id) => typeof id === 'string' && id !== ''))
  } catch {
    return new Set()
  }
}

/**
 * 工作区组长会话失效（被归档）时，把它名下「进行中」的任务重排回待开始，
 * 交给新组长重新接单；done / archived 任务不动。
 * @returns {number} 重排的任务数
 */
export function requeueTasksOfLead(state, sessionId, now = Date.now()) {
  if (!state || !Array.isArray(state.tasks)) return 0
  if (typeof sessionId !== 'string' || sessionId === '') return 0
  const stamp = iso(now)
  let requeued = 0
  for (const task of state.tasks) {
    if (!task || task.status !== 'doing' || task.dispatchedSessionId !== sessionId) continue
    task.status = 'todo'
    task.startedAt = null
    task.finishedAt = null
    task.notifiedAt = null
    task.notificationCount = 0
    task.assignee = ''
    task.dispatchedSessionId = null
    task.dispatchedSessionTitle = ''
    // 重排回 todo = 回到轮询队列、归新组长审核：清掉自动任务标记（§1.8），不再被宿主自动 done。
    task.autoDispatch = null
    task.lastError = '工作区组长会话已归档，任务已重新排队，将投给新的组长'
    task.updatedAt = stamp
    requeued += 1
  }
  return requeued
}

/** 删除一个工作区组长映射；返回是否发生了变化。 */
function dropWorkspaceLeadMapping(rt, key) {
  const config = normalizeConfig(rt.state.config)
  if (!Object.prototype.hasOwnProperty.call(config.workspaceLeads, key)) return false
  const next = { ...config.workspaceLeads }
  delete next[key]
  config.workspaceLeads = next
  rt.state.config = config
  return true
}

export function workspaceKeyForCwd(ctx, cwd) {
  const workspaceId = workspaceIdForCwd(ctx, cwd)
  if (workspaceId !== '') return workspaceId
  return normalizePathForCompare(cwd)
}

/**
 * 从 config（或 workspaceLeads 对象）里取工作区 key 对应的组长映射。
 * 不存在 / 条目缺 sessionId 或 cwd → null（normalizeConfig 已丢弃非法条目，这里再兜一层）。
 */
export function selectWorkspaceLead(leadsOrConfig, key) {
  const leads =
    isPlainObject(leadsOrConfig) && isPlainObject(leadsOrConfig.workspaceLeads) ? leadsOrConfig.workspaceLeads : leadsOrConfig
  if (!isPlainObject(leads) || typeof key !== 'string' || key === '') return null
  const entry = leads[key]
  if (!isPlainObject(entry)) return null
  if (typeof entry.sessionId !== 'string' || entry.sessionId === '') return null
  if (typeof entry.cwd !== 'string' || entry.cwd === '') return null
  return entry
}

/** 从一个会话 id 解析它的工作区（cwd）：先查 live Agent，再查 live Session。 */
export function resolveSessionCwd(ctx, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null
  const readers = [
    () => {
      const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      const header = agent && agent.session ? agent.session.header : undefined
      return header && typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : null
    },
    () => {
      const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
      const header = session ? session.header : undefined
      return header && typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : null
    },
  ]
  for (const read of readers) {
    try {
      const cwd = read()
      if (cwd) return cwd
    } catch {
      /* 下一个读法 */
    }
  }
  return null
}

/**
 * 冷会话（历史会话被打开但还没产生 live agent）的 cwd 兜底：查 sessionQuery 的会话列表。
 * 只在 sync 读法拿不到时用，代价是一次 listSessions()。
 */
export async function resolveSessionCwdViaQuery(ctx, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null
  try {
    const query = ctx && typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
    if (!query || typeof query.listSessions !== 'function') return null
    const records = await query.listSessions()
    const hit = (Array.isArray(records) ? records : []).find(
      (record) => record && record.header && record.header.id === sessionId,
    )
    const cwd = hit && hit.header && typeof hit.header.cwd === 'string' ? hit.header.cwd : ''
    return cwd !== '' ? cwd : null
  } catch {
    return null
  }
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
      '不通过就 send_message 打回同一个子 Agent 重做，任务保持 doing。' +
      '写 result 时用 Markdown（小标题、- 列表、| 表格 |、`代码`），看板详情浮层会按 Markdown 渲染，' +
      '一段大白话在详情里很难读。子 Agent 的汇报也要求同样的 Markdown 结构。',
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

/**
 * 请求体上限（纯函数，§3）：只有 `upload-attachment` 放宽到约 7 MB（base64 膨胀 4/3），
 * 其它端点保持 512 KB——避免把大图传成通用入口。
 */
export function bodyLimitFor(endpoint) {
  return endpoint === 'upload-attachment' ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES
}

export async function handleHttp(rt, req, res) {
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
    // 图片上传的 base64 会膨胀 4/3：只给这个端点放宽，其它端点保持 512 KB 上限。
    const body = await readRequestBody(req, bodyLimitFor(endpoint))
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

/** 路径取尾段作为展示名（Windows 反斜杠 / POSIX 都吃）。 */
export function baseName(path) {
  if (typeof path !== 'string' || path === '') return ''
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

/** 是否 Windows 风格路径（盘符或反斜杠）：只有它们才按大小写不敏感比较。 */
export function isWindowsStylePath(path) {
  return typeof path === 'string' && (/^[A-Za-z]:[\\/]/.test(path) || path.includes('\\'))
}

/**
 * 路径比较用归一化：统一反斜杠、去尾斜杠。
 * Windows 风格路径一律小写（看盘符/反斜杠，而不是宿主平台）——
 * Linux 上的 Web 端也可能管理 C:\ 路径，按平台判断会让同一目录被判成不同。
 */
export function normalizePathForCompare(path) {
  if (typeof path !== 'string' || path === '') return ''
  let value = path.replace(/\//g, '\\').replace(/\\+$/, '')
  if (isWindowsStylePath(path)) value = value.toLowerCase()
  return value
}

/** 读工作区注册表（Web 端 ctx.workspaceRegistry.list()）：平台看板用它列工作区。 */
export function listWorkspaces(rt) {
  const rows = []
  try {
    const registry = rt && rt.ctx && typeof rt.ctx.get === 'function' ? rt.ctx.get('workspaceRegistry') : undefined
    if (!registry || typeof registry.list !== 'function') return rows
    for (const workspace of registry.list()) {
      if (!workspace || typeof workspace.path !== 'string' || workspace.path === '') continue
      rows.push({
        id: typeof workspace.id === 'string' ? workspace.id : String(workspace.id),
        path: workspace.path,
        title:
          typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : baseName(workspace.path),
        status: typeof workspace.status === 'string' ? workspace.status : 'ok',
      })
    }
  } catch (error) {
    console.warn('[taskboard] 读工作区列表失败：' + describeError(error))
  }
  return rows
}

/** 绝对路径（/ 或 \ 开头，或 Windows 盘符 X:\ / X:/）——taskboard_add 的 workspace 直接当 cwd 用。 */
export function isAbsoluteWorkspacePath(value) {
  return typeof value === 'string' && (/^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value))
}

/**
 * taskboard_add.workspace 解析（§4.4）：
 *  - 绝对路径 → 原样返回，不查注册表；
 *  - 其它字符串 → workspaceRegistry 行依次匹配 id 精确、title 精确（大小写不敏感）、path 归一化比较，
 *    返回命中行的 path；
 *  - 解析不到 → 返回 ''（调用方抛「未知工作区：…」）。
 */
export function resolveWorkspaceTarget(value, workspaces) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (isAbsoluteWorkspacePath(text)) return text
  const rows = (Array.isArray(workspaces) ? workspaces : []).filter(
    (row) => row && typeof row.path === 'string' && row.path !== '',
  )
  for (const row of rows) {
    if (typeof row.id === 'string' && row.id === text) return row.path
  }
  const lowered = text.toLowerCase()
  for (const row of rows) {
    if (typeof row.title === 'string' && row.title !== '' && row.title.toLowerCase() === lowered) return row.path
  }
  const want = normalizePathForCompare(text)
  if (want !== '') {
    for (const row of rows) {
      if (normalizePathForCompare(row.path) === want) return row.path
    }
  }
  return ''
}

/**
 * 结论压成单行：折叠所有空白（Markdown 换行 / 列表 / 表格），截前 200 字（§1.6 完成回执）。
 */
export function flattenResultLine(text, max = RECEIPT_RESULT_CHARS) {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return flat.length > max ? flat.slice(0, max) : flat
}

/** 完成回执正文（§1.6）：一条 followup 消息汇总一批任务结论，要求主会话向用户汇总。 */
export function buildReceiptText(tasks, now = Date.now()) {
  const rows = Array.isArray(tasks) ? tasks : []
  const lines = ['【任务看板 · 汇报】以下 ' + rows.length + ' 条任务已完成：']
  for (const task of rows) {
    const summary = flattenResultLine(task && task.result)
    lines.push('- ' + task.id + ' ' + task.title + '：' + (summary === '' ? '（无结论）' : summary))
  }
  lines.push('')
  lines.push('请向用户汇总以上结论，不要重复执行任务。')
  lines.push('看板时间：' + iso(now))
  return lines.join('\n')
}

/**
 * 未汇报的完成任务（§1.6）：status==='done' 且 reportedAt 为空；按 updatedAt 升序，
 * 相同按 id 数字序；最多 limit 条（默认 10）。
 */
export function selectReceiptTasks(state, limit = MAX_RECEIPT_BATCH) {
  if (!state || !Array.isArray(state.tasks)) return []
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.round(Number(limit)) : MAX_RECEIPT_BATCH
  return state.tasks
    .filter((task) => task && task.status === 'done' && !task.reportedAt)
    .sort((a, b) => {
      const at = Date.parse(a.updatedAt)
      const bt = Date.parse(b.updatedAt)
      const left = Number.isFinite(at) ? at : 0
      const right = Number.isFinite(bt) ? bt : 0
      if (left !== right) return left - right
      return idNumber(a.id) - idNumber(b.id)
    })
    .slice(0, cap)
}

function liveAgentOf(agents, sessionId) {
  if (!agents || typeof agents.get !== 'function') return undefined
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    return agents.get(sessionId)
  } catch {
    return undefined
  }
}

/** 主会话运行时视图（§3.1.1 MainSessionRef）；config.mainSessionId 为空时返回 null。 */
export function buildMainSessionRef(config, agents, archived = new Set()) {
  const cfg = normalizeConfig(config)
  if (!cfg.mainSessionId) return null
  const agent = liveAgentOf(agents, cfg.mainSessionId)
  const live = !!agent
  const busy = live && agent.status === 'running'
  const title = live ? sessionTitle(agent) || cfg.mainSessionTitle : cfg.mainSessionTitle
  return { sessionId: cfg.mainSessionId, title: title || '', live, busy, archived: archived.has(cfg.mainSessionId) }
}

/** 组长条上的工作区展示名：优先注册表 title，其次 cwd 尾段，best-effort。 */
function workspaceLabelFor(key, cwd, workspaces) {
  const rows = Array.isArray(workspaces) ? workspaces : []
  for (const row of rows) {
    if (row && typeof row.id === 'string' && row.id === key) {
      return typeof row.title === 'string' && row.title !== '' ? row.title : baseName(cwd)
    }
  }
  const want = normalizePathForCompare(cwd)
  if (want !== '') {
    for (const row of rows) {
      if (row && typeof row.path === 'string' && normalizePathForCompare(row.path) === want) {
        return typeof row.title === 'string' && row.title !== '' ? row.title : baseName(cwd)
      }
    }
  }
  return baseName(cwd)
}

/** 工作区组长运行时视图（snapshot.leads.workspaces，§3.2）：按 config.workspaceLeads 的对象键顺序。 */
export function buildWorkspaceLeadRefs(config, agents, workspaces, archived = new Set()) {
  const cfg = normalizeConfig(config)
  const rows = []
  for (const [key, entry] of Object.entries(cfg.workspaceLeads)) {
    const agent = liveAgentOf(agents, entry.sessionId)
    const live = !!agent
    const busy = live && agent.status === 'running'
    const title = live ? sessionTitle(agent) || entry.title : entry.title
    rows.push({
      key,
      label: workspaceLabelFor(key, entry.cwd, workspaces),
      cwd: entry.cwd,
      sessionId: entry.sessionId,
      title: title || '',
      live,
      busy,
      archived: archived.has(entry.sessionId),
    })
  }
  return rows
}

export function buildSnapshot(rt, now = Date.now(), preset = rt.presetInfo || null) {
  const config = normalizeConfig(rt.state.config)
  const agentsService = rt.ctx && typeof rt.ctx.get === 'function' ? rt.ctx.get('agents') : undefined
  const workspaces = listWorkspaces(rt)
  const archivedLeads = archivedSessionIdSet(rt)
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
      lastDispatchTaskId: rt.poll.lastDispatchTaskId || null,
      lastDispatchSessionId: rt.poll.lastDispatchSessionId || null,
      lastDispatchSessionTitle: rt.poll.lastDispatchSessionTitle || null,
      lastSkipReason: rt.poll.lastSkipReason || null,
    },
    agents: listAgents(rt),
    workspaces,
    // v0.2.0：组长 / 主会话运行时视图（组长条用；revision 不变也会变）。
    leads: {
      main: buildMainSessionRef(rt.state.config, agentsService, archivedLeads),
      workspaces: buildWorkspaceLeadRefs(rt.state.config, agentsService, workspaces, archivedLeads),
    },
    preset,
    // v0.2.0：组长直聊派活自动建任务的运行时视图（不落盘，§1.8）。
    leadAuto: normalizeLeadAuto(rt.leadAuto),
    boardPath: rt.filePath,
    pluginVersion: PLUGIN_VERSION,
    now: iso(now),
  }
}

/** 不读写看板状态的端点：不需要每次请求前对齐 board.json。 */
const BOARD_FREE_ENDPOINTS = new Set(['session-info', 'install-preset', 'upload-attachment', 'attachment'])

async function dispatchRpc(rt, method, payload) {
  // 每次请求前都对齐盘上状态：另一个进程（例如同时开着的测试实例）可能刚改过，
  // 读也要对齐，否则界面会一直显示旧内存状态（表现为「点了归档还是已完成」）。
  if (!BOARD_FREE_ENDPOINTS.has(method)) reloadBoardIfStale(rt)
  switch (method) {
    case 'snapshot':
      return buildSnapshot(rt, Date.now(), await refreshPresetInfo(rt))
    case 'add-task': {
      // 从哪个对话加的，就记下那个会话与工作区：派发时优先回这个对话执行。
      if (typeof payload.note === 'string') assertNoteAttachments(payload.note)
      let cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : resolveSessionCwd(rt.ctx, payload.sessionId)
      if (!cwd) cwd = await resolveSessionCwdViaQuery(rt.ctx, payload.sessionId)
      const task = addTask(rt.state, { ...payload, cwd })
      commitBoard(rt.state, rt.filePath)
      return { task }
    }
    case 'update-task': {
      const id = payload.id
      const rest = {}
      for (const key of Object.keys(payload)) if (key !== 'id' && key !== 'patch') rest[key] = payload[key]
      const patch = isPlainObject(payload.patch) ? payload.patch : rest
      if (typeof patch.note === 'string') assertNoteAttachments(patch.note)
      const task = applyTaskUpdate(rt.state, id, patch)
      commitBoard(rt.state, rt.filePath)
      // 任务刚变成 done（或从 done 重开）：顺手尝试 flush 完成回执（§1.6 flush 时机）。
      await flushReceipts(rt)
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
    case 'bind-main-session': {
      // v0.2.0：把会话绑定为主会话（完成回执收件人）；不要求当前在线（历史会话也能先绑）。
      return bindMainSession(rt, payload.sessionId)
    }
    case 'clear-main-session': {
      // v0.2.0：解除绑定（幂等）。
      return clearMainSession(rt)
    }
    case 'ensure-workspace-lead': {
      // v0.2.0：确保 cwd 所属工作区有可用常驻组长（复用 → 唤醒 → 必要时创建并修复映射）。
      return ensureWorkspaceLead(rt, payload.cwd)
    }
    case 'session-info': {
      // 给 client 用：冷会话（历史会话）不在 snapshot.agents 里，也能拿到它的工作区做提示。
      const cwd = resolveSessionCwd(rt.ctx, payload.sessionId) || (await resolveSessionCwdViaQuery(rt.ctx, payload.sessionId))
      return { sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null, cwd }
    }
    case 'upload-attachment': {
      // v0.2.0：粘贴图片上传。优先复用 DSH 附件服务（ctx.attachments），缺失时自建存储（§2.1）。
      return saveAttachment(payload.dataUrl, {
        name: payload.name,
        attachmentsService: serviceOf(rt.ctx, 'attachments'),
      })
    }
    case 'attachment': {
      // v0.2.0：按随机 id 读取附件，返回可给 <img src> 的 data URL。
      return readAttachment(payload.id, { attachmentsService: serviceOf(rt.ctx, 'attachments') })
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
  // v0.2.0 工作区组长路由（§1.5 跳过原因表；Client 用 poll.skip.<reason> 做 i18n）。
  'lead-busy': '工作区组长正在运行，等它空下来再派',
  'lead-unavailable': '工作区组长不可用：稍后重试，或在看板点「创建组长」',
  'lead-no-workspace': '无法解析任务的工作区：请从目标工作区的会话里重新加这条任务',
  'creator-busy': '创建这条任务的对话正在运行，等它空下来再派',
  'creator-cold': '创建这条任务的对话还没激活（历史会话）：在那边发一条消息，任务就会回到该对话执行；急的话点「立即派发」',
  'workspace-busy': '这条任务所属工作区的对话正在忙，等它空下来再派',
  'workspace-offline': '这条任务所属工作区没有打开的对话：先在那个工作区开一个对话，或点「立即派发」改派',
  'agent-offline': '任务指定的会话不在线',
  'no-live-agent': '没有在线的会话',
  'no-agents-service': 'agents 服务不可用',
  'followup-failed': '投递消息失败',
}

function skipText(reason) {
  return SKIP_TEXT[reason] || ''
}

/**
 * 「派发到新对话」：在任务所属工作区新建一个派单模式的会话，把任务投给它。
 * 失败返回 null（调用方退回自动挑会话），不抛。
 */
export function workspaceIdForCwd(ctx, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  const want = normalizePathForCompare(cwd)
  if (want === '') return ''
  try {
    const registry = ctx && typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    if (!registry || typeof registry.list !== 'function') return ''
    const hit = registry.list().find((workspace) => workspace && typeof workspace.path === 'string' && normalizePathForCompare(workspace.path) === want)
    return hit && typeof hit.id === 'string' ? hit.id : ''
  } catch {
    return ''
  }
}

async function createDispatchSession(rt, task) {
  try {
    const controller = typeof rt.ctx.get === 'function' ? rt.ctx.get('sessionController') : undefined
    if (!controller || typeof controller.create !== 'function') return null
    let cwd = task && typeof task.cwd === 'string' && task.cwd !== '' ? task.cwd : resolveSessionCwd(rt.ctx, task && task.sessionId)
    if (!cwd) cwd = await resolveSessionCwdViaQuery(rt.ctx, task && task.sessionId)
    if (!cwd) return null
    // 优先按工作区创建：这样新对话会落在任务所属工作区分组里，而不是「未分组」。
    const workspaceId = workspaceIdForCwd(rt.ctx, cwd)
    let created = null
    if (workspaceId !== '') {
      try {
        created = await controller.create({ workspaceId, agentPreset: DISPATCH_PRESET_ID })
      } catch (error) {
        console.warn('[taskboard] 按工作区新建对话失败，退回按 cwd 新建：' + describeError(error))
        created = null
      }
    }
    if (!created) created = await controller.create({ cwd, agentPreset: DISPATCH_PRESET_ID })
    const sessionId = created && typeof created.sessionId === 'string' ? created.sessionId : ''
    if (sessionId === '') return null
    const agents = typeof rt.ctx.get === 'function' ? rt.ctx.get('agents') : undefined
    let agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (!agent && typeof controller.resolveAgent === 'function') {
      const resolved = await controller.resolveAgent(sessionId)
      if (resolved && resolved.agent) agent = resolved.agent
    }
    if (!agent) return null
    console.log('[taskboard] 任务 ' + (task && task.id) + ' 新建对话：' + sessionId + '（' + cwd + '）')
    return agent
  } catch (error) {
    console.warn('[taskboard] 新建派发对话失败：' + describeError(error))
    return null
  }
}

/** 取服务（ctx.get 在不完整测试 / 非 Web profile 里可能没有）。 */
function serviceOf(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * 拿 live Agent；没有就尝试 sessionController.resolveAgent 唤醒。
 * 工作区组长路由用（§1.5），与旧模式 reviveSessionAgent 的区别：不做 5 分钟负缓存，
 * 组长偶尔被关掉后能马上恢复。
 */
async function resolveAgentForSession(rt, sessionId) {
  const live = liveAgentOf(serviceOf(rt.ctx, 'agents'), sessionId)
  if (live) return live
  const controller = serviceOf(rt.ctx, 'sessionController')
  if (!controller || typeof controller.resolveAgent !== 'function') return null
  try {
    const result = await controller.resolveAgent(sessionId)
    if (result && result.agent) return result.agent
    if (result && result.error) {
      console.warn('[taskboard] 唤醒会话 ' + sessionId + ' 失败：' + (result.error.code || 'unknown'))
    }
  } catch (error) {
    console.warn('[taskboard] 唤醒会话 ' + sessionId + ' 异常：' + describeError(error))
  }
  return null
}

/**
 * 创建一个工作区常驻组长（§1.5 第 5 步 / §3.1.1）：
 * 按 cwd 所属工作区创建 taskboard-dispatch 会话（解析不到 workspaceId 时退回 cwd），
 * 成功后写 config.workspaceLeads 并 commitBoard。一个工作区最多一个组长。
 * @returns {Promise<{entry?: object, agent?: object|null, error?: BoardError}>}
 */
async function createWorkspaceLeadSession(rt, cwd, key, now = Date.now()) {
  const controller = serviceOf(rt.ctx, 'sessionController')
  if (!controller || typeof controller.create !== 'function') {
    return { error: new BoardError('internal', '无法创建工作区组长：sessionController 不可用') }
  }
  // 优先按工作区分组创建；失败（例如工作区创建被拒）退回按 cwd 创建，不丢任务。
  const workspaceId = workspaceIdForCwd(rt.ctx, cwd)
  let created = null
  if (workspaceId !== '') {
    try {
      created = await controller.create({ workspaceId, agentPreset: DISPATCH_PRESET_ID })
    } catch (error) {
      console.warn('[taskboard] 按工作区创建工作区组长失败，退回按 cwd 创建：' + describeError(error))
      created = null
    }
  }
  if (!created) {
    try {
      created = await controller.create({ cwd, agentPreset: DISPATCH_PRESET_ID })
    } catch (error) {
      return { error: new BoardError('internal', '无法创建工作区组长：' + describeError(error)) }
    }
  }
  const sessionId = created && typeof created.sessionId === 'string' ? created.sessionId : ''
  if (sessionId === '') return { error: new BoardError('internal', '无法创建工作区组长：没有拿到会话 id') }
  const agent = await resolveAgentForSession(rt, sessionId)
  const config = normalizeConfig(rt.state.config)
  const entry = { sessionId, title: agent ? sessionTitle(agent) : '', cwd, createdAt: iso(now) }
  config.workspaceLeads = putWorkspaceLead(config.workspaceLeads, key, entry)
  rt.state.config = config
  commitBoard(rt.state, rt.filePath)
  console.log('[taskboard] 工作区组长已创建：' + key + ' → ' + sessionId)
  return { entry, agent }
}

/** 修复已有映射里为空的 title / cwd（§3.1.1 第 2 步），有改动才落盘。 */
function repairWorkspaceLeadMapping(rt, mapping, key, cwd, agent) {
  let changed = false
  const next = { ...mapping }
  if (next.title === '' && agent) {
    const title = sessionTitle(agent)
    if (title !== '') {
      next.title = title
      changed = true
    }
  }
  if (next.cwd === '' && typeof cwd === 'string' && cwd !== '') {
    next.cwd = cwd
    changed = true
  }
  if (!changed) return
  const config = normalizeConfig(rt.state.config)
  config.workspaceLeads = { ...config.workspaceLeads, [key]: next }
  rt.state.config = config
  commitBoard(rt.state, rt.filePath)
}

/** 组装 LeadRef（§3.1.1）：live/busy 来自 live Agent，title 优先 live 标题、其次持久化映射。 */
function leadRefFrom(key, mapping, agent, archived = false) {
  const live = !!agent
  const busy = live && agent.status === 'running'
  const title = (live ? sessionTitle(agent) : '') || (mapping && mapping.title) || ''
  return {
    key,
    cwd: (mapping && mapping.cwd) || '',
    sessionId: (mapping && mapping.sessionId) || '',
    title: title || '',
    live,
    busy,
    archived,
  }
}

/**
 * 轮询派单入口。每次 tick 末尾都会尝试 flush 一次完成回执（§1.6）：
 * 回执投递不占用派发名额（未绑定主会话 / 主会话忙或离线时是 no-op）。
 */
export async function tick(rt, options = {}) {
  const result = await runTick(rt, options)
  try {
    await flushReceipts(rt)
  } catch (error) {
    console.warn('[taskboard] 完成回执 flush 失败：' + describeError(error))
  }
  return result
}

async function runTick(rt, options = {}) {
  reloadBoardIfStale(rt)
  const now = Date.now()
  rt.poll.lastRunAt = iso(now)
  const config = normalizeConfig(rt.state.config)
  if (!config.pollEnabled && !options.taskId) {
    rt.poll.lastSkipReason = 'poll-disabled'
    return { dispatched: false, reason: 'poll-disabled' }
  }
  let candidates = []
  if (options.taskId) {
    const single = findTask(rt.state, options.taskId)
    if (single.status !== 'todo') throw new BoardError('conflict', '只有待开始的任务可以立即派发（当前状态：' + single.status + '）')
    candidates = [single]
  } else {
    candidates = selectDispatchCandidates(rt.state, now)
    if (candidates.length === 0) {
      rt.poll.lastSkipReason = null
      return { dispatched: false, reason: 'no-candidate' }
    }
  }
  const agents = serviceOf(rt.ctx, 'agents')

  // v0.2.0 默认：按任务工作区投给该工作区的常驻组长（§1.5）。绝不每任务新建会话。
  if (config.dispatchMode === 'workspace-lead') {
    const picked = await pickWorkspaceLeadTarget(rt, candidates, config, agents, options, now)
    if (!picked) return { dispatched: false, reason: rt.poll.lastSkipReason || 'lead-unavailable' }
    return deliverBoardTask(rt, picked.task, picked.agent, now)
  }

  // 兼容模式（new / creator / auto，§1.7）：沿用旧路由。
  const presetOf = (agent) => sessionPresetOfContext(rt.ctx, agent)

  // 逐条试：某个任务的目标会话正忙时跳过它，继续看下一条，避免「一个忙会话挡住整列任务」。
  let task = null
  let resolved = { agent: null, reason: null }
  const mode = config.dispatchMode
  for (const candidate of candidates) {
    // 默认「派发到新对话」：在任务工作区新建一个派单模式会话，任务不会被塞进别人的对话里。
    if (mode === 'new') {
      const freshAgent = await createDispatchSession(rt, candidate)
      if (freshAgent) {
        task = candidate
        resolved = { agent: freshAgent, reason: 'new-session' }
        break
      }
      // 新建失败（没有 sessionController / 解析不到工作区 / 预设不可用）→ 退回自动挑会话
    }
    // 创建它的对话没 live agent（历史会话）→ 先试着唤醒它，任务回到用户当时的那个对话。
    if (mode !== 'auto' && candidate.sessionId) {
      const liveCreator = agents && typeof agents.get === 'function' ? agents.get(candidate.sessionId) : undefined
      if (!liveCreator) await reviveSessionAgent(rt, candidate.sessionId)
    }
    const attempt = resolveTargetAgent(agents, candidate, presetOf, {
      force: options.force === true,
      ignoreCreator: mode === 'auto',
    })
    if (!attempt.agent) {
      rt.poll.lastSkipReason = attempt.reason
      const text = skipText(attempt.reason)
      if (text !== '' && candidate.lastError !== text) {
        candidate.lastError = text
        candidate.updatedAt = iso(now)
        commitBoard(rt.state, rt.filePath)
      }
      continue
    }
    if (!options.force && attempt.agent.status !== 'idle') {
      rt.poll.lastSkipReason = 'agent-busy'
      continue
    }
    task = candidate
    resolved = attempt
    break
  }
  if (!task) return { dispatched: false, reason: rt.poll.lastSkipReason || 'no-live-agent' }
  return deliverBoardTask(rt, task, resolved.agent, now)
}

/**
 * 投递一条任务给目标 Agent（旧模式 / 工作区组长共用）：
 * followup + sessions.flush 成功后置 doing、记通知与 dispatchedSession*、清 lastError。
 */
async function deliverBoardTask(rt, task, agent, now) {
  const sessionId = agentSessionId(agent)
  // 创建时没能解析出工作区（会话还没 live）→ 投递前从目标会话补一次，派发文本就能带上工作目录。
  if (!task.cwd) {
    const cwd = sessionCwd(agent)
    if (cwd) task.cwd = cwd
  }
  const message = createBoardUserMessage(buildDispatchText(task, now))
  try {
    agent.followup(message)
    // 关键：等 inbox splice 落盘再记账，否则重启会丢消息但 notificationCount 已 +1。
    // 官方 dsh-schedule 的投递路径同样在 followup 之后 await sessions.flush。
    try {
      const sessions = serviceOf(rt.ctx, 'sessions')
      if (sessions && typeof sessions.flush === 'function') await sessions.flush(agent.session)
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
  task.lastError = ''
  // 投递成功即视为「进行中」：看板立刻反映已派发，不再依赖主 Agent 记得调 taskboard_update
  // （它照样可以再调一次 doing，迁移 doing→doing 合法）。
  if (task.status === 'todo') {
    task.status = 'doing'
    if (!task.startedAt) task.startedAt = iso(now)
  }
  rt.poll.lastDispatchAt = iso(now)
  rt.poll.lastDispatchSessionId = sessionId
  rt.poll.lastDispatchSessionTitle = sessionTitle(agent)
  task.dispatchedSessionId = sessionId
  task.dispatchedSessionTitle = sessionTitle(agent) || ''
  rt.poll.lastDispatchTaskId = task.id
  rt.poll.lastSkipReason = null
  commitBoard(rt.state, rt.filePath)
  return { dispatched: true, sessionId, task: { ...task } }
}

/** RPC `bind-main-session`（§3.1.1）：绑定完成回执收件人；不要求会话当前在线。 */
export async function bindMainSession(rt, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new BoardError('bad-request', 'sessionId 必须是非空字符串')
  }
  const id = sessionId.trim()
  const config = normalizeConfig(rt.state.config)
  const agents = serviceOf(rt.ctx, 'agents')
  const title = sessionTitle(liveAgentOf(agents, id))
  config.mainSessionId = id
  // 尽力取 live Agent 标题；取不到保留原值 / 空串。
  if (title !== '') config.mainSessionTitle = title
  rt.state.config = config
  commitBoard(rt.state, rt.filePath)
  return { main: buildMainSessionRef(config, agents, archivedSessionIdSet(rt)) }
}

/** RPC `clear-main-session`（§3.1.1）：解除绑定，幂等。 */
export async function clearMainSession(rt) {
  const config = normalizeConfig(rt.state.config)
  config.mainSessionId = null
  config.mainSessionTitle = ''
  rt.state.config = config
  commitBoard(rt.state, rt.filePath)
  return { ok: true }
}

/**
 * RPC `ensure-workspace-lead`（§3.1.1）：确保 cwd 所属工作区有可用常驻组长。
 * 复用已有映射（顺手修复 title/cwd）→ 唤醒冷会话 → 失败则创建新组长替换失效映射。
 */
export async function ensureWorkspaceLead(rt, cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new BoardError('bad-request', 'cwd 必须是非空字符串')
  }
  const target = cwd.trim()
  const now = Date.now()
  const key = workspaceKeyForCwd(rt.ctx, target)
  if (key === '') throw new BoardError('bad-request', '无法从 cwd 解析工作区')
  const config = normalizeConfig(rt.state.config)
  let mapping = selectWorkspaceLead(config, key)
  const agents = serviceOf(rt.ctx, 'agents')
  // 组长会话被归档 → 视为失效映射：删除它、重排其 doing 任务，随后创建新组长替换。
  if (mapping && archivedSessionIdSet(rt).has(mapping.sessionId)) {
    dropWorkspaceLeadMapping(rt, key)
    requeueTasksOfLead(rt.state, mapping.sessionId, now)
    commitBoard(rt.state, rt.filePath)
    console.warn('[taskboard] 工作区组长会话已归档，创建新组长替换：' + key)
    mapping = null
    config.workspaceLeads = normalizeConfig(rt.state.config).workspaceLeads
  }
  if (mapping) {
    let agent = liveAgentOf(agents, mapping.sessionId)
    if (!agent) agent = await resolveAgentForSession(rt, mapping.sessionId)
    if (agent) {
      repairWorkspaceLeadMapping(rt, mapping, key, target, agent)
      return { lead: leadRefFrom(key, mapping, agent) }
    }
    // 已有映射但唤醒失败：create 新组长替换（tick 不自动重建，修复走这里）。
    console.log('[taskboard] 工作区组长 ' + key + ' 唤醒失败，创建新组长替换映射')
  }
  const created = await createWorkspaceLeadSession(rt, target, key, now)
  if (created.error) throw created.error
  // 会话已创建但 agent 还没物化时照样返回 LeadRef（live=false），UI 状态点会显示离线并可重试。
  return { lead: leadRefFrom(key, created.entry, created.agent) }
}

/**
 * 完成回执 flush（§1.6）：把 status==='done' && reportedAt=null 的任务合并成一条
 * 「【任务看板 · 汇报】」消息投给主会话（≤10 条/批，updatedAt 升序）。
 * 主会话未绑定 / 离线 / 忙 → 本轮不发、不唤醒；投递失败只告警，不写 reportedAt。
 */
export async function flushReceipts(rt, now = Date.now()) {
  if (!rt || !rt.state) return { sent: false, reason: 'no-state' }
  if (rt.flushingReceipts) return { sent: false, reason: 'in-flight' }
  const config = normalizeConfig(rt.state.config)
  if (!config.mainSessionId) return { sent: false, reason: 'no-main-session' }
  // 主会话被归档：归档门会拒绝它的模型步进，别投递也别记账（§1.6）。
  if (archivedSessionIdSet(rt).has(config.mainSessionId)) return { sent: false, reason: 'main-archived' }
  const batch = selectReceiptTasks(rt.state, MAX_RECEIPT_BATCH)
  if (batch.length === 0) return { sent: false, reason: 'no-receipt' }
  const agent = liveAgentOf(serviceOf(rt.ctx, 'agents'), config.mainSessionId)
  if (!agent) return { sent: false, reason: 'main-offline' }
  if (agent.status !== 'idle') return { sent: false, reason: 'main-busy' }
  rt.flushingReceipts = true
  try {
    const stamp = iso(now)
    const message = createBoardUserMessage(buildReceiptText(batch, now))
    try {
      agent.followup(message)
      // 与派发路径一致：等 inbox splice 落盘再记账，避免重启后消息丢了但 reportedAt 已写。
      try {
        const sessions = serviceOf(rt.ctx, 'sessions')
        if (sessions && typeof sessions.flush === 'function') await sessions.flush(agent.session)
      } catch (flushError) {
        console.warn('[taskboard] 回执会话 flush 失败（消息已入队）：' + describeError(flushError))
      }
    } catch (error) {
      console.warn('[taskboard] 完成回执投递失败：' + describeError(error))
      return { sent: false, reason: 'followup-failed' }
    }
    for (const task of batch) task.reportedAt = stamp
    commitBoard(rt.state, rt.filePath)
    return { sent: true, count: batch.length, sessionId: config.mainSessionId }
  } finally {
    rt.flushingReceipts = false
  }
}

/**
 * 工作区组长路由（§1.5）：解析任务 cwd → 工作区 key → 复用/创建常驻组长。
 * 绝不 createDispatchSession（每任务新建），也绝不跨工作区改派。
 * @returns {Promise<{ok:true, agent:object, key:string}|{ok:false, reason:string}>}
 */
async function routeWorkspaceLead(rt, task, config, agents, options, now) {
  let cwd = typeof task.cwd === 'string' && task.cwd !== '' ? task.cwd : null
  if (!cwd) {
    // 任务创建时没解析出工作区（会话还没 live / 历史任务）→ 从创建会话补一次。
    cwd = resolveSessionCwd(rt.ctx, task.sessionId) || (await resolveSessionCwdViaQuery(rt.ctx, task.sessionId))
    if (cwd) task.cwd = cwd
  }
  if (!cwd) return { ok: false, reason: 'lead-no-workspace' }
  const key = workspaceKeyForCwd(rt.ctx, cwd)
  if (key === '') return { ok: false, reason: 'lead-no-workspace' }
  let mapping = selectWorkspaceLead(config, key)
  // 组长会话被归档（归档门会拒绝它的模型步进）→ 视为失效：删映射、重排它名下 doing
  // 任务，本轮直接进入「懒创建」分支换一个新组长（§1.5）。绝不 unarchive 用户的归档动作。
  if (mapping && archivedSessionIdSet(rt).has(mapping.sessionId)) {
    dropWorkspaceLeadMapping(rt, key)
    requeueTasksOfLead(rt.state, mapping.sessionId, now)
    commitBoard(rt.state, rt.filePath)
    console.warn('[taskboard] 工作区组长会话已归档，重建：' + key)
    mapping = null
    config.workspaceLeads = normalizeConfig(rt.state.config).workspaceLeads
  }
  if (mapping) {
    // 已有映射：live → 判忙闲；没有 live → 尝试唤醒（tick 绝不自动重建已有映射）。
    let agent = liveAgentOf(agents, mapping.sessionId)
    if (!agent) agent = await resolveAgentForSession(rt, mapping.sessionId)
    if (!agent) return { ok: false, reason: 'lead-unavailable' }
    // force（立即派发）时组长忙也把消息排进它的下一轮，与旧模式 creator-busy 的 force 语义一致。
    if (agent.status !== 'idle' && options.force !== true) return { ok: false, reason: 'lead-busy' }
    return { ok: true, agent, key }
  }
  // 没有映射 → 懒创建本工作区的常驻组长（一个工作区一个，不是每任务一个）。
  const created = await createWorkspaceLeadSession(rt, cwd, key, now)
  if (created.error) {
    console.warn('[taskboard] ' + created.error.message)
    return { ok: false, reason: 'lead-unavailable' }
  }
  // 让本轮后续候选也能看到刚写入的映射，避免同一工作区在同一个 tick 里重复创建组长。
  if (created.entry) config.workspaceLeads = putWorkspaceLead(config.workspaceLeads, key, created.entry)
  if (!created.agent) return { ok: false, reason: 'lead-unavailable' }
  if (created.agent.status !== 'idle' && options.force !== true) return { ok: false, reason: 'lead-busy' }
  return { ok: true, agent: created.agent, key }
}

/** workspace-lead 模式的候选遍历：组长忙/不可用时写原因并继续下一条候选，成功即结束本轮（每轮最多 1 条）。 */
async function pickWorkspaceLeadTarget(rt, candidates, config, agents, options, now) {
  for (const candidate of candidates) {
    const cwdBefore = candidate.cwd
    const route = await routeWorkspaceLead(rt, candidate, config, agents, options, now)
    if (route.ok) return { task: candidate, agent: route.agent }
    rt.poll.lastSkipReason = route.reason
    const text = skipText(route.reason)
    let changed = candidate.cwd !== cwdBefore
    if (text !== '' && candidate.lastError !== text) {
      candidate.lastError = text
      candidate.updatedAt = iso(now)
      changed = true
    }
    if (changed) commitBoard(rt.state, rt.filePath)
  }
  return null
}

/** 唤醒失败缓存：同一会话 5 分钟内不重复尝试 resume。 */
/* ------------------------------------------------------------------ *
 * 组长直聊派活 → 自动建看板任务（§1.8）
 *
 * 用户可以直接打开工作区组长会话要求它派活（不经过轮询投递）：组长 subagent 派 worker 时看板上
 * 本来没有任务，闭环就断了。这里用两条**事件监听**补一条任务（不改任何工具定义）：
 *  - tools/result（观察事件）→ `exec.name === 'subagent'` 成功返回 {kind:'activation', subagentId} 且
 *    调用方是工作区组长 → 建一条 doing 任务（assignee = worker 会话 id，autoDispatch = 'lead-dispatch'）；
 *  - subagent/end（生命周期事件）→ 按 assignee 找回**带标记的**任务，worker completed 就置 done +
 *    result 并 flush 完成回执；其它 / 缺省 stopReason 只写**任务** lastError、任务保持 doing。
 *    轮询投递任务没有标记（notifiedAt 非空），宿主绝不自动收尾——那是组长审核 + 打回的范围。
 *
 * 标准 tool-call 与 PTC（run_code）都经过同一个 ToolExecutionPipeline，因此挂钩对两种模式等价；
 * 绕过 tools 管线直调 ctx.subagents.startActivation() 的第三方插件不覆盖（§1.8 适用边界）。
 * 建任务 / 回写失败只记 leadAuto.lastError（只装挂钩自身异常），绝不阻断派发。
 * ------------------------------------------------------------------ */

/** 组长直聊派活挂钩的运行时视图（不落盘，进 Snapshot.leadAuto）。 */
export function createLeadAutoState(now = Date.now()) {
  return {
    enabled: false,
    created: 0,
    deduped: 0,
    completed: 0,
    skipped: 0,
    lastError: '',
    lastErrorAt: null,
    lastTaskId: null,
    lastWorkerSessionId: null,
    updatedAt: iso(now),
  }
}

function counterOf(value) {
  const num = Number(value)
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0
}

/** 规范化 Snapshot.leadAuto：老 runtime / 缺字段也能安全读取。 */
export function normalizeLeadAuto(raw) {
  const source = isPlainObject(raw) ? raw : {}
  return {
    enabled: source.enabled === true,
    created: counterOf(source.created),
    deduped: counterOf(source.deduped),
    completed: counterOf(source.completed),
    skipped: counterOf(source.skipped),
    lastError: trimmed(source.lastError, 500),
    lastErrorAt: asString(source.lastErrorAt) || null,
    lastTaskId: asString(source.lastTaskId) || null,
    lastWorkerSessionId: asString(source.lastWorkerSessionId) || null,
    updatedAt: asString(source.updatedAt) || null,
  }
}

function ensureLeadAuto(rt) {
  if (!isPlainObject(rt.leadAuto)) rt.leadAuto = createLeadAutoState()
  return rt.leadAuto
}

/** 挂钩失败统一入口：只记 lastError + console.warn，绝不抛出（§1.8 失败不阻断派发）。 */
function recordLeadAutoError(rt, message, now = Date.now()) {
  const auto = ensureLeadAuto(rt)
  auto.lastError = trimmed(message, 500)
  auto.lastErrorAt = iso(now)
  auto.updatedAt = iso(now)
  console.warn('[taskboard] ' + auto.lastError)
}

/** worker 会话 id（= 任务 assignee）对应的**宿主自动建**任务：同一 worker 只建一条（§1.8 去重）。 */
export function findTaskByWorker(state, workerSessionId) {
  const id = trimmed(workerSessionId, 200)
  if (!state || !Array.isArray(state.tasks) || id === '') return null
  for (let i = state.tasks.length - 1; i >= 0; i--) {
    const task = state.tasks[i]
    if (!task || task.assignee !== id) continue
    // 只认带标记的任务：轮询投递任务的 assignee 也可能被组长写成 worker 会话 id，
    // 那是组长审核的对象，绝不能被宿主自动收尾（§1.8 完成回写）。
    if (task.autoDispatch !== LEAD_AUTO_MARK) continue
    return task
  }
  return null
}

/** 这条任务是不是 §1.8 挂钩自动建的（只有它们才允许 `subagent/end` 自动置 done）。 */
export function isLeadAutoTask(task) {
  return isPlainObject(task) && task.autoDispatch === LEAD_AUTO_MARK
}

/**
 * 该组长名下「轮询投递」的进行中任务（= 它正在处理看板任务，别为同一次派发再建一条）。
 * 只看 notifiedAt 非空的任务：宿主自动建的直聊任务 notifiedAt 为 null，不会挡住下一次直聊派活。
 * 超过 `LEAD_IN_FLIGHT_TTL_MS` 没有更新（worker 长跑 / 组长卡死）视为陈旧、不再挡住直聊派活（§1.8）。
 */
export function findLeadInFlightTask(state, leadSessionId, now = Date.now()) {
  const id = typeof leadSessionId === 'string' ? leadSessionId.trim() : ''
  if (!state || !Array.isArray(state.tasks) || id === '') return null
  const hit =
    state.tasks.find(
      (task) => task && task.status === 'doing' && task.dispatchedSessionId === id && asString(task.notifiedAt) !== '',
    ) || null
  if (!hit) return null
  const stamp = Date.parse(asString(hit.updatedAt) || asString(hit.startedAt) || asString(hit.notifiedAt))
  if (Number.isFinite(stamp) && now - stamp > LEAD_IN_FLIGHT_TTL_MS) return null
  return hit
}

/** subagent 工具的 prompt 入参取文本（字符串或 ContentBlock[]，防御式）。 */
export function subagentPromptText(args) {
  if (!isPlainObject(args)) return ''
  const prompt = args.prompt
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  return prompt
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

/** 派发摘要里的第一行：跳过纯装饰行（分隔线），去掉行首 Markdown 标记（`#` / `- ` / `* ` / `> `）。 */
export function firstDispatchLine(text) {
  const source = typeof text === 'string' ? text : ''
  if (source === '') return ''
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || /^[\s#>*+\-=_]+$/.test(line)) continue
    return line.replace(/^(?:#{1,6}\s+|[-*+>]\s+)/, '').trim()
  }
  return ''
}

/** 自动建任务的标题：description → prompt 第一行 → 「worker <尾 8>」。 */
export function leadTaskTitle(args, childId = '') {
  const description = isPlainObject(args) ? trimmed(args.description, MAX_TITLE_CHARS) : ''
  if (description !== '') return description
  const line = trimmed(firstDispatchLine(subagentPromptText(args)), MAX_TITLE_CHARS)
  if (line !== '') return line
  const tail = trimmed(childId, 200).slice(-8)
  return tail === '' ? 'worker' : 'worker ' + tail
}

/** subagent/end 里的最终回答文本（写进任务 result）。 */
export function workerResultText(info) {
  const blocks = info && info.lastAssistantMessage
  if (!Array.isArray(blocks)) return ''
  const text = blocks
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((part) => part !== '')
    .join('\n')
    .trim()
  return truncateNote(text, MAX_NOTE_CHARS)
}

/**
 * cwd → 工作区注册表里的规范 path（§1.8 建任务的 workspace）：
 * `workspaceIdForCwd` 命中时用 registry 的 `path`，让看板的工作区过滤与注册表一致；
 * 命中不了（没注册表 / 不属于任何工作区）就原样返回 cwd。
 */
export function workspacePathForCwd(ctx, cwd) {
  const raw = typeof cwd === 'string' ? cwd : ''
  const id = workspaceIdForCwd(ctx, raw)
  if (id === '') return raw
  try {
    const registry = serviceOf(ctx, 'workspaceRegistry')
    const list = registry && typeof registry.list === 'function' ? registry.list() : []
    const hit = Array.isArray(list)
      ? list.find((workspace) => workspace && workspace.id === id && typeof workspace.path === 'string' && workspace.path !== '')
      : undefined
    if (hit) return hit.path
  } catch {
    /* 退回原 cwd */
  }
  return raw
}

/**
 * tools/result 命中「工作区组长成功派出 worker」时建一条看板任务（§1.8）。
 * 只做副作用：永不抛出（失败只记 leadAuto.lastError），不阻断派发。
 * @param {{agent:object, childId:string, args?:object}} input
 * @returns {{created:boolean, reason?:string, taskId?:string, task?:object}}
 */
export function handleSubagentDispatch(rt, input, now = Date.now()) {
  const auto = ensureLeadAuto(rt)
  try {
    const agent = input && input.agent
    const childId = trimmed(input && input.childId, 200)
    if (!agent || childId === '') {
      auto.skipped += 1
      auto.updatedAt = iso(now)
      return { created: false, reason: 'skipped' }
    }
    // 只认工作区组长（taskboard-dispatch）的派发：普通会话派子 Agent 不进看板。
    if (sessionPresetOfContext(rt.ctx, agent) !== DISPATCH_PRESET_ID) {
      auto.skipped += 1
      auto.updatedAt = iso(now)
      return { created: false, reason: 'not-lead' }
    }
    reloadBoardIfStale(rt)
    const existing = findTaskByWorker(rt.state, childId)
    if (existing) {
      auto.deduped += 1
      auto.updatedAt = iso(now)
      return { created: false, reason: 'dedup-worker', taskId: existing.id }
    }
    const sessionId = agentSessionId(agent) || ''
    const inFlight = findLeadInFlightTask(rt.state, sessionId, now)
    if (inFlight) {
      // 组长正在处理轮询投递来的看板任务（且未陈旧）：这次 subagent 就是那条任务的 worker，别再建一条。
      auto.deduped += 1
      auto.updatedAt = iso(now)
      return { created: false, reason: 'lead-task-in-flight', taskId: inFlight.id }
    }
    const args = input && input.args
    const title = leadTaskTitle(args, childId)
    const note = truncateNote(subagentPromptText(args), MAX_NOTE_CHARS)
    // workspace = 组长当前工作区（cwd 映射：header.cwd → sessions 服务 → 派发入参 cwd），
    // 命中工作区注册表时用注册表的规范 path（workspaceIdForCwd，§1.8）。
    const rawCwd = sessionCwd(agent) || resolveSessionCwd(rt.ctx, sessionId) || (isPlainObject(args) ? asString(args.cwd) : '')
    const cwd = workspacePathForCwd(rt.ctx, rawCwd)
    const task = addTask(rt.state, { title, note, source: 'agent', sessionId, cwd }, now)
    applyTaskUpdate(rt.state, task.id, { status: 'doing', assignee: childId }, now)
    // 持久化标记：只有带这个标记的任务才允许 subagent/end 自动收尾（§1.8 / §2）。
    task.autoDispatch = LEAD_AUTO_MARK
    task.dispatchedSessionId = sessionId || null
    task.dispatchedSessionTitle = sessionTitle(agent)
    task.lastError = ''
    task.updatedAt = iso(now)
    const saved = commitBoard(rt.state, rt.filePath)
    auto.created += 1
    auto.lastTaskId = task.id
    auto.lastWorkerSessionId = childId
    auto.updatedAt = iso(now)
    if (saved && saved.saved === false) {
      // 写盘失败不删任务（内存仍是真源），只记错误，派发照常继续。
      recordLeadAutoError(rt, '看板写盘失败（任务只在内存里）：' + (saved.error || ''), now)
    } else {
      console.log('[taskboard] 组长直聊派活已建任务：' + task.id + ' ← worker 会话 ' + childId)
    }
    return { created: true, taskId: task.id, task: { ...task } }
  } catch (error) {
    recordLeadAutoError(rt, '自动建看板任务失败：' + describeError(error), now)
    return { created: false, reason: 'error', error: describeError(error) }
  }
}

/**
 * subagent/end：worker 结束 → **宿主自动建的任务**置 done + result（§1.8），并 flush 完成回执（§1.6）。
 * 只认带 `autoDispatch === 'lead-dispatch'` 标记的任务：轮询投递任务的 assignee 也可能被组长写成 worker
 * 会话 id，那是组长审核的对象，宿主绝不抢先置 done（否则组长来不及取证、也无法打回）。
 * `stopReason` 只认精确的 'completed'：缺字段 / 未知值一律按非 completed 处理（保持 doing + 写 lastError）。
 * 非 completed 只写**任务** lastError（`leadAuto.lastError` 只记挂钩自身异常）；找不到任务直接忽略。
 */
export async function handleSubagentEnd(rt, info, now = Date.now()) {
  const auto = ensureLeadAuto(rt)
  try {
    const childId = trimmed(info && info.id, 200)
    if (childId === '') {
      auto.skipped += 1
      auto.updatedAt = iso(now)
      return { updated: false, reason: 'skipped' }
    }
    reloadBoardIfStale(rt)
    const task = findTaskByWorker(rt.state, childId)
    if (!task) {
      // 不是宿主建的自动任务（例如组长审核时派去跑命令的验证子 Agent，
      // 或轮询投递任务的 worker——那条任务的 autoDispatch 为 null）。
      auto.skipped += 1
      auto.updatedAt = iso(now)
      return { updated: false, reason: 'no-task' }
    }
    if (!isLeadAutoTask(task) || asString(task.notifiedAt) !== '') {
      // 兜底：findTaskByWorker 已经过滤过，这里再挡一层，确保轮询任务（notifiedAt 非空）永不被自动 done。
      auto.skipped += 1
      auto.updatedAt = iso(now)
      return { updated: false, reason: 'not-auto', taskId: task.id }
    }
    const result = workerResultText(info)
    // 缺字段 / 空串 / 未知值一律按非 completed 处理（绝不静默置 done）：文案里缺省写 unknown。
    const rawStopReason = asString(info && info.stopReason).trim()
    const stopReason = rawStopReason === '' ? 'unknown' : rawStopReason
    const wasDoing = task.status === 'doing'
    if (stopReason !== 'completed') {
      if (!wasDoing) {
        // 组长已审（done）或任务不在这两个状态：worker 的失败不推翻结论，也不改状态。
        auto.skipped += 1
        auto.updatedAt = iso(now)
        return { updated: false, reason: 'worker-' + stopReason, taskId: task.id }
      }
      const detail = result === '' ? '没有返回结论' : flattenResultLine(result, RECEIPT_RESULT_CHARS)
      task.lastError = trimmed('worker 结束（' + stopReason + '）：' + detail, 500)
      task.updatedAt = iso(now)
      commitBoard(rt.state, rt.filePath)
      // 只写任务 lastError；leadAuto.lastError 语义是「挂钩自身失败原因」，不装派发结果。
      auto.lastTaskId = task.id
      auto.updatedAt = iso(now)
      console.warn('[taskboard] ' + task.lastError)
      return { updated: false, reason: 'worker-' + stopReason, taskId: task.id }
    }
    if (task.status !== 'doing' && task.status !== 'done') {
      auto.skipped += 1
      auto.updatedAt = iso(now)
      return { updated: false, reason: 'status-' + task.status, taskId: task.id }
    }
    const patch = {}
    if (result !== '') patch.result = result
    // doing → done；已是 done（组长先审完 / 同一 worker 再次结束）就只刷新 result。
    if (wasDoing) patch.status = 'done'
    if (Object.keys(patch).length === 0) {
      auto.skipped += 1
      auto.updatedAt = iso(now)
      return { updated: false, reason: 'no-change', taskId: task.id }
    }
    applyTaskUpdate(rt.state, task.id, patch, now)
    task.lastError = ''
    task.updatedAt = iso(now)
    commitBoard(rt.state, rt.filePath)
    // 只在真正的 doing→done 时计数；第二次结束只刷 result，不算又一次完成。
    if (wasDoing) auto.completed += 1
    auto.lastTaskId = task.id
    auto.lastWorkerSessionId = childId
    auto.updatedAt = iso(now)
    if (!wasDoing) {
      // 只刷新了 result：不重发回执（reportedAt 不变），flush 也不会把它再挑出来。
      return { updated: true, taskId: task.id, status: task.status, refreshed: true }
    }
    // 沿用 §1.6 完成回执链路（主会话未绑定 / 离线 / 忙时是 no-op）。
    try {
      await flushReceipts(rt, now)
    } catch (error) {
      console.warn('[taskboard] 完成回执 flush 失败：' + describeError(error))
    }
    return { updated: true, taskId: task.id, status: task.status }
  } catch (error) {
    recordLeadAutoError(rt, 'worker 完成回写失败：' + describeError(error), now)
    return { updated: false, reason: 'error', error: describeError(error) }
  }
}

/**
 * 注册 §1.8 的两条事件挂钩。只挂监听、不需要任何服务就绪；
 * `{ global: true }` 跳过 Cordis 的 scope 过滤（carrier 按调用 Agent 过滤），事件量极小，
 * 真正的过滤在 handler 里按预设 / assignee 做。监听器由插件 fiber 自动回收。
 * 注意：第三参 `{ global: true }` 是**必需**的（少了就收不到事件），单测必须断言它。
 * @returns {boolean} 是否注册成功
 */
export function registerLeadAutoHooks(ctx, rt) {
  if (!ctx || typeof ctx.on !== 'function') {
    console.warn('[taskboard] ctx.on 不可用，跳过组长直聊派活挂钩')
    return false
  }
  ctx.on(
    'tools/result',
    (exec, result) => {
      try {
        // §1.8 命中条件（三个条件缺一不可，避免别的工具输出里恰好带 subagentId 就误建任务）：
        //   exec.name === 'subagent' + 非错误结果 + value 是 {kind:'activation', subagentId}。
        if (!exec || exec.name !== 'subagent') return
        if (!result || result.isError === true) return
        const value = result.value
        if (!isPlainObject(value) || value.kind !== 'activation') return
        const childId = typeof value.subagentId === 'string' ? value.subagentId.trim() : ''
        if (childId === '') return
        const agent = exec.agent
        if (!agent) return
        handleSubagentDispatch(rt, { agent, childId, args: exec.arguments })
      } catch (error) {
        recordLeadAutoError(rt, '组长直聊派活挂钩失败：' + describeError(error))
      }
    },
    { global: true },
  )
  ctx.on(
    'subagent/end',
    (info) => {
      Promise.resolve()
        .then(() => handleSubagentEnd(rt, info))
        .catch((error) => recordLeadAutoError(rt, 'worker 完成挂钩失败：' + describeError(error)))
    },
    { global: true },
  )
  const auto = ensureLeadAuto(rt)
  auto.enabled = true
  auto.updatedAt = iso(Date.now())
  return true
}

/** 冷会话唤醒失败的负缓存时长（5 分钟）。 */
const REVIVE_RETRY_MS = 5 * 60 * 1000

/**
 * 把「创建任务的对话」从冷会话唤醒成 live agent（Web 端官方路径 sessionController.resolveAgent，
 * 与 UI 打开会话时的物化一致，带并发去重）。这样从历史会话右栏加的任务也能回到那个对话执行。
 * @returns {Promise<boolean>} 是否成功拿到 live agent
 */
async function reviveSessionAgent(rt, sessionId) {
  if (!sessionId) return false
  if (!rt.reviveFailures) rt.reviveFailures = new Map()
  const failedAt = rt.reviveFailures.get(sessionId)
  if (failedAt !== undefined && Date.now() - failedAt < REVIVE_RETRY_MS) return false
  const controller = typeof rt.ctx.get === 'function' ? rt.ctx.get('sessionController') : undefined
  if (!controller || typeof controller.resolveAgent !== 'function') return false
  try {
    const result = await controller.resolveAgent(sessionId)
    if (result && result.agent) {
      rt.reviveFailures.delete(sessionId)
      return true
    }
    const code = result && result.error && result.error.code ? result.error.code : 'unknown'
    rt.reviveFailures.set(sessionId, Date.now())
    console.warn('[taskboard] 唤醒会话 ' + sessionId + ' 失败：' + code)
    return false
  } catch (error) {
    rt.reviveFailures.set(sessionId, Date.now())
    console.warn('[taskboard] 唤醒会话 ' + sessionId + ' 异常：' + describeError(error))
    return false
  }
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

export const TASK_LIST_OUTPUT_SCHEMA = {
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

/**
 * 三个模型工具共用的任务摘要（taskboard_list 的 tasks[] / taskboard_add / taskboard_update 的 task）。
 *
 * 这里的键必须全部在 output.schema 里声明：dsh tools 管线在 execute() 成功返回之后才校验 canonical
 * output，而两个 output.schema 都是 additionalProperties:false 的封闭契约——多带一个未声明字段就会抛
 * ToolOutputError（INVALID_TOOL_OUTPUT），此时 execute() 的副作用（写盘 / 状态迁移）已经生效，
 * 模型侧却只看到调用失败。UI 专用字段（dispatchedSessionId / sessionId / cwd 等）由 buildSnapshot()
 * 的完整任务对象提供，不要加进 taskBrief。回归测试见 test/host.test.mjs。
 */
export function taskBrief(task) {
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

export const TASK_ONE_OUTPUT_SCHEMA = {
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
export function registerTools(toolCtx, rt) {
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
      '轮询器会把它派给任务所属工作区的常驻组长。title 必填，note 写验收标准或补充信息；' +
      'workspace 可选（工作区 id / 名称 / 绝对路径），用于从主会话往其它工作区派任务。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', description: '任务标题（一句话，必填）' },
        note: { type: 'string', description: '备注：背景、范围、验收标准' },
        workspace: {
          type: 'string',
          description: '可选：任务所属工作区（工作区 id / 名称 / 绝对路径），省略则用当前会话工作区',
        },
      },
    },
    output: {
      schema: TASK_ONE_OUTPUT_SCHEMA,
      render: (_args, value) => renderTaskOne('已添加任务 ', value.task),
    },
    execute(args, exec) {
      const title = trimmed(args && args.title, MAX_TITLE_CHARS)
      if (title === '') throw new Error('title 不能为空')
      if (typeof (args && args.note) === 'string') assertNoteAttachments(args.note)
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
      // v0.2.0：workspace 参数（§4.4）——绝对路径直接用，否则按注册表 id / 名称 / 路径解析。
      const workspaceArg = trimmed(args && args.workspace, 500)
      if (workspaceArg !== '') {
        const resolved = resolveWorkspaceTarget(workspaceArg, listWorkspaces(rt))
        if (resolved === '') throw new Error('未知工作区：' + workspaceArg)
        cwd = resolved
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
    async execute(args) {
      if (!args || !args.id) throw new Error('缺少任务 id')
      const patch = {}
      for (const key of ['status', 'result', 'assignee', 'note']) {
        if (args[key] !== undefined) patch[key] = args[key]
      }
      if (typeof patch.note === 'string') assertNoteAttachments(patch.note)
      const task = applyTaskUpdate(rt.state, args.id, patch)
      commitBoard(rt.state, rt.filePath)
      // 任务刚变成 done（或从 done 重开）：顺手尝试 flush 完成回执（§1.6 flush 时机）。
      await flushReceipts(rt)
      return { task: taskBrief(task) }
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
    reviveFailures: new Map(),
    // 完成回执 flush 的并发保护：tick / RPC / 工具可能同时触发，避免同一批任务重复投递。
    flushingReceipts: false,
    poll: {
      running: false,
      lastRunAt: null,
      lastDispatchAt: null,
      lastDispatchTaskId: null,
      lastDispatchSessionId: null,
      lastDispatchSessionTitle: null,
      lastSkipReason: null,
    },
    // 组长直聊派活自动建任务（§1.8）的运行时计数 / 最近错误。
    leadAuto: createLeadAutoState(),
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

  // 组长直聊派活 → 自动建看板任务（§1.8）：只挂事件监听，不依赖任何服务就绪；
  // 监听器由插件 fiber 自动回收，失败也不阻断派发（只记 leadAuto.lastError）。
  try {
    if (registerLeadAutoHooks(ctx, runtime)) {
      console.log('[taskboard] 组长直聊派活挂钩已注册：tools/result + subagent/end')
    }
  } catch (error) {
    console.warn('[taskboard] 组长直聊派活挂钩注册失败：' + describeError(error))
  }
}
