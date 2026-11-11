import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/**
 * lib/client.js 的组件层渲染冒烟测试（无浏览器、无 react 依赖）。
 *
 * 契约已从「左侧栏入口 + main 页面」迁到「右侧栏 tab 类型 + 会话 header 入口」：
 *  - conversation.session.header.actions → HeaderBoardAction（按钮 .tb-headbtn + 待办角标）
 *  - sidebar.right.pane.tab             → BoardTab（窄栏 .tb-lanes / 宽栏 .tb-board）
 *  - sidebar.right.pane.tab.title       → BoardTabTitle（chip：glyph + 标题）
 *
 * 做法：
 *  1. node:vm 跑 bundle，stub window.__ModuleLoader__ 捕获 {id, factory}；
 *  2. 用桩 React 替换 require('react')：createElement 产出可遍历的 plain tree，
 *     useState 初始渲染等价于 [initial, noop]，useRef 返回 {current}，
 *     useCallback 按 deps 记忆化（保持引用稳定，避免 effect 抖动），
 *     useEffect 记录并在每次渲染后执行一次（清理函数只记录、不执行）；
 *  3. 小型驱动器在同一实例上支持 setState 触发的重渲染（最多 8 轮），
 *     所以 RPC 桩返回的 snapshot 能真正进入渲染，而不是只停在 null 初值；
 *  4. 假 ctx 支持 ctx.inject(deps, cb)（服务就绪才回调），右侧栏 tab 类型、
 *     右栏导航控制器分别提供桩；组件轮询走 ctx.interval（桩仅记录），
 *     window.setInterval 一次都不会被调用；沙箱里故意没有 ResizeObserver，
 *     因此宽度量不到 → BoardTab 默认窄栏。
 */

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/* ══════════════════════════════════════════════════════════════
 * 桩 React
 * ══════════════════════════════════════════════════════════════ */

let currentInstance = null

function flattenChildren(list) {
  const out = []
  for (const item of list) {
    if (Array.isArray(item)) out.push(...flattenChildren(item))
    else out.push(item)
  }
  return out
}

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: flattenChildren(children) }
}

function hookInstance() {
  if (currentInstance === null) {
    throw new Error('stub React: hook called outside a rendered component')
  }
  return currentInstance
}

function depsChanged(previous, next) {
  if (!previous || !next) return true
  if (previous.length !== next.length) return true
  for (let i = 0; i < previous.length; i += 1) {
    if (!Object.is(previous[i], next[i])) return true
  }
  return false
}

const ReactStub = {
  createElement,
  Fragment: 'Fragment',
  useState(initial) {
    return hookInstance().useState(initial)
  },
  useEffect(fn, deps) {
    hookInstance().useEffect(fn, deps)
  },
  useRef(initial) {
    return hookInstance().useRef(initial)
  },
  useCallback(fn, deps) {
    return hookInstance().useCallback(fn, deps)
  },
  useMemo(fn) {
    return fn()
  },
}

/* ══════════════════════════════════════════════════════════════
 * 树遍历工具
 * ══════════════════════════════════════════════════════════════ */

function expand(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') {
    return { type: '#text', props: {}, children: [], text: String(node) }
  }
  if (Array.isArray(node)) {
    return { type: '#fragment', props: {}, children: node.map(expand).filter(Boolean) }
  }
  if (typeof node !== 'object') {
    return { type: '#text', props: {}, children: [], text: String(node) }
  }
  const type = node.type
  const props = node.props || {}
  if (typeof type === 'function') {
    currentInstance = null // 子组件（Banner/Col/Card/BoardGlyph）不允许调用 hooks；一旦调用立刻显式失败
    return expand(type(props))
  }
  const children = Array.isArray(node.children) ? node.children.map(expand).filter(Boolean) : []
  return { type: String(type), props, children }
}

function collect(node, out = []) {
  if (!node) return out
  out.push(node)
  for (const child of node.children || []) collect(child, out)
  return out
}

function textOf(node) {
  if (!node) return ''
  if (node.type === '#text') return node.text
  return (node.children || []).map(textOf).join('')
}

