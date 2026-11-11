import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/**
 * lib/client.js 的组件层渲染冒烟测试（无浏览器、无 react 依赖）。
 *
 * 现在有两块看板：右侧栏「本工作区看板」（BoardTab）+ 左侧栏「平台任务看板」（PlatformBoard）：
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
  const defaultRpc = options.rpc || ((channel, endpoint, payload) => {
    if (endpoint === 'session-info') {
      return Promise.resolve({
        ok: true,
        value: { sessionId: payload && payload.sessionId, cwd: options.sessionCwd || null },
      })
    }
    return Promise.resolve({ ok: true, value: options.snapshot || {} })
  })

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
 * snapshot 夹具：2 个工作区、4 个状态、5 条任务（跨工作区 + 一条无 cwd）
 * ══════════════════════════════════════════════════════════════ */

const NOW = Date.now()
const minutesAgo = (n) => new Date(NOW - n * 60000).toISOString()

const WS_A = 'C:\\work\\a'
const WS_B = 'C:\\work\\b'

function makeSnapshot(overrides = {}) {
  return Object.assign(
    {
      version: 1,
      revision: 1,
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
      workspaces: [
        { id: 'w1', path: WS_A, title: '工作区 A', status: 'ok' },
        { id: 'w2', path: WS_B, title: '', status: 'ok' },
      ],
      agents: [
        { sessionId: '0123456789abcdef', title: '主会话', status: 'running', cwd: WS_A },
        { sessionId: 'fedcba9876543210', title: '备用会话', status: 'idle', cwd: WS_B },
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
          cwd: WS_A,
          note: '先定 board.json 的字段',
          assignee: 'main',
          notificationCount: 3,
          updatedAt: minutesAgo(5),
        },
        {
          id: 't-2',
          title: '实现轮询自动派发',
          status: 'todo',
          cwd: WS_B,
          source: 'agent',
          updatedAt: minutesAgo(12),
        },
        {
          id: 't-3',
          title: '写客户端渲染冒烟测试',
          status: 'doing',
          cwd: null,
          result: '四列已渲染',
          lastError: '上一次投递超时',
          updatedAt: minutesAgo(30),
        },
        {
          id: 't-4',
          title: '打通宿主 RPC',
          status: 'done',
          cwd: WS_A,
          result: 'snapshot / add-task 已通',
          updatedAt: minutesAgo(90),
        },
        {
          id: 't-5',
          title: '归档过期的旧任务',
          status: 'archived',
          cwd: WS_B,
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

const WS_A_TITLES = ['梳理看板数据模型', '打通宿主 RPC']
const COLUMN_TITLES = ['待开始', '进行中', '已完成', '已归档']
const CARD_BUTTONS = ['开始', '立即派发', '完成', '归档', '重新打开', '打回', '编辑', '删除']

/* ══════════════════════════════════════════════════════════════
 * 通用小工具
 * ══════════════════════════════════════════════════════════════ */

const SESSION_A = '0123456789abcdef'

function countCalls(harness, endpoint) {
  return harness.rpcCalls.filter((call) => call.endpoint === endpoint).length
}

function composerInput(tree) {
  return collect(tree).find((node) => node.type === 'input' && node.props.className === 'tb-input')
}

function submitButton(tree) {
  return buttons(tree).find((node) => textOf(node).trim() === '添加到待开始')
}

function selectByAria(tree, label) {
  return collect(tree).find((node) => node.type === 'select' && node.props['aria-label'] === label)
}

function optionTexts(select) {
  return collect(select)
    .filter((node) => node.type === 'option')
    .map((node) => textOf(node))
}

function renderNarrow(BoardTab, extraProps = {}) {
  return renderComponent(
    BoardTab,
    Object.assign({ useTabInfo: () => ({ sidebar: { fullscreen: false } }) }, extraProps),
  )
}

function renderWide(BoardTab, extraProps = {}) {
  return renderComponent(
    BoardTab,
    Object.assign({ useTabInfo: () => ({ sidebar: { fullscreen: true } }) }, extraProps),
  )
}

/** 输入标题 → 重渲染 → 点「添加到待开始」→ 等 RPC 落地。 */
async function addTaskByUi(render, titleValue) {
  const rendered = await render()
  const input = composerInput(rendered.tree)
  assert.ok(input, 'composer input must render')
  input.props.onChange({ target: { value: titleValue } })
  const filled = await rendered.instance.run()
  const submit = submitButton(filled)
  assert.ok(submit, 'submit button must render')
  assert.equal(submit.props.disabled, false, 'submit becomes enabled once the form is valid')
  submit.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  return rendered
}

/* ══════════════════════════════════════════════════════════════
 * 用例：会话 header 入口按钮（打开右侧栏）
 * ══════════════════════════════════════════════════════════════ */

test('HeaderBoardAction：按钮 + glyph + 待办角标，点击打开右侧栏 taskboard tab', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const HeaderBoardAction = harness.componentOf('conversation.session.header.actions')
  const { tree, instance } = await renderComponent(HeaderBoardAction, {})

  assert.equal(tree.type, 'button')
  assert.ok(hasClass(tree, 'tb-headbtn'), 'header entry must be a .tb-headbtn button')
  assert.equal(tree.props['aria-label'], '打开任务看板（右侧栏）')
  assert.match(String(tree.props.title), /2 个待开始任务/)

  const svg = collect(tree).find((node) => node.type === 'svg')
  assert.ok(svg, 'header entry must render the board glyph')
  assert.equal(svg.props.width, 16)
  assert.equal(collect(svg).filter((node) => node.type === 'rect').length, 4)

  const badge = nodesWithClass(tree, 'tb-badge')
  assert.equal(badge.length, 1, 'two todo tasks must show a badge')
  assert.equal(textOf(badge[0]), '2')

  assert.equal(countCalls(harness, 'snapshot'), 1)
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
  assert.ok(includesText(withoutHook.tree, '任务看板'))

  const brokenHook = await renderComponent(BoardTabTitle, {
    useTabInfo: () => {
      throw new Error('tab store unavailable')
    },
  })
  assert.ok(includesText(brokenHook.tree, '任务看板'), 'throwing useTabInfo must fall back to the local label')
})

/* ══════════════════════════════════════════════════════════════
 * 用例：BoardTab —— 本工作区看板（右栏）
 * ══════════════════════════════════════════════════════════════ */

test('BoardTab（窄栏）：只显示本工作区任务，.tb-lanes + 副标题带工作区名', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const BoardTab = harness.componentOf('sidebar.right.pane.tab')
  const { tree, instance } = await renderNarrow(BoardTab, { sessionId: SESSION_A })

  assert.equal(tree.props['data-narrow'], 'true', 'narrow lane layout expected without ResizeObserver')
  assert.equal(tree.props['data-layout'], 'narrow')
  assert.equal(nodesWithClass(tree, 'tb-lanes').length, 1, 'narrow uses .tb-lanes')
  assert.equal(nodesWithClass(tree, 'tb-board').length, 0, 'narrow must not render the four-column board')

  // 副标题带工作区名（workspaces 里按 path 匹配 title）
  assert.ok(includesText(tree, '工作区 A'), 'subtitle must name the current workspace')
  assert.equal(nodesWithClass(tree, 'tb-notice').length, 0, 'known workspace must not show the unknown notice')

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

  // 只显示 cwd 属于工作区 A 的两条任务
  const cards = nodesWithClass(tree, 'tb-card')
  assert.equal(cards.length, 2, 'only tasks of the current workspace render')
  const pageText = textOf(tree)
  for (const title of WS_A_TITLES) {
    assert.ok(pageText.includes(title), 'missing workspace task: ' + title)
  }
  for (const title of ['实现轮询自动派发', '写客户端渲染冒烟测试', '归档过期的旧任务']) {
    assert.ok(!pageText.includes(title), 'task from another workspace / no cwd must not render: ' + title)
  }

  // 工作区 A 的任务字段
  assert.ok(includesText(tree, '先定 board.json 的字段'), 'task note should render')
  assert.ok(includesText(tree, '结论: snapshot / add-task 已通'), 'task result should render')
  assert.ok(includesText(tree, '执行者: main'), 'task assignee should render')
  assert.ok(includesText(tree, '已通知 3 次'), 'notificationCount should render')
  assert.ok(includesText(tree, '5 分钟前'), 'relative time should render')
  assert.ok(!includesText(tree, '上一次投递超时'), 'lastError belongs to a task outside this workspace')

  const labels = buttonTexts(tree)
  for (const label of ['开始', '立即派发', '编辑', '删除', '归档', '打回', '全部派发', '全部归档', '刷新', '暂停轮询', '添加到待开始']) {
    assert.ok(labels.includes(label), 'missing card button: ' + label)
  }
  assert.ok(!labels.includes('同步模式预设'))
  assert.ok(!labels.includes('一键归档已完成'), 'platform-only button must not leak into the right board')

  // 窄栏页脚只留版本号
  assert.equal(collect(tree).find((node) => node.type === 'code'), undefined)
  assert.ok(includesText(tree, 'v0.1.0'))
  assert.ok(!includesText(tree, '数据文件'))

  // 预设未安装 → warn banner
  const banners = nodesWithClass(tree, 'tb-banner')
  assert.equal(banners.length, 1)
  assert.equal(banners[0].props['data-tone'], 'warn')
  assert.ok(includesText(banners[0], '没有找到「派单看板模式」'))

  // 一次 snapshot + 一次 session-info（挂载时问工作区）；轮询走 ctx.interval
  assert.equal(countCalls(harness, 'snapshot'), 1)
  assert.equal(countCalls(harness, 'session-info'), 1)
  assert.equal(harness.intervals.length, 2)
  assert.equal(harness.windowCounters.setInterval, 0)
  assert.equal(instance.cleanups.length, 3)
})

test('BoardTab（窄栏）：轮询状态与派发 skip 原因照常渲染', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const { tree } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })

  assert.ok(includesText(tree, '每 15s 轮询'))
  assert.ok(includesText(tree, '目标会话正在运行，稍后自动重试'))
  assert.ok(includesText(tree, '上次派发'))
  assert.ok(includesText(tree, '主会话'), 'last dispatch prefers the session title')
  assert.ok(includesText(tree, '工作区 A'))
})