function classOf(node) {
  const value = node && node.props ? node.props.className : ''
  return typeof value === 'string' ? value : ''
}

function hasClass(node, name) {
  return classOf(node).split(/\s+/).includes(name)
}

function nodesWithClass(tree, name) {
  return collect(tree).filter((node) => hasClass(node, name))
}

function buttons(tree) {
  return collect(tree).filter((node) => node.type === 'button')
}

function buttonTexts(tree) {
  return buttons(tree).map((node) => textOf(node).trim()).filter((text) => text !== '')
}

function includesText(tree, needle) {
  return textOf(tree).includes(needle)
}

/* ══════════════════════════════════════════════════════════════
 * 组件驱动器（支持 setState 重渲染；effect 只执行一次/按 deps）
 * ══════════════════════════════════════════════════════════════ */

class ComponentInstance {
  constructor(Component, props) {
    this.Component = Component
    this.props = props || {}
    this.hooks = []
    this.hookIndex = 0
    this.pendingEffects = []
    this.cleanups = []
    this.dirty = false
    this.passes = 0
  }

  useState(initial) {
    const index = this.hookIndex
    this.hookIndex += 1
    let hook = this.hooks[index]
    if (hook === undefined) {
      hook = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      this.hooks[index] = hook
    }
    const instance = this
    const setState = (next) => {
      const value = typeof next === 'function' ? next(hook.value) : next
      if (Object.is(value, hook.value)) return
      hook.value = value
      instance.dirty = true
    }
    return [hook.value, setState]
  }

  useRef(initial) {
    const index = this.hookIndex
    this.hookIndex += 1
    if (this.hooks[index] === undefined) this.hooks[index] = { kind: 'ref', current: initial }
    return this.hooks[index]
  }

  useCallback(fn, deps) {
    const index = this.hookIndex
    this.hookIndex += 1
    const hook = this.hooks[index]
    if (hook === undefined || depsChanged(hook.deps, deps)) {
      this.hooks[index] = { kind: 'callback', fn, deps }
      return fn
    }
    return hook.fn
  }

  useEffect(fn, deps) {
    const index = this.hookIndex
    this.hookIndex += 1
    const hook = this.hooks[index]
    if (hook === undefined || depsChanged(hook.deps, deps)) {
      this.hooks[index] = { kind: 'effect', deps }
      this.pendingEffects.push(fn)
    }
  }

  async runEffects() {
    const pending = this.pendingEffects
    this.pendingEffects = []
    for (const fn of pending) {
      const cleanup = fn()
      if (typeof cleanup === 'function') this.cleanups.push(cleanup)
    }
  }

  async run(maxPasses = 8) {
    let tree = null
    for (let pass = 0; pass < maxPasses; pass += 1) {
      this.passes = pass + 1
      this.dirty = false
      this.hookIndex = 0
      currentInstance = this
      let rendered
      try {
        rendered = this.Component(this.props)
      } finally {
        currentInstance = null
      }
      tree = expand(rendered)
      await this.runEffects()
      await new Promise((resolve) => setImmediate(resolve))
      if (!this.dirty) break
    }
    if (this.dirty) throw new Error('component did not settle within ' + String(maxPasses) + ' render passes')
    this.tree = tree
    return tree
  }
}

async function renderComponent(Component, props) {
  const instance = new ComponentInstance(Component, props)
  const tree = await instance.run()
  return { tree, instance }
}

/* ══════════════════════════════════════════════════════════════
 * bundle 加载 + 假宿主（slots / ctx.inject / connection / 右栏服务）
 * ══════════════════════════════════════════════════════════════ */

function createDocumentStub() {
  const styleTags = []
  const documentStub = {
    visibilityState: 'visible',
    querySelector(selector) {
      const match = /data-plugin-css="([^"]+)"/.exec(String(selector))
      if (!match) return null
      return styleTags.find((tag) => tag.attrs['data-plugin-css'] === match[1]) || null
    },
    createElement(tagName) {
      return {
        tagName,
        attrs: {},
        textContent: '',
        setAttribute(name, value) {
          this.attrs[name] = value
        },
        appendChild() {},
        removeChild() {
          const index = styleTags.indexOf(this)
          if (index >= 0) styleTags.splice(index, 1)
        },
      }
    },
    head: {
      appendChild(tag) {
        styleTags.push(tag)
      },
    },
    documentElement: { appendChild() {} },
    styleTags,
  }
  return documentStub
}

function createHarness(options = {}) {
  const captured = {}
  const warnings = []
  const sandboxErrors = []
  const sandboxConsole = {
    log() {},
    info() {},
    debug() {},
    warn(...args) {
      warnings.push(args.map((arg) => String(arg)).join(' '))
    },
    error(...args) {
      sandboxErrors.push(args.map((arg) => String(arg)).join(' '))
    },
  }
  const windowCounters = { setInterval: 0, clearInterval: 0, setTimeout: 0, clearTimeout: 0 }
  const documentStub = createDocumentStub()
  const fakeWindow = {
    __ModuleLoader__: {
      load(definition) {
        captured.definition = definition
      },
    },
    setInterval() {
      windowCounters.setInterval += 1
      return 0
    },
    clearInterval() {
      windowCounters.clearInterval += 1
    },
    setTimeout() {
      windowCounters.setTimeout += 1
      return 0
    },
    clearTimeout() {
      windowCounters.clearTimeout += 1
    },
    confirm: () => true,
  }

  // 注意：故意不提供 AbortSignal 和 ResizeObserver（覆盖降级分支，并让 BoardTab 走窄栏）。
  const sandbox = {
    window: fakeWindow,
    document: documentStub,
    console: sandboxConsole,
    Date,
    Math,
    JSON,
    Promise,
    String,
    Number,
    Object,
    Array,
    Symbol,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  vm.createContext(sandbox)
  vm.runInContext(clientSource, sandbox, { filename: 'lib/client.js' })

  assert.ok(captured.definition, 'window.__ModuleLoader__.load must be called')
  assert.equal(captured.definition.id, 'dsh-taskboard')
  assert.equal(typeof captured.definition.factory, 'function')

  const exported = captured.definition.factory((specifier) => {
    if (specifier === 'react') return ReactStub
    throw new Error('unexpected require: ' + specifier)
  })

  const rpcCalls = []
  const intervals = []
  const localeRegistrations = []
  const injectRequests = []
  const scopeEffects = []
  const registrations = []
  const tabs = { definitions: [], disposed: [] }
  const openTabCalls = []
  const defaultRpc = options.rpc || (() => Promise.resolve({ ok: true, value: options.snapshot || {} }))

  const tabsService = options.sidebarRightTabs === false ? undefined : {
    register(definition) {
      tabs.definitions.push(definition)
      return () => {
        tabs.disposed.push(definition.id)
        const index = tabs.definitions.indexOf(definition)
        if (index >= 0) tabs.definitions.splice(index, 1)
      }
    },
  }
  const sidebarRightService = options.sidebarRight === false ? undefined : {
    openTab(kind) {
      openTabCalls.push(kind)
    },
  }

  const services = {
    slots: {
      inject(_name, factory) {
        const dispose = factory()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(registration, component) {
        registrations.push({ options: registration, component })
        return () => {}
      },
    },
    connection: {
      rpc: {
        call(channel, endpoint, payload) {
          rpcCalls.push({ channel, endpoint, payload })
          return Promise.resolve(defaultRpc(channel, endpoint, payload))
        },
      },
    },
    locale: {
      register(namespace, lang, dict) {
        localeRegistrations.push({ namespace, lang, dict })
        return () => {}
      },
      unregister() {},
      bind: () => (key) => key,
      getLocale: () => ({ active: 'zh-CN' }),
    },
  }
  const scopeServices = { sidebarRightTabs: tabsService, sidebarRight: sidebarRightService }

  const effects = []
  const cleanups = []
  const fakeCtx = {
    get(name) {
      return services[name]
    },
    effect(fn) {
      effects.push(fn)
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {}
    },
    inject(deps, callback) {
      injectRequests.push([...deps])
      if (deps.some((dep) => scopeServices[dep] === undefined)) return () => {}
      const scope = {
        effect(fn, label) {
          const cleanup = fn()
          const entry = { label, cleanup }
          scopeEffects.push(entry)
          return () => {
            if (typeof cleanup === 'function') cleanup()
          }
        },
      }
      for (const dep of deps) scope[dep] = scopeServices[dep]
      callback(scope)
      return () => {}
    },
    interval(fn, ms) {
      const entry = { fn, ms }
      intervals.push(entry)
      return () => {
        const index = intervals.indexOf(entry)
        if (index >= 0) intervals.splice(index, 1)
      }
    },
    timeout() {
      return () => {}
    },
    on() {
      return () => {}
    },
  }

  exported.apply(fakeCtx)

  const componentOf = (name) => {
    const found = registrations.find((entry) => entry.options.name === name)
    assert.ok(found, 'slot ' + name + ' must be registered')
    return found.component
  }

  return {
    exported,
    registrations,
    componentOf,
    rpcCalls,
    intervals,
    localeRegistrations,
    injectRequests,
    scopeEffects,
    tabs,
    openTabCalls,
    document: documentStub,
    windowCounters,
    warnings,
    sandboxErrors,
    services,
    effects,
    cleanups,
  }
}

/* ══════════════════════════════════════════════════════════════
 * snapshot 夹具：4 个状态、5 条任务，config/poll/agents/preset/boardPath 齐全
 * ══════════════════════════════════════════════════════════════ */

const NOW = Date.now()
const minutesAgo = (n) => new Date(NOW - n * 60000).toISOString()

function makeSnapshot(overrides = {}) {
  return Object.assign(
    {
      version: 1,
      boardPath: 'C:\\Users\\duan\\.dsh\\storages\\taskboard\\board.json',
      pluginVersion: '0.1.0',
      config: { pollEnabled: true, pollIntervalMs: 15000 },
      poll: {
        lastRunAt: minutesAgo(1),
        lastDispatchAt: minutesAgo(3),
        lastDispatchSessionId: '0123456789abcdef',
        lastDispatchSessionTitle: '主会话',
        lastSkipReason: 'agent-busy',
      },
      agents: [
        { sessionId: '0123456789abcdef', title: '主会话', status: 'running' },
        { sessionId: 'fedcba9876543210', title: '备用会话', status: 'idle' },
      ],
      preset: {
        installed: false,
        path: 'bundle:presets/taskboard.patch.yml',
        reason: '当前部署没有 agentPresets 服务（需要 dsh-web-app profile）',
        restartRequired: false,
        broken: '',
      },
      tasks: [
        {
          id: 't-1',
          title: '梳理看板数据模型',
          status: 'todo',
          note: '先定 board.json 的字段',
          assignee: 'main',
          notificationCount: 3,
          updatedAt: minutesAgo(5),
        },
        {
          id: 't-2',
          title: '实现轮询自动派发',
          status: 'todo',
          source: 'agent',
          updatedAt: minutesAgo(12),
        },
        {
          id: 't-3',
          title: '写客户端渲染冒烟测试',
          status: 'doing',
          result: '四列已渲染',
          lastError: '上一次投递超时',
          updatedAt: minutesAgo(30),
        },
        {
          id: 't-4',
          title: '打通宿主 RPC',
          status: 'done',
          result: 'snapshot / add-task 已通',
          updatedAt: minutesAgo(90),
        },
        {
          id: 't-5',
          title: '归档过期的旧任务',
          status: 'archived',
          updatedAt: minutesAgo(180),
        },
      ],
    },
    overrides,
  )
}

const TASK_TITLES = [
  '梳理看板数据模型',
  '实现轮询自动派发',
  '写客户端渲染冒烟测试',
  '打通宿主 RPC',
  '归档过期的旧任务',
]

const COLUMN_TITLES = ['待开始', '进行中', '已完成', '已归档']

const CARD_BUTTONS = ['开始', '立即派发', '完成', '归档', '重新打开', '打回', '编辑', '删除']

/* ══════════════════════════════════════════════════════════════
 * 用例：会话 header 入口按钮
 * ══════════════════════════════════════════════════════════════ */

test('HeaderBoardAction：按钮 + glyph + 待办角标，点击打开右侧栏 taskboard tab', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const HeaderBoardAction = harness.componentOf('conversation.session.header.actions')
  const { tree, instance } = await renderComponent(HeaderBoardAction, {})

  assert.equal(tree.type, 'button')
  assert.ok(hasClass(tree, 'tb-headbtn'), 'header entry must be a .tb-headbtn button')
  assert.equal(tree.props.type, 'button')
  assert.equal(tree.props['aria-label'], '打开任务看板（右侧栏）')
  assert.match(String(tree.props.title), /2 个待开始任务/)

  const svg = collect(tree).find((node) => node.type === 'svg')
  assert.ok(svg, 'header entry must render the board glyph')
  assert.equal(svg.props.width, 16)
  assert.equal(svg.props.height, 16)
  assert.equal(collect(svg).filter((node) => node.type === 'rect').length, 4)

  const badge = nodesWithClass(tree, 'tb-badge')
  assert.equal(badge.length, 1, 'two todo tasks must show a badge')
  assert.equal(textOf(badge[0]), '2')

  // 只拉一次 snapshot；6s 轮询走 ctx.interval（没有真的启动）
  assert.deepEqual(harness.rpcCalls.map((call) => call.endpoint), ['snapshot'])
  assert.equal(harness.rpcCalls[0].channel, '/taskboard')
  assert.equal(harness.intervals.length, 1)
  assert.equal(harness.intervals[0].ms, 6000)
  assert.equal(harness.windowCounters.setInterval, 0)
  assert.ok(instance.cleanups.length >= 1, 'effect cleanup must be recorded')

  assert.doesNotThrow(() => tree.props.onClick())
  assert.deepEqual(harness.openTabCalls, ['taskboard'])
})

test('HeaderBoardAction：RPC 失败不崩无角标；右栏服务缺失时点击只告警', async () => {
  const failHarness = createHarness({
    rpc: () => Promise.resolve({ ok: false, error: { code: 'network', message: 'boom' } }),
  })
  const failTree = (await renderComponent(failHarness.componentOf('conversation.session.header.actions'), {})).tree
  assert.equal(nodesWithClass(failTree, 'tb-badge').length, 0)
  assert.equal(failTree.props.title, '任务看板')
  assert.equal(failTree.props['aria-label'], '打开任务看板（右侧栏）')
  failTree.props.onClick()
  assert.deepEqual(failHarness.openTabCalls, ['taskboard'])

  const missingHarness = createHarness({ snapshot: makeSnapshot(), sidebarRight: false })
  const missingTree = (await renderComponent(missingHarness.componentOf('conversation.session.header.actions'), {})).tree
  assert.doesNotThrow(() => missingTree.props.onClick())
  assert.deepEqual(missingHarness.openTabCalls, [])
  assert.ok(
    missingHarness.warnings.some((line) => line.includes('打开右侧看板失败')),
    'missing sidebarRight must degrade with a warning, got: ' + JSON.stringify(missingHarness.warnings),
  )
})

/* ══════════════════════════════════════════════════════════════
 * 用例：右栏 tab 标题 chip
 * ══════════════════════════════════════════════════════════════ */

test('BoardTabTitle：优先用宿主 tab 标题，缺省/抛错时退回「任务看板」', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const BoardTabTitle = harness.componentOf('sidebar.right.pane.tab.title')

  const withHost = await renderComponent(BoardTabTitle, {
    useTabInfo: () => ({ tab: { title: '任务看板 · 会话 A' } }),
  })
  assert.ok(hasClass(withHost.tree, 'tb-tabtitle'))
  assert.ok(includesText(withHost.tree, '任务看板 · 会话 A'), 'host tab title should win')
  const svg = collect(withHost.tree).find((node) => node.type === 'svg')
  assert.ok(svg, 'chip must carry the board glyph')
  assert.equal(svg.props.width, 14)

  const withoutHook = await renderComponent(BoardTabTitle, {})
  assert.ok(hasClass(withoutHook.tree, 'tb-tabtitle'))
  assert.ok(includesText(withoutHook.tree, '任务看板'))

  const brokenHook = await renderComponent(BoardTabTitle, {
    useTabInfo: () => {
      throw new Error('tab store unavailable')
    },
  })
  assert.ok(includesText(brokenHook.tree, '任务看板'), 'throwing useTabInfo must fall back to the local label')
})