test('BoardTab（宽栏）：fullscreen 时用 .tb-board 四列，页脚含 boardPath，且没有「派发给」选择器', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const BoardTab = harness.componentOf('sidebar.right.pane.tab')
  const { tree } = await renderWide(BoardTab, { sessionId: SESSION_A })

  assert.equal(tree.props['data-narrow'], 'false')
  assert.equal(tree.props['data-layout'], 'wide')
  assert.equal(nodesWithClass(tree, 'tb-board').length, 1)
  assert.equal(nodesWithClass(tree, 'tb-lanes').length, 0)

  const columns = nodesWithClass(tree, 'tb-col')
  assert.equal(columns.length, 4)
  for (const column of columns) {
    assert.equal(column.props['data-compact'], 'false')
  }
  assert.equal(nodesWithClass(tree, 'tb-card').length, 2)
  const pageText = textOf(tree)
  for (const title of WS_A_TITLES) {
    assert.ok(pageText.includes(title), 'missing workspace task: ' + title)
  }

  const code = collect(tree).find((node) => node.type === 'code')
  assert.ok(code, 'wide footer must render a <code> node')
  assert.equal(textOf(code), 'C:\\Users\\duan\\.dsh\\storages\\taskboard\\board.json')
  assert.ok(includesText(tree, '数据文件'))
  assert.ok(includesText(tree, '看板数据保存在本机'))
  assert.ok(includesText(tree, 'v0.1.0'))

  // 「派发给」选择器已被产品删除；本页只剩轮询间隔选择器
  const selects = collect(tree).filter((node) => node.type === 'select')
  assert.equal(selects.length, 1, 'only the poll-interval select remains')
  assert.equal(selects[0].props['aria-label'], undefined)
  assert.ok(!includesText(tree, '派发给'), 'dispatch-target selector must be gone')
  assert.ok(includesText(tree, '加进「待开始」后由主 Agent 自动接手'), 'composer shows the auto hint')
})