/* ══════════════════════════════════════════════════════════════
 * 用例：BoardTab —— 窄栏（默认，无 ResizeObserver）
 * ══════════════════════════════════════════════════════════════ */

function renderNarrow(BoardTab) {
  return renderComponent(BoardTab, { useTabInfo: () => ({ sidebar: { fullscreen: false } }) })
}

function renderWide(BoardTab) {
  return renderComponent(BoardTab, { useTabInfo: () => ({ sidebar: { fullscreen: true } }) })
}

test('BoardTab（窄栏）：无 ResizeObserver 时用 .tb-lanes 纵向 lane，任务/字段/按钮齐全', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const BoardTab = harness.componentOf('sidebar.right.pane.tab')
  const { tree, instance } = await renderNarrow(BoardTab)

  assert.equal(tree.props['data-narrow'], 'true', 'narrow lane layout expected without ResizeObserver')
  assert.equal(nodesWithClass(tree, 'tb-lanes').length, 1, 'narrow uses .tb-lanes')
  assert.equal(nodesWithClass(tree, 'tb-board').length, 0, 'narrow must not render the four-column board')

  const columns = nodesWithClass(tree, 'tb-col')
  assert.equal(columns.length, 4, 'four status lanes must render')
  assert.deepEqual(
    columns.map((node) => node.props['data-status']),
    ['todo', 'doing', 'done', 'archived'],
  )
  for (const column of columns) {
    assert.equal(column.props['data-compact'], 'true', 'narrow lanes are compact')
  }
  const columnText = columns.map((node) => textOf(node)).join('|')
  for (const label of COLUMN_TITLES) {
    assert.ok(columnText.includes(label), 'missing column title: ' + label)
  }

  const cards = nodesWithClass(tree, 'tb-card')
  assert.equal(cards.length, 5, 'five task cards must render')
  const pageText = textOf(tree)
  for (const title of TASK_TITLES) {
    assert.ok(pageText.includes(title), 'missing task title: ' + title)
  }

  // 任务字段
  assert.ok(includesText(tree, '先定 board.json 的字段'), 'task note should render')
  assert.ok(includesText(tree, '结论: 四列已渲染'), 'task result should render')
  assert.ok(includesText(tree, '上一次投递超时'), 'task lastError should render')
  assert.ok(includesText(tree, '执行者: main'), 'task assignee should render')
  assert.ok(includesText(tree, '已通知 3 次'), 'notificationCount should render')
  assert.ok(includesText(tree, 'agent'), 'source=agent tag should render')
  assert.ok(includesText(tree, '5 分钟前'), 'relative time should render')

  // 按钮
  const labels = buttonTexts(tree)
  for (const label of CARD_BUTTONS) {
    assert.ok(labels.includes(label), 'missing card button: ' + label)
  }
  assert.ok(labels.includes('全部派发'), 'todo lane header needs 全部派发')
  assert.ok(labels.includes('全部归档'), 'done lane header needs 全部归档')
  assert.ok(labels.includes('刷新'), 'header needs 刷新')
  assert.ok(labels.includes('暂停轮询'), 'pollEnabled=true needs 暂停轮询')
  assert.ok(labels.includes('添加到待开始'), 'composer needs 添加到待开始')
  assert.ok(!labels.includes('同步模式预设'), '预设随 bundle 安装，不再有同步按钮')

  // 窄栏页脚只留版本号：没有 boardPath 的 <code>，也没有「数据文件」标签
  assert.equal(collect(tree).find((node) => node.type === 'code'), undefined)
  assert.ok(includesText(tree, 'v0.1.0'), 'narrow footer keeps the version')
  assert.ok(!includesText(tree, '数据文件'), 'narrow footer must drop the board path')

  // 预设未安装 → warn banner（带原因）
  const banners = nodesWithClass(tree, 'tb-banner')
  assert.equal(banners.length, 1, 'exactly one preset banner expected')
  assert.equal(banners[0].props['data-tone'], 'warn')
  assert.ok(includesText(banners[0], '没有找到「派单看板模式」'))
  assert.ok(includesText(banners[0], 'agentPresets'))

  // 只拉一次 snapshot；2 个 interval（轮询 + 相对时间）；清理函数记录 3 个
  assert.deepEqual(harness.rpcCalls.map((call) => call.endpoint), ['snapshot'])
  assert.equal(harness.intervals.length, 2)
  assert.equal(harness.windowCounters.setInterval, 0)
  assert.equal(instance.cleanups.length, 3, 'refresh/poll/tick effects should each record a cleanup')
})

test('BoardTab（窄栏）：轮询状态与派发 skip 原因照常渲染', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const { tree } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'))

  assert.ok(includesText(tree, '每 15s 轮询'))
  assert.ok(includesText(tree, '目标会话正在运行，稍后自动重试'))
  assert.ok(includesText(tree, '上次派发'))
  assert.ok(includesText(tree, '主会话'), 'last dispatch prefers the session title')
})

/* ══════════════════════════════════════════════════════════════
 * 用例：BoardTab —— 宽栏（全屏 / 拖宽后）
 * ══════════════════════════════════════════════════════════════ */

test('BoardTab（宽栏）：fullscreen 时用 .tb-board 四列，页脚含 boardPath，派发给下拉来自 agents', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const BoardTab = harness.componentOf('sidebar.right.pane.tab')
  const { tree } = await renderWide(BoardTab)

  assert.equal(tree.props['data-narrow'], 'false', 'fullscreen must use the wide layout')
  assert.equal(nodesWithClass(tree, 'tb-board').length, 1, 'wide uses .tb-board')
  assert.equal(nodesWithClass(tree, 'tb-lanes').length, 0, 'wide must not render narrow lanes')

  const columns = nodesWithClass(tree, 'tb-col')
  assert.equal(columns.length, 4)
  for (const column of columns) {
    assert.equal(column.props['data-compact'], 'false', 'wide columns are not compact')
  }
  assert.equal(nodesWithClass(tree, 'tb-card').length, 5)
  const pageText = textOf(tree)
  for (const title of TASK_TITLES) {
    assert.ok(pageText.includes(title), 'missing task title: ' + title)
  }

  const code = collect(tree).find((node) => node.type === 'code')
  assert.ok(code, 'wide footer must render a <code> node')
  assert.equal(textOf(code), 'C:\\Users\\duan\\.dsh\\storages\\taskboard\\board.json')
  assert.ok(includesText(tree, '数据文件'), 'wide footer keeps the path label')
  assert.ok(includesText(tree, '看板数据保存在本机'), 'wide footer keeps the tip')
  assert.ok(includesText(tree, 'v0.1.0'), 'footer version should render')

  const selects = collect(tree).filter((node) => node.type === 'select')
  assert.equal(selects.length, 2, 'interval select + target select')
  const targetSelect = selects[1]
  assert.equal(targetSelect.props['aria-label'], '派发给')
  const optionTexts = collect(targetSelect)
    .filter((node) => node.type === 'option')
    .map((node) => textOf(node))
  assert.ok(optionTexts.includes('自动（最近活跃会话）'), 'auto target option should render')
  assert.ok(optionTexts.includes('主会话 · running'), 'running agent option should render')
  assert.ok(optionTexts.includes('备用会话'), 'idle agent option should render')
})