test('BoardTab：工作区未知（无 sessionId / 历史会话）时给说明条并显示空看板', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const { tree } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'))

  assert.equal(tree.props['data-narrow'], 'true')
  assert.equal(nodesWithClass(tree, 'tb-card').length, 0, 'unknown workspace shows no tasks')
  assert.equal(nodesWithClass(tree, 'tb-col').length, 4, 'empty board still renders the four lanes')
  const notices = nodesWithClass(tree, 'tb-notice')
  assert.equal(notices.length, 1)
  assert.ok(includesText(notices[0], '无法确定当前工作区'))
  assert.equal(countCalls(harness, 'session-info'), 0, 'no session id means no session-info probe')
  assert.equal(countCalls(harness, 'snapshot'), 1)
})

test('BoardTab：新建任务把当前会话 sessionId 带进 add-task payload（不带 cwd）', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  await addTaskByUi(
    () => renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: 'session-abc' }),
    '把任务绑定到本对话',
  )

  const addCall = harness.rpcCalls.find((call) => call.endpoint === 'add-task')
  assert.ok(addCall, 'clicking 添加到待开始 must call add-task')
  assert.equal(addCall.channel, '/taskboard')
  // payload 由 vm 沙箱里的组件创建，跨 realm 对象先拷回本 realm 再比较
  assert.deepEqual(Object.assign({}, addCall.payload), { title: '把任务绑定到本对话', sessionId: 'session-abc' })
  assert.equal('cwd' in addCall.payload, false, 'right board lets the host resolve cwd from sessionId')
})

test('BoardTab：没有 sessionId 时 add-task payload 不带会话绑定', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  await addTaskByUi(() => renderNarrow(harness.componentOf('sidebar.right.pane.tab')), '普通任务')

  const addCall = harness.rpcCalls.find((call) => call.endpoint === 'add-task')
  assert.ok(addCall)
  assert.deepEqual(Object.assign({}, addCall.payload), { title: '普通任务' })
  assert.equal(Object.prototype.hasOwnProperty.call(addCall.payload, 'sessionId'), false)
})