test('BoardTab：派发给下拉带模式名与 id 尾 8 位', async () => {
  const snapshot = makeSnapshot({
    preset: {
      installed: true,
      path: 'bundle:presets/taskboard.patch.yml',
      broken: '',
      presets: [
        { id: 'taskboard-dispatch', name: '派单看板模式', broken: '' },
        { id: 'taskboard-worker', name: '派单看板模式 · 执行者', broken: '' },
      ],
    },
    agents: [
      {
        sessionId: 'session-aaaaaaaa-bbbb-cccc-dddd-eeff00112233',
        title: '',
        status: 'idle',
        preset: 'taskboard-dispatch',
      },
      { sessionId: 'session-11111111-2222-3333-4444-555566667777', title: '普通会话', status: 'running', preset: 'standard' },
    ],
  })
  const harness = createHarness({ snapshot })
  const { tree } = await renderWide(harness.componentOf('sidebar.right.pane.tab'))
  const selects = collect(tree).filter((node) => node.type === 'select')
  const targetSelect = selects[1]
  const optionTexts = collect(targetSelect)
    .filter((node) => node.type === 'option')
    .map((node) => textOf(node))
  assert.ok(
    optionTexts.includes('00112233 · 派单看板模式'),
    'untitled dispatcher session should show id tail + mode name, got: ' + JSON.stringify(optionTexts),
  )
  assert.ok(
    optionTexts.includes('普通会话 · running'),
    'standard-mode titled session keeps title/status and adds no unknown mode, got: ' + JSON.stringify(optionTexts),
  )
})