test('BoardTab：当前会话有 cwd 时新建提示写工作区名，否则退回通用提示', async () => {
  const snapshot = makeSnapshot({
    workspaces: [],
    agents: [
      { sessionId: 'session-abc', status: 'running', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' },
      { sessionId: 'session-other', status: 'idle', cwd: 'C:\\work\\demo' },
    ],
  })
  const harness = createHarness({ snapshot })
  const BoardTab = harness.componentOf('sidebar.right.pane.tab')

  const matched = await renderNarrow(BoardTab, { sessionId: 'session-abc' })
  const matchedHint = nodesWithClass(matched.tree, 'tb-hint')
  assert.equal(matchedHint.length, 1, 'composer must render exactly one hint')
  assert.ok(includesText(matchedHint[0], '工作区：日常问答'), 'hint should name the current workspace')
  assert.ok(includesText(matchedHint[0], '任务会回到本对话执行'))

  const unmatched = await renderNarrow(BoardTab, { sessionId: 'session-missing' })
  const unmatchedHint = nodesWithClass(unmatched.tree, 'tb-hint')
  assert.equal(unmatchedHint.length, 1)
  assert.ok(includesText(unmatchedHint[0], '你只管加任务和看结论'), 'unknown session keeps the generic hint')
  assert.ok(!includesText(unmatchedHint[0], '工作区：'))

  const noSession = await renderNarrow(BoardTab)
  assert.ok(includesText(nodesWithClass(noSession.tree, 'tb-hint')[0], '你只管加任务和看结论'))

  // 会话匹配但 cwd 为空 → 通用提示
  const noCwdSnapshot = makeSnapshot({
    workspaces: [],
    agents: [{ sessionId: 'session-abc', status: 'running', cwd: '' }],
  })
  const noCwdHarness = createHarness({ snapshot: noCwdSnapshot })
  const noCwd = await renderNarrow(noCwdHarness.componentOf('sidebar.right.pane.tab'), { sessionId: 'session-abc' })
  assert.ok(includesText(nodesWithClass(noCwd.tree, 'tb-hint')[0], '你只管加任务和看结论'))
})

/* ══════════════════════════════════════════════════════════════
 * 用例：左侧栏平台看板入口图标
 * ══════════════════════════════════════════════════════════════ */

test('PlatformPanelIcon：todo+doing 角标 + 6s 轮询 snapshot', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const Icon = harness.componentOf('sidebar.panellist')
  const { tree, instance } = await renderComponent(Icon, { size: 18 })

  assert.ok(hasClass(tree, 'tb-icon'))
  assert.match(String(tree.props.title), /任务看板/)
  assert.match(String(tree.props.title), /3 条待处理/)

  const svg = collect(tree).find((node) => node.type === 'svg')
  assert.ok(svg, 'platform entry must render the board glyph')
  assert.equal(svg.props.width, 18)
  assert.equal(collect(svg).filter((node) => node.type === 'rect').length, 4)

  const badge = nodesWithClass(tree, 'tb-badge')
  assert.equal(badge.length, 1, 'todo + doing = 3 must show a badge')
  assert.equal(textOf(badge[0]), '3')

  assert.equal(countCalls(harness, 'snapshot'), 1)
  assert.equal(harness.intervals.length, 1)
  assert.equal(harness.intervals[0].ms, 6000)
  assert.equal(harness.windowCounters.setInterval, 0)
  assert.ok(instance.cleanups.length >= 1)
})

test('PlatformPanelIcon：RPC 失败时不崩、不显示角标', async () => {
  const harness = createHarness({
    rpc: () => Promise.resolve({ ok: false, error: { code: 'network', message: 'boom' } }),
  })
  const result = await renderComponent(harness.componentOf('sidebar.panellist'), { size: 20 })
  assert.equal(nodesWithClass(result.tree, 'tb-badge').length, 0)
  assert.equal(result.tree.props.title, '任务看板')
  const svg = collect(result.tree).find((node) => node.type === 'svg')
  assert.equal(svg.props.width, 20)
})

/* ══════════════════════════════════════════════════════════════
 * 用例：PlatformBoard —— 全部工作区看板（左侧栏 main 页面）
 * ══════════════════════════════════════════════════════════════ */

test('PlatformBoard：默认显示全部工作区任务，卡片带工作区 tag，可按工作区过滤', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const { tree, instance } = await renderComponent(harness.componentOf('main'), {})

  assert.ok(hasClass(tree, 'tb-page'))
  assert.ok(hasClass(tree, 'tb-platform'))
  assert.equal(tree.props['data-layout'], 'wide')
  assert.ok(includesText(tree, '任务看板'))
  assert.ok(includesText(tree, '共 5 条'), 'header shows the total task count')

  assert.equal(nodesWithClass(tree, 'tb-col').length, 4)
  assert.equal(nodesWithClass(tree, 'tb-card').length, 5, 'all tasks render by default')
  const pageText = textOf(tree)
  for (const title of TASK_TITLES) {
    assert.ok(pageText.includes(title), 'missing task: ' + title)
  }

  // 工作区 tag：4 条有 cwd 的任务各一个（cwd=null 的老任务不显示）
  const workspaceTags = nodesWithClass(tree, 'tb-card-tag').filter((node) => textOf(node).includes('工作区'))
  assert.equal(workspaceTags.length, 4)
  assert.equal(
    workspaceTags.map((node) => textOf(node)).sort().join('|'),
    '工作区 a|工作区 a|工作区 b|工作区 b',
  )
  for (const tag of workspaceTags) {
    assert.ok(String(tag.props.title).startsWith('C:\\work\\'), 'workspace tag title carries the full path')
  }

  // 工作区过滤下拉：全部 + 两个工作区（title 为空用路径尾段）
  const filterSelect = selectByAria(tree, '工作区')
  assert.ok(filterSelect, 'workspace filter select must render')
  assert.equal(filterSelect.props.value, '')
  assert.deepEqual(optionTexts(filterSelect), ['全部工作区', '工作区 A', 'b'])

  // 过滤到工作区 A：只显示属于 A 的两条
  filterSelect.props.onChange({ target: { value: WS_A } })
  const filteredA = await instance.run()
  assert.equal(nodesWithClass(filteredA, 'tb-card').length, 2)
  assert.ok(includesText(filteredA, '梳理看板数据模型'))
  assert.ok(includesText(filteredA, '打通宿主 RPC'))
  assert.ok(!includesText(filteredA, '实现轮询自动派发'))
  assert.ok(includesText(filteredA, '共 2 条'), 'toolbar count follows the filter')
  assert.ok(includesText(filteredA, '共 5 条'), 'header still shows the total')

  // 过滤只影响显示，不触发额外 RPC
  assert.equal(countCalls(harness, 'snapshot'), 1)
})

test('PlatformBoard：新增任务必须选工作区，提交 payload 带 cwd、不带 sessionId', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const PlatformBoard = harness.componentOf('main')
  const { tree, instance } = await renderComponent(PlatformBoard, {})

  let submit = submitButton(tree)
  assert.ok(submit)
  assert.equal(submit.props.disabled, true, 'submit disabled while no workspace is chosen')
  assert.ok(includesText(tree, '先选择任务所属的工作区'), 'hint explains the required workspace')

  // 工作区下拉：placeholder + 两个工作区
  const workspaceSelect = selectByAria(tree, '任务所属工作区')
  assert.ok(workspaceSelect, 'workspace picker must render')
  assert.deepEqual(optionTexts(workspaceSelect), ['选择工作区', '工作区 A', 'b'])

  // 只选工作区、没写标题 → 仍然禁用
  workspaceSelect.props.onChange({ target: { value: WS_A } })
  let next = await instance.run()
  submit = submitButton(next)
  assert.equal(submit.props.disabled, true, 'submit stays disabled without a title')
  assert.ok(!includesText(next, '先选择任务所属的工作区'), 'hint disappears once a workspace is chosen')

  // 写标题 → 可提交
  composerInput(next).props.onChange({ target: { value: '平台任务一' } })
  next = await instance.run()
  submit = submitButton(next)
  assert.equal(submit.props.disabled, false)
  submit.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))

  const addCall = harness.rpcCalls.find((call) => call.endpoint === 'add-task')
  assert.ok(addCall, 'clicking 添加到待开始 must call add-task')
  assert.equal(addCall.channel, '/taskboard')
  assert.deepEqual(Object.assign({}, addCall.payload), { title: '平台任务一', cwd: WS_A })
  assert.equal('sessionId' in addCall.payload, false, 'platform board must not bind a session')
})

test('PlatformBoard：页面结构、按钮与页脚/预设 banner', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const { tree } = await renderComponent(harness.componentOf('main'), {})

  const labels = buttonTexts(tree)
  for (const label of ['立即刷新', '暂停轮询', '一键归档已完成', '添加到待开始', '加备注']) {
    assert.ok(labels.includes(label), 'missing platform control: ' + label)
  }
  assert.ok(!labels.includes('同步模式预设'))

  // 页脚：数据文件路径 + 版本（平台页始终是宽布局）
  const code = collect(tree).find((node) => node.type === 'code')
  assert.ok(code, 'platform footer must render the board path')
  assert.equal(textOf(code), 'C:\\Users\\duan\\.dsh\\storages\\taskboard\\board.json')
  assert.ok(includesText(tree, '数据文件'))
  assert.ok(includesText(tree, 'v0.1.0'))

  // 预设未安装 → warn banner
  const banners = nodesWithClass(tree, 'tb-banner')
  assert.equal(banners.length, 1)
  assert.equal(banners[0].props['data-tone'], 'warn')
  assert.ok(includesText(banners[0], '没有找到「派单看板模式」'))

  // 同一工作区路径（斜杠/大小写不同）在下拉里只出现一次
  const dupHarness = createHarness({
    snapshot: makeSnapshot({
      workspaces: [
        { id: 'w1', path: WS_A, title: '工作区 A', status: 'ok' },
        { id: 'w1b', path: 'c:/work/a/', title: '工作区 A 重复', status: 'ok' },
        { id: 'w2', path: WS_B, title: '', status: 'ok' },
      ],
    }),
  })
  const dupTree = (await renderComponent(dupHarness.componentOf('main'), {})).tree
  assert.deepEqual(optionTexts(selectByAria(dupTree, '任务所属工作区')), ['选择工作区', '工作区 A', 'b'])
  assert.deepEqual(optionTexts(selectByAria(dupTree, '工作区')), ['全部工作区', '工作区 A', 'b'])
})