/* ══════════════════════════════════════════════════════════════
 * 用例：预设 banner 状态机（窄栏渲染，与布局无关）
 * ══════════════════════════════════════════════════════════════ */

test('BoardTab：preset 正常时不出现 banner；broken 时出现 error banner', async () => {
  const okSnapshot = makeSnapshot({
    preset: { installed: true, path: 'bundle:presets/taskboard.patch.yml', restartRequired: false, broken: '' },
  })
  const okHarness = createHarness({ snapshot: okSnapshot })
  const okTree = (await renderNarrow(okHarness.componentOf('sidebar.right.pane.tab'))).tree
  assert.equal(nodesWithClass(okTree, 'tb-banner').length, 0)

  const brokenSnapshot = makeSnapshot({
    preset: { installed: false, path: 'bundle:presets/taskboard.patch.yml', broken: 'row persona: boom' },
  })
  const brokenHarness = createHarness({ snapshot: brokenSnapshot })
  const brokenTree = (await renderNarrow(brokenHarness.componentOf('sidebar.right.pane.tab'))).tree
  const brokenBanners = nodesWithClass(brokenTree, 'tb-banner')
  assert.equal(brokenBanners.length, 1)
  assert.equal(brokenBanners[0].props['data-tone'], 'error')
  assert.equal(brokenBanners[0].props.role, 'alert')
  assert.ok(includesText(brokenBanners[0], '加载失败'))
  assert.ok(includesText(brokenBanners[0], 'row persona: boom'))
})