test('PlatformBoard：快照为空时显示空态与空工作区下拉（不抛异常）', async () => {
  const harness = createHarness({ snapshot: {} })
  const { tree } = await renderComponent(harness.componentOf('main'), {})

  assert.equal(nodesWithClass(tree, 'tb-card').length, 0)
  assert.equal(nodesWithClass(tree, 'tb-col').length, 4, 'columns still render when empty')
  assert.ok(includesText(tree, '没有任务。选个工作区加一条，主 Agent 会自动接手。'))
  assert.ok(includesText(tree, '共 0 条'))

  const code = collect(tree).find((node) => node.type === 'code')
  assert.ok(code)
  assert.equal(textOf(code), '')

  const workspaceSelect = selectByAria(tree, '任务所属工作区')
  assert.deepEqual(optionTexts(workspaceSelect), ['选择工作区'])
  assert.equal(submitButton(tree).props.disabled, true)
})

test('PlatformBoard：RPC 报错时降级渲染（错误 banner + 四列仍在）', async () => {
  const harness = createHarness({
    rpc: () => Promise.resolve({ ok: false, error: { code: 'network', message: 'connect ECONNREFUSED' } }),
  })
  const { tree } = await renderComponent(harness.componentOf('main'), {})

  assert.ok(hasClass(tree, 'tb-page'))
  assert.equal(nodesWithClass(tree, 'tb-col').length, 4)
  assert.equal(nodesWithClass(tree, 'tb-card').length, 0)
  const banners = nodesWithClass(tree, 'tb-banner')
  assert.equal(banners.length, 1)
  assert.equal(banners[0].props['data-tone'], 'error')
  assert.equal(banners[0].props.role, 'alert')
  assert.ok(includesText(banners[0], '连接看板服务失败：网络错误'))
})

/* ══════════════════════════════════════════════════════════════
 * 用例：预设 banner 状态机 / 降级渲染（右栏 BoardTab）
 * ══════════════════════════════════════════════════════════════ */

test('BoardTab：preset 正常时不出现 banner；broken 时出现 error banner', async () => {
  const okSnapshot = makeSnapshot({
    preset: { installed: true, path: 'bundle:presets/taskboard.patch.yml', restartRequired: false, broken: '' },
  })
  const okHarness = createHarness({ snapshot: okSnapshot })
  const okTree = (await renderNarrow(okHarness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })).tree
  assert.equal(nodesWithClass(okTree, 'tb-banner').length, 0)

  const brokenSnapshot = makeSnapshot({
    preset: { installed: false, path: 'bundle:presets/taskboard.patch.yml', broken: 'row persona: boom' },
  })
  const brokenHarness = createHarness({ snapshot: brokenSnapshot })
  const brokenTree = (await renderNarrow(brokenHarness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })).tree
  const brokenBanners = nodesWithClass(brokenTree, 'tb-banner')
  assert.equal(brokenBanners.length, 1)
  assert.equal(brokenBanners[0].props['data-tone'], 'error')
  assert.ok(includesText(brokenBanners[0], '加载失败'))
  assert.ok(includesText(brokenBanners[0], 'row persona: boom'))
})

test('BoardTab：RPC 报错时降级渲染（错误 banner + 四列仍在，不抛异常）', async () => {
  const harness = createHarness({
    rpc: () => Promise.resolve({ ok: false, error: { code: 'network', message: 'connect ECONNREFUSED' } }),
  })
  const { tree } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })

  assert.ok(hasClass(tree, 'tb-page'))
  assert.equal(nodesWithClass(tree, 'tb-col').length, 4)
  assert.equal(nodesWithClass(tree, 'tb-card').length, 0)
  const banners = nodesWithClass(tree, 'tb-banner')
  assert.equal(banners.length, 1)
  assert.equal(banners[0].props['data-tone'], 'error')
  assert.equal(banners[0].props.role, 'alert')
  assert.ok(includesText(banners[0], '连接看板服务失败：网络错误'))
})

test('BoardTab：snapshot 为空对象时降级渲染（四列空态，不抛异常）', async () => {
  const harness = createHarness({ snapshot: {} })
  const { tree } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })

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
  assert.ok(includesText(tree, '每 15s 轮询'))
})

/* ══════════════════════════════════════════════════════════════
 * 用例：任务详情浮层（两块看板共用 Detail）
 * ══════════════════════════════════════════════════════════════ */

function detailMask(tree) {
  return collect(tree).find((node) => hasClass(node, 'tb-detail-mask')) || null
}

function detailBox(tree) {
  const mask = detailMask(tree)
  return mask ? collect(mask).find((node) => hasClass(node, 'tb-detail')) || null : null
}

function detailText(tree) {
  const box = detailBox(tree)
  return box ? textOf(box) : ''
}

function cardTitleNode(tree, title) {
  return collect(tree).find((node) => hasClass(node, 'tb-card-titlebtn') && textOf(node) === title) || null
}

async function openDetailByTitle(instance, tree, title) {
  const node = cardTitleNode(tree, title)
  assert.ok(node, 'clickable card title for "' + title + '" must render')
  node.props.onClick()
  return instance.run()
}

function detailPrimaryButton(tree) {
  const box = detailBox(tree)
  assert.ok(box, 'detail overlay must be open')
  const actions = collect(box).find((node) => hasClass(node, 'tb-detail-actions'))
  assert.ok(actions, 'detail actions must render')
  const button = buttons(actions).find((node) => classOf(node).includes('tb-btn-primary'))
  assert.ok(button, 'detail primary action must render')
  return button
}

function detailLabels(tree) {
  const box = detailBox(tree)
  assert.ok(box, 'detail overlay must be open')
  const dts = collect(box).filter((node) => node.type === 'dt').map((node) => textOf(node))
  const dds = collect(box).filter((node) => node.type === 'dd').map((node) => textOf(node))
  return { dts, dds }
}

test('Detail：点卡片标题打开浮层，完整展示结论/备注/执行者/时间/id', async () => {
  const longResult = '完整结论：' + '这段结论比较长，用来确认浮层不会截断文本。'.repeat(14)
  const longNote = '备注：' + '验收标准包含多条检查点。'.repeat(6)
  const snapshot = makeSnapshot({
    tasks: [
      {
        id: 't-detail-1',
        title: '打通宿主 RPC',
        status: 'done',
        cwd: WS_A,
        note: longNote,
        result: longResult,
        assignee: 'main-agent-1',
        notificationCount: 5,
        source: 'agent',
        createdAt: '2026-11-11T02:30:00.000Z',
        updatedAt: '2026-11-11T03:10:00.000Z',
        startedAt: '2026-11-11T02:40:00.000Z',
        finishedAt: '2026-11-11T03:05:00.000Z',
      },
    ],
  })
  const harness = createHarness({ snapshot })
  const { tree, instance } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), {
    sessionId: SESSION_A,
  })

  const opened = await openDetailByTitle(instance, tree, '打通宿主 RPC')
  assert.ok(detailMask(opened), 'mask must render')
  const box = detailBox(opened)
  assert.ok(box, 'detail panel must render')

  // 标题 + 状态徽标
  const heading = collect(box).find((node) => node.type === 'h2')
  assert.ok(heading, 'detail title must render')
  assert.equal(textOf(heading), '打通宿主 RPC')
  const badge = nodesWithClass(box, 'tb-statusbadge')
  assert.equal(badge.length, 1)
  assert.equal(badge[0].props['data-status'], 'done')
  assert.equal(textOf(badge[0]), '已完成')

  // 完整结论 / 完整备注（不截断）
  const detailTextAll = detailText(opened)
  assert.ok(detailTextAll.includes(longResult), 'full result text must render untruncated')
  assert.ok(detailTextAll.includes(longNote), 'full note text must render untruncated')
  assert.ok(longResult.length > 200, 'fixture result is long enough to prove no truncation')

  // 字段网格：状态/工作区/时间线/执行者/来源/提醒次数/id
  const { dts, dds } = detailLabels(opened)
  for (const label of ['状态', '工作区', '创建时间', '最后更新', '开始时间', '完成时间', '执行者 / 派给谁', '创建来源', '派发提醒次数', '任务 id']) {
    assert.ok(dts.includes(label), 'missing detail field label: ' + label)
  }
  assert.ok(dds.includes('已完成'), 'status value must render')
  assert.ok(dds.includes(WS_A), 'workspace path must render')
  assert.ok(dds.includes('main-agent-1'), 'assignee must render')
  assert.ok(dds.includes('5'), 'notification count must render')
  assert.ok(dds.includes('t-detail-1'), 'task id must render')
  assert.ok(dds.some((value) => value.includes('2026-11-11')), 'timeline dates must render')
  assert.ok(detailTextAll.includes('主 Agent（模型工具）'), 'agent source must render')

  // 卡片本身也能看到「详情」入口
  assert.ok(buttonTexts(tree).includes('详情'), 'cards must expose a 详情 action')
})

test('Detail：done 但结论为空时显示 .tb-detail-muted 提示；未完成时显示待写提示', async () => {
  const snapshot = makeSnapshot({
    tasks: [
      { id: 't-done-empty', title: '完成了但没写结论', status: 'done', cwd: WS_A, result: '', updatedAt: minutesAgo(3) },
      { id: 't-todo-empty', title: '还没开始的任务', status: 'todo', cwd: WS_A, updatedAt: minutesAgo(4) },
    ],
  })
  const harness = createHarness({ snapshot })
  const { tree, instance } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), {
    sessionId: SESSION_A,
  })

  const doneTree = await openDetailByTitle(instance, tree, '完成了但没写结论')
  const muted = nodesWithClass(doneTree, 'tb-detail-muted')
  assert.equal(muted.length, 1, 'empty result for a done task must use .tb-detail-muted')
  assert.ok(includesText(muted[0], '任务已完成，但主 Agent 还没有写结论。'))
  // 关闭后打开未完成任务：空结论走「待写」提示，不是 muted
  const closeButton = buttons(doneTree).find((node) => node.props['aria-label'] === '关闭')
  assert.ok(closeButton, 'detail must render a close button')
  closeButton.props.onClick()
  const closed = await instance.run()
  assert.equal(detailMask(closed), null)
  const todoTree = await openDetailByTitle(instance, closed, '还没开始的任务')
  assert.equal(nodesWithClass(todoTree, 'tb-detail-muted').length, 0)
  assert.ok(detailText(todoTree).includes('任务还没完成，完成后主 Agent 会把结论写在这里。'))
})