/* ══════════════════════════════════════════════════════════════
 * 用例：降级渲染
 * ══════════════════════════════════════════════════════════════ */

test('BoardTab：RPC 报错时降级渲染（错误 banner + 四列仍在，不抛异常）', async () => {
  const harness = createHarness({
    rpc: () => Promise.resolve({ ok: false, error: { code: 'network', message: 'connect ECONNREFUSED' } }),
  })
  const { tree } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'))

  assert.ok(hasClass(tree, 'tb-page'))
  assert.equal(tree.props['data-narrow'], 'true')
  assert.equal(nodesWithClass(tree, 'tb-col').length, 4, 'lanes must survive a failed snapshot')
  assert.equal(nodesWithClass(tree, 'tb-card').length, 0)
  const banners = nodesWithClass(tree, 'tb-banner')
  assert.equal(banners.length, 1)
  assert.equal(banners[0].props['data-tone'], 'error')
  assert.equal(banners[0].props.role, 'alert')
  assert.ok(includesText(banners[0], '连接看板服务失败：网络错误'))
  assert.ok(includesText(tree, '没有待开始的任务'))
})

test('BoardTab：snapshot 为空对象时降级渲染（四列空态，不抛异常）', async () => {
  const harness = createHarness({ snapshot: {} })
  const { tree } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'))

  assert.equal(nodesWithClass(tree, 'tb-col').length, 4)
  assert.equal(nodesWithClass(tree, 'tb-card').length, 0)
  for (const empty of [
    '没有待开始的任务',
    '没有正在执行的任务',
    '还没有完成的任务',
    '归档区是空的',
  ]) {
    assert.ok(includesText(tree, empty), 'missing empty state: ' + empty)
  }
  assert.ok(includesText(tree, '每 15s 轮询'), 'default config fallback should render')
  assert.equal(collect(tree).find((node) => node.type === 'code'), undefined)
})