test('Detail：× / 关闭按钮 / 点遮罩三种方式都能关闭（仅 target===currentTarget 生效）', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const { tree, instance } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), {
    sessionId: SESSION_A,
  })

  // 1) × 关闭
  let opened = await openDetailByTitle(instance, tree, '梳理看板数据模型')
  const closeX = buttons(opened).find((node) => node.props['aria-label'] === '关闭')
  assert.ok(closeX, 'detail must render an × close button')
  closeX.props.onClick()
  let next = await instance.run()
  assert.equal(detailMask(next), null, '× must close the overlay')

  // 2) 底部「关闭」按钮
  opened = await openDetailByTitle(instance, next, '梳理看板数据模型')
  const closeText = buttons(opened).find((node) => textOf(node).trim() === '关闭')
  assert.ok(closeText, 'detail must render a text close button')
  closeText.props.onClick()
  next = await instance.run()
  assert.equal(detailMask(next), null, 'close button must close the overlay')

  // 3) 点遮罩：目标不是遮罩本身时保持打开
  opened = await openDetailByTitle(instance, next, '梳理看板数据模型')
  const mask = detailMask(opened)
  mask.props.onClick({ target: {}, currentTarget: mask })
  next = await instance.run()
  assert.ok(detailMask(next), 'clicking inside the panel must not close the overlay')

  // 4) 点遮罩：target === currentTarget 时关闭
  const mask2 = detailMask(next)
  mask2.props.onClick({ target: mask2, currentTarget: mask2 })
  next = await instance.run()
  assert.equal(detailMask(next), null, 'clicking the mask itself must close the overlay')
})

test('PlatformBoard：详情主操作按状态映射，点击后发 update-task 并关闭浮层', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const { tree, instance } = await renderComponent(harness.componentOf('main'), {})

  const cases = [
    { title: '梳理看板数据模型', id: 't-1', action: '开始', status: 'doing' },
    { title: '写客户端渲染冒烟测试', id: 't-3', action: '完成', status: 'done' },
    { title: '打通宿主 RPC', id: 't-4', action: '归档', status: 'archived' },
    { title: '归档过期的旧任务', id: 't-5', action: '重新打开', status: 'todo' },
  ]

  let current = tree
  for (const item of cases) {
    current = await openDetailByTitle(instance, current, item.title)
    const primary = detailPrimaryButton(current)
    assert.equal(textOf(primary).trim(), item.action, 'wrong primary action for ' + item.title)

    const before = harness.rpcCalls.filter((call) => call.endpoint === 'update-task').length
    primary.props.onClick()
    const after = await instance.run()
    assert.equal(detailMask(after), null, 'quick action must close the overlay')

    const updates = harness.rpcCalls.filter((call) => call.endpoint === 'update-task')
    assert.equal(updates.length, before + 1, 'quick action must call update-task exactly once')
    assert.deepEqual(Object.assign({}, updates[updates.length - 1].payload), { id: item.id, status: item.status })
    current = after
  }
})

test('两块看板都能打开详情浮层（右栏点标题 / 平台点「详情」按钮）', async () => {
  // 右栏：点卡片标题
  const rightHarness = createHarness({ snapshot: makeSnapshot() })
  const right = await renderNarrow(rightHarness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  const rightTree = await openDetailByTitle(right.instance, right.tree, '梳理看板数据模型')
  assert.ok(detailBox(rightTree), 'right board detail must render')
  const rightHeading = collect(detailBox(rightTree)).find((node) => node.type === 'h2')
  assert.ok(rightHeading)
  assert.equal(textOf(rightHeading), '梳理看板数据模型')

  // 平台：点卡片动作里的「详情」按钮（标题之外的第二种入口）
  const platformHarness = createHarness({ snapshot: makeSnapshot() })
  const platform = await renderComponent(platformHarness.componentOf('main'), {})
  const detailButtons = buttons(platform.tree).filter((node) => textOf(node).trim() === '详情')
  assert.ok(detailButtons.length >= 5, 'every platform card must expose a 详情 button')
  detailButtons[0].props.onClick()
  const platformTree = await platform.instance.run()
  assert.ok(detailBox(platformTree), 'platform board detail must render')
  const platformHeading = collect(detailBox(platformTree)).find((node) => node.type === 'h2')
  assert.ok(platformHeading)
  assert.equal(textOf(platformHeading), '梳理看板数据模型', '详情 button opens the matching task')
})
