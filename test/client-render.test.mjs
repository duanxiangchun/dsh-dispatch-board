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
  // FileReader 桩：粘贴图片用 file.dataUrl 直接返回；真实浏览器里由 FileReader 读 Blob。
  class FileReaderStub {
    readAsDataURL(file) {
      const result =
        file && typeof file.dataUrl === 'string'
          ? file.dataUrl
          : 'data:' + (file && file.type ? file.type : 'image/png') + ';base64,' + (file && file.base64 ? file.base64 : '')
      Promise.resolve().then(() => {
        this.result = result
        if (typeof this.onload === 'function') this.onload()
      })
    }
  }
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
    FileReader: FileReaderStub,
  }
  vm.createContext(sandbox)
  vm.runInContext(clientSource, sandbox, { filename: 'lib/client.js' })

  assert.ok(captured.definition, 'window.__ModuleLoader__.load must be called')
  assert.equal(captured.definition.id, 'dsh-dispatch-board')
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
  const openSessionCalls = []
  const uiWorkspaceService = options.uiWorkspace === false ? undefined : {
    openSession(sessionId) {
      openSessionCalls.push(sessionId)
    },
  }
  const scopeServices = {
    uiWorkspace: uiWorkspaceService,
    sidebarRightTabs: tabsService,
    sidebarRight: sidebarRightService,
  }

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
    openSessionCalls,
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
      config: {
        pollEnabled: true,
        pollIntervalMs: 15000,
        dispatchMode: 'workspace-lead', // v0.2.0 新默认
        mainSessionId: null,
        mainSessionTitle: '',
        workspaceLeads: {},
      },
      // v0.2.0：组长 / 主会话运行时视图（revision 不变也会变）
      leads: { main: null, workspaces: [] },
      poll: {
        lastRunAt: minutesAgo(1),
        lastDispatchAt: minutesAgo(3),
        lastDispatchSessionId: '0123456789abcdef',
        lastDispatchSessionTitle: '主会话',
        lastDispatchTaskId: null,
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

  // t-33：卡片正文只剩标题 + 操作按钮，note / result / 执行者 / 通知次数 / 相对时间都不再上卡片
  assert.ok(!includesText(tree, '先定 board.json 的字段'), 'task note must not render on the card')
  assert.ok(!includesText(tree, '结论: snapshot / add-task 已通'), 'task result must not render on the card')
  assert.ok(!includesText(tree, '执行者: main'), 'assignee must not render on the card')
  assert.ok(!includesText(tree, '已通知 3 次'), 'notificationCount must not render on the card')
  assert.ok(!includesText(tree, '5 分钟前'), 'relative time must not render on the card')
  assert.ok(!includesText(tree, '上一次投递超时'), 'lastError must not render on the card either')
  for (const cls of ['tb-card-note', 'tb-card-result', 'tb-card-error', 'tb-card-meta', 'tb-card-tag', 'tb-card-lead']) {
    assert.equal(nodesWithClass(tree, cls).length, 0, 'card must not render .' + cls)
  }
  // 每张卡片 = 标题 + 操作行，并且带等高样式类（真实高度靠 CSS，见下面的 CSS 断言）
  for (const card of cards) {
    assert.ok(hasClass(card, 'tb-card-fixed'), 'card must carry the equal-height class .tb-card-fixed')
    assert.equal(card.children.length, 2, 'card body must be title + action row only')
    assert.ok(hasClass(card.children[0], 'tb-card-titlebtn'))
    assert.ok(hasClass(card.children[1], 'tb-card-actions'))
    assert.equal(card.children[0].props.title, textOf(card.children[0]), 'title attribute keeps the full title')
  }

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
  assert.ok(includesText(banners[0], '没有找到「任务看板 · 工作区组长（自动）」'))

  // 一次 snapshot + 一次 session-info（挂载时问工作区）；轮询走 ctx.interval
  // （t-34：卡片不再用相对时间，30s 的 setNow 定时器已删除，只剩轮询一个 interval）
  assert.equal(countCalls(harness, 'snapshot'), 1)
  assert.equal(countCalls(harness, 'session-info'), 1)
  assert.equal(harness.intervals.length, 1)
  assert.equal(harness.windowCounters.setInterval, 0)
  assert.equal(instance.cleanups.length, 2)
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

test('卡片精简（t-33）：只渲染标题 + 操作按钮，等高样式类/CSS 齐备，行内编辑不改高度', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const { tree, instance } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })

  const cards = nodesWithClass(tree, 'tb-card')
  assert.equal(cards.length, 2)
  for (const card of cards) {
    // 卡片正文 = 标题 + 操作行（没有 note / result / lastError / meta）
    assert.equal(card.children.length, 2, 'card body must be exactly title + action row')
    const [titleNode, actionRow] = card.children
    assert.ok(hasClass(titleNode, 'tb-card-title'), 'first child is the title')
    assert.ok(hasClass(titleNode, 'tb-card-titlebtn'), 'title keeps the detail click handler')
    assert.equal(titleNode.props.role, 'button', 'title stays keyboard accessible')
    assert.equal(titleNode.props.tabIndex, 0)
    assert.equal(titleNode.props.title, textOf(titleNode), 'title attribute keeps the full title text')
    assert.ok(hasClass(actionRow, 'tb-card-actions'), 'second child is the action row')
    assert.ok(buttons(actionRow).length >= 3, 'action buttons survive the trim')
    // 等高样式类：真实高度靠 CSS（浏览器验证），这里断言类名存在
    assert.ok(hasClass(card, 'tb-card-fixed'), 'card must carry the equal-height class')
  }
  for (const cls of ['tb-card-note', 'tb-card-result', 'tb-card-error', 'tb-card-meta']) {
    assert.equal(nodesWithClass(tree, cls).length, 0, 'card must not render .' + cls)
  }

  // 等高规则：min-height + border-box + 操作行 margin-top:auto + 标题 2 行截断
  assert.ok(clientSource.includes('.tb-card-fixed{min-height:var(--tb-card-h,108px)'), 'equal-height min-height rule')
  assert.ok(clientSource.includes('border-radius:var(--dsw-radius-sm);min-width:0;box-sizing:border-box}'), 'card uses border-box')
  assert.ok(clientSource.includes('.tb-card-fixed .tb-card-actions{margin-top:auto;'), 'action row pinned to the card bottom')
  assert.ok(clientSource.includes('-webkit-line-clamp:2'), 'title clamps to two lines')

  // 行内编辑态保持现状：编辑卡片没有 .tb-card-fixed，高度自适应、不受精简影响
  const editButton = buttons(cards[0]).find((node) => textOf(node).trim() === '编辑')
  assert.ok(editButton, 'todo card still exposes 编辑')
  editButton.props.onClick()
  const editingTree = await instance.run()
  const editingCard = collect(editingTree).find(
    (node) => hasClass(node, 'tb-card') && collect(node).some((child) => hasClass(child, 'tb-edit')),
  )
  assert.ok(editingCard, 'editing card must render the inline editor')
  assert.ok(!hasClass(editingCard, 'tb-card-fixed'), 'inline editor keeps auto height')
  assert.ok(collect(editingCard).some((node) => node.type === 'textarea'), 'note textarea still renders while editing')

  // 编辑态能真的保存：改标题 → 保存 = 一次 update-task（顺带守住「保存」按钮曾引用未定义 saveEdit 的崩点）
  const titleInput = collect(editingCard).find((node) => node.type === 'input')
  assert.ok(titleInput, 'editing card exposes the title input')
  titleInput.props.onChange({ target: { value: '改过的标题' } })
  const editedTree = await instance.run()
  const saveButton = buttons(editedTree).find((node) => textOf(node).trim() === '保存')
  assert.ok(saveButton, 'editing card exposes 保存')
  saveButton.props.onClick()
  await settle()
  const updates = harness.rpcCalls.filter((call) => call.endpoint === 'update-task')
  assert.equal(updates.length, 1, '保存 issues exactly one update-task')
  assert.deepEqual(Object.assign({}, updates[0].payload), {
    id: 't-1',
    title: '改过的标题',
    note: '先定 board.json 的字段',
  })
  assert.equal(collect(await instance.run()).filter((node) => hasClass(node, 'tb-edit')).length, 0, '保存 closes the inline editor')
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

  // 「派发给」（按会话选目标）已被删除；现在只有轮询间隔 + 派发方式（新对话/回发起/空闲）两个选择器
  const selects = collect(tree).filter((node) => node.type === 'select')
  assert.equal(selects.length, 2, 'poll-interval + dispatch-mode selects')
  const dispatchSelect = selects.find((node) => node.props['aria-label'] === '派发到')
  assert.ok(dispatchSelect, 'dispatch-mode select must render')
  const modeValues = collect(dispatchSelect)
    .filter((node) => node.type === 'option')
    .map((node) => node.props.value)
  // v0.2.0：默认 workspace-lead（工作区组长），旧三模式保留兼容
  assert.deepEqual(modeValues, ['workspace-lead', 'new', 'creator', 'auto'])
  assert.equal(dispatchSelect.props.value, 'workspace-lead', 'default dispatch mode is workspace-lead')
  assert.ok(includesText(dispatchSelect, '工作区组长（推荐）'))
  assert.ok(!includesText(tree, '派发给'), 'the old per-session dispatch-target selector must be gone')
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

test('PlatformBoard：默认显示全部工作区任务，可按工作区过滤（卡片不再带工作区 tag）', async () => {
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

  // t-33：卡片 meta（含工作区 tag / note / result）整体移除，工作区只靠工具栏筛选和详情浮层表达
  assert.equal(nodesWithClass(tree, 'tb-card-tag').length, 0, 'workspace tags are gone with the card meta')
  assert.equal(nodesWithClass(tree, 'tb-card-meta').length, 0, 'card meta is gone')
  assert.equal(nodesWithClass(tree, 'tb-card-note').length, 0, 'card note preview is gone')
  assert.equal(nodesWithClass(tree, 'tb-card-result').length, 0, 'card result preview is gone')
  assert.ok(!includesText(tree, '先定 board.json 的字段'), 'note must not leak into the platform board either')
  for (const card of nodesWithClass(tree, 'tb-card')) {
    assert.ok(hasClass(card, 'tb-card-fixed'), 'platform cards are equal height as well')
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
  assert.ok(includesText(banners[0], '没有找到「任务看板 · 工作区组长（自动）」'))

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

  // 字段网格：状态在徽标里，其余分「基本信息」「时间线」两组
  const { dts, dds } = detailLabels(opened)
  for (const label of ['工作区', '执行者', '创建来源', '任务 id']) {
    assert.ok(dts.includes(label), 'missing detail field label: ' + label)
  }
  assert.ok(!dts.includes('派发提醒次数'), 'dispatch reminder count must not render as a detail field')
  assert.ok(!detailTextAll.includes('派发提醒次数'), 'dispatch reminder count must not render anywhere in the detail overlay')
  const timelineLabels = nodesWithClass(box, 'tb-timeline-label').map((node) => textOf(node))
  assert.deepEqual(timelineLabels, ['创建时间', '最后更新', '开始时间', '完成时间', '归档时间'])
  for (const sectionLabel of ['基本信息', '时间线']) {
    assert.ok(dts.includes(sectionLabel) || detailTextAll.includes(sectionLabel), 'missing detail section: ' + sectionLabel)
  }
  assert.ok(!dts.includes('状态'), 'status lives in the badge, not a duplicate row')
  assert.ok(dds.includes(WS_A), 'workspace path must render')
  assert.ok(dds.includes('main-agent-1'), 'assignee must render')
  assert.ok(dds.includes('t-detail-1'), 'task id must render')
  // 时间线现在是紧凑条：5 项、值形如 MM-DD HH:mm，完整时间在 title 里
  const timelineValues = nodesWithClass(box, 'tb-timeline-value')
  assert.equal(timelineValues.length, 5, 'timeline strip must render 5 items')
  for (const node of timelineValues) {
    const text = textOf(node)
    assert.ok(text === '—' || /^\d{2}-\d{2} \d{2}:\d{2}$/.test(text), 'compact timeline value: ' + text)
  }
  assert.ok(timelineValues[0].props.title.includes('2026-11-11'), 'full timeline date stays in the title attribute')
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
  // 结论区一个 muted（done 但空结论）+ 关联对话区一个 muted（无任何关联会话）
  const resultMuted = muted.filter((node) => textOf(node).includes('任务已完成，但主 Agent 还没有写结论。'))
  const sessionMuted = muted.filter((node) => textOf(node).includes('（这条任务还没有关联对话）'))
  assert.equal(resultMuted.length, 1, 'empty result for a done task must use .tb-detail-muted')
  assert.equal(sessionMuted.length, 1, 'task without sessions must show the no-session muted text')
  // 关闭后打开未完成任务：空结论走「待写」提示，不是 muted
  const closeButton = buttons(doneTree).find((node) => node.props['aria-label'] === '关闭')
  assert.ok(closeButton, 'detail must render a close button')
  closeButton.props.onClick()
  const closed = await instance.run()
  assert.equal(detailMask(closed), null)
  const todoTree = await openDetailByTitle(instance, closed, '还没开始的任务')
  const todoMuted = nodesWithClass(todoTree, 'tb-detail-muted')
  assert.equal(
    todoMuted.filter((node) => textOf(node).includes('任务还没完成')).length,
    0,
    'pending-result placeholder is not muted',
  )
  assert.equal(
    todoMuted.filter((node) => textOf(node).includes('（这条任务还没有关联对话）')).length,
    1,
    'no-session muted still renders for a task without sessions',
  )
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

/* ══════════════════════════════════════════════════════════════
 * 用例：跳到关联对话（uiWorkspace.openSession）
 * ══════════════════════════════════════════════════════════════ */

function cardByTitle(tree, title) {
  return (
    collect(tree).find((node) => {
      if (!hasClass(node, 'tb-card')) return false
      return collect(node).some((child) => hasClass(child, 'tb-card-titlebtn') && textOf(child) === title)
    }) || null
  )
}

function detailSessionButtons(tree) {
  const box = detailBox(tree)
  assert.ok(box, 'detail overlay must be open')
  const row = collect(box).find((node) => hasClass(node, 'tb-detail-sessions'))
  assert.ok(row, 'detail session block must render')
  return buttons(row)
}

test('卡片「对话」按钮：只有关联会话才出现，dispatchedSessionId 优先', async () => {
  const snapshot = makeSnapshot({
    tasks: [
      { id: 'c-1', title: '有发起会话', status: 'todo', cwd: WS_A, sessionId: 'session-aaaa1111', updatedAt: minutesAgo(2) },
      { id: 'c-2', title: '有执行会话', status: 'todo', cwd: WS_A, dispatchedSessionId: 'session-bbbb2222', updatedAt: minutesAgo(2) },
      {
        id: 'c-3',
        title: '两者都有',
        status: 'todo',
        cwd: WS_A,
        sessionId: 'session-cccc3333',
        dispatchedSessionId: 'session-dddd4444',
        updatedAt: minutesAgo(2),
      },
      { id: 'c-4', title: '没有会话', status: 'todo', cwd: WS_A, updatedAt: minutesAgo(2) },
    ],
  })
  const harness = createHarness({ snapshot })
  const { tree } = await renderComponent(harness.componentOf('main'), {})

  assert.equal(nodesWithClass(tree, 'tb-card').length, 4)
  const chatButtons = buttons(tree).filter((node) => textOf(node).trim() === '对话')
  assert.equal(chatButtons.length, 3, 'only tasks with a linked session expose the 对话 action')

  const clickChat = (title) => {
    const card = cardByTitle(tree, title)
    assert.ok(card, 'card must render: ' + title)
    const button = buttons(card).find((node) => textOf(node).trim() === '对话')
    assert.ok(button, 'missing 对话 button on ' + title)
    button.props.onClick()
  }

  clickChat('有发起会话')
  assert.deepEqual(harness.openSessionCalls, ['session-aaaa1111'], 'creator session id is used when no dispatch ran')
  clickChat('有执行会话')
  assert.deepEqual(harness.openSessionCalls, ['session-aaaa1111', 'session-bbbb2222'])
  clickChat('两者都有')
  assert.deepEqual(
    harness.openSessionCalls,
    ['session-aaaa1111', 'session-bbbb2222', 'session-dddd4444'],
    'dispatchedSessionId wins over the creator session',
  )

  const noSessionCard = cardByTitle(tree, '没有会话')
  assert.ok(noSessionCard)
  assert.ok(
    !buttons(noSessionCard).some((node) => textOf(node).trim() === '对话'),
    'task without sessions must not expose the 对话 action',
  )
})

test('详情「关联对话」：发起/执行按钮分别用对应 id 调 openSession，无会话给 muted 文案', async () => {
  const snapshot = makeSnapshot({
    tasks: [
      {
        id: 's-both',
        title: '两者都有',
        status: 'todo',
        cwd: WS_A,
        sessionId: 'session-cccc3333',
        dispatchedSessionId: 'session-dddd4444',
        updatedAt: minutesAgo(2),
      },
      { id: 's-none', title: '没有会话', status: 'todo', cwd: WS_A, updatedAt: minutesAgo(2) },
    ],
  })
  const harness = createHarness({ snapshot })
  const { tree, instance } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), {
    sessionId: SESSION_A,
  })

  const opened = await openDetailByTitle(instance, tree, '两者都有')
  assert.ok(detailText(opened).includes('关联对话'), 'detail must render the linked-sessions section')
  const sessionButtons = detailSessionButtons(opened)
  assert.equal(sessionButtons.length, 2, 'creator + dispatched session buttons')

  const creator = sessionButtons.find((node) => textOf(node).startsWith('发起对话'))
  assert.ok(creator, 'creator-session button must render')
  assert.equal(textOf(creator), '发起对话 · cccc3333')
  assert.equal(creator.props.title, 'session-cccc3333')

  const runner = sessionButtons.find((node) => textOf(node).startsWith('执行对话'))
  assert.ok(runner, 'dispatched-session button must render')
  assert.equal(textOf(runner), '执行对话 · dddd4444')
  assert.equal(runner.props.title, 'session-dddd4444')

  creator.props.onClick()
  assert.deepEqual(harness.openSessionCalls, ['session-cccc3333'])
  runner.props.onClick()
  assert.deepEqual(harness.openSessionCalls, ['session-cccc3333', 'session-dddd4444'])

  // 关闭后打开无会话任务：只有一个 muted 文案，没有会话按钮
  const closeButton = buttons(opened).find((node) => node.props['aria-label'] === '关闭')
  closeButton.props.onClick()
  const closed = await instance.run()
  const noneTree = await openDetailByTitle(instance, closed, '没有会话')
  assert.equal(detailSessionButtons(noneTree).length, 0, 'no session buttons without sessions')
  assert.ok(
    nodesWithClass(noneTree, 'tb-detail-muted').some((node) => textOf(node).includes('（这条任务还没有关联对话）')),
    'no-session muted text must render',
  )
})

test('uiWorkspace 缺失：卡片「对话」/详情会话按钮点击只 warn，不抛异常', async () => {
  const snapshot = makeSnapshot({
    tasks: [
      { id: 'w-1', title: '有关联会话', status: 'todo', cwd: WS_A, sessionId: 'session-eeee5555', updatedAt: minutesAgo(2) },
    ],
  })
  const harness = createHarness({ snapshot, uiWorkspace: false })
  const { tree, instance } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), {
    sessionId: SESSION_A,
  })

  const card = cardByTitle(tree, '有关联会话')
  assert.ok(card)
  const chatButton = buttons(card).find((node) => textOf(node).trim() === '对话')
  assert.ok(chatButton)
  assert.doesNotThrow(() => chatButton.props.onClick())
  assert.deepEqual(harness.openSessionCalls, [], 'missing uiWorkspace must not call anything')
  assert.ok(
    harness.warnings.some((line) => line.includes('uiWorkspace 不可用')),
    'missing uiWorkspace must warn, got: ' + JSON.stringify(harness.warnings),
  )

  const opened = await openDetailByTitle(instance, tree, '有关联会话')
  const creator = detailSessionButtons(opened).find((node) => textOf(node).startsWith('发起对话'))
  assert.ok(creator)
  const warningsBefore = harness.warnings.length
  assert.doesNotThrow(() => creator.props.onClick())
  assert.ok(harness.warnings.length > warningsBefore, 'detail session button must also warn')
  assert.deepEqual(harness.openSessionCalls, [])
})

/* ══════════════════════════════════════════════════════════════
 * 用例：进行中任务的「执行对话」兜底（老 Host 派发时没记 dispatchedSessionId）
 * ══════════════════════════════════════════════════════════════ */

const DISPATCH_SESSION = 'session-eeee1111'

function pollWithDispatch(overrides = {}) {
  return Object.assign(
    {
      lastRunAt: minutesAgo(1),
      lastDispatchAt: minutesAgo(3),
      lastDispatchSessionId: DISPATCH_SESSION,
      lastDispatchSessionTitle: '执行会话',
      lastDispatchTaskId: null,
      lastSkipReason: null,
    },
    overrides,
  )
}

test('doing 兜底 A：只有一条 doing 时用 poll.lastDispatchSessionId 当执行对话', async () => {
  const snapshot = makeSnapshot({
    poll: pollWithDispatch(),
    tasks: [{ id: 'd-1', title: '进行中的任务', status: 'doing', cwd: WS_A, updatedAt: minutesAgo(2) }],
  })
  const harness = createHarness({ snapshot })
  const { tree, instance } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), {
    sessionId: SESSION_A,
  })

  const card = cardByTitle(tree, '进行中的任务')
  assert.ok(card)
  const chat = buttons(card).find((node) => textOf(node).trim() === '对话')
  assert.ok(chat, 'single doing task must expose the fallback 对话 action')
  chat.props.onClick()
  assert.deepEqual(harness.openSessionCalls, [DISPATCH_SESSION])

  const opened = await openDetailByTitle(instance, tree, '进行中的任务')
  const runSession = detailSessionButtons(opened).find((node) => textOf(node).startsWith('执行对话'))
  assert.ok(runSession, 'detail must expose 执行对话 from the fallback')
  assert.equal(textOf(runSession), '执行对话 · eeee1111')
  assert.equal(runSession.props.title, DISPATCH_SESSION)
  runSession.props.onClick()
  assert.deepEqual(harness.openSessionCalls, [DISPATCH_SESSION, DISPATCH_SESSION])
})

test('doing 兜底 B：两条 doing 且 lastDispatchTaskId 缺失时都不显示（避免张冠李戴）', async () => {
  const snapshot = makeSnapshot({
    poll: pollWithDispatch({ lastDispatchTaskId: null }),
    tasks: [
      { id: 'd-1', title: '进行中甲', status: 'doing', cwd: WS_A, updatedAt: minutesAgo(2) },
      { id: 'd-2', title: '进行中乙', status: 'doing', cwd: WS_A, updatedAt: minutesAgo(2) },
    ],
  })
  const harness = createHarness({ snapshot })
  const { tree, instance } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), {
    sessionId: SESSION_A,
  })

  assert.equal(nodesWithClass(tree, 'tb-card').length, 2)
  assert.equal(
    buttons(tree).filter((node) => textOf(node).trim() === '对话').length,
    0,
    'two doing tasks without a dispatch pointer must not expose 对话',
  )

  const opened = await openDetailByTitle(instance, tree, '进行中甲')
  assert.equal(detailSessionButtons(opened).length, 0, 'no session button in detail either')
  assert.ok(
    nodesWithClass(opened, 'tb-detail-muted').some((node) => textOf(node).includes('（这条任务还没有关联对话）')),
    'detail shows the no-session muted text',
  )
  assert.deepEqual(harness.openSessionCalls, [])
})

test('doing 兜底 C：lastDispatchTaskId 精确命中哪条，只有那条显示执行对话', async () => {
  const snapshot = makeSnapshot({
    poll: pollWithDispatch({ lastDispatchTaskId: 'd-2' }),
    tasks: [
      { id: 'd-1', title: '进行中甲', status: 'doing', cwd: WS_A, updatedAt: minutesAgo(2) },
      { id: 'd-2', title: '进行中乙', status: 'doing', cwd: WS_A, updatedAt: minutesAgo(2) },
    ],
  })
  const harness = createHarness({ snapshot })
  const { tree, instance } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), {
    sessionId: SESSION_A,
  })

  const chatButtons = buttons(tree).filter((node) => textOf(node).trim() === '对话')
  assert.equal(chatButtons.length, 1, 'only the task named by lastDispatchTaskId gets the fallback')

  const matchedCard = cardByTitle(tree, '进行中乙')
  assert.ok(matchedCard)
  const matchedChat = buttons(matchedCard).find((node) => textOf(node).trim() === '对话')
  assert.ok(matchedChat)
  const otherCard = cardByTitle(tree, '进行中甲')
  assert.ok(otherCard)
  assert.ok(!buttons(otherCard).some((node) => textOf(node).trim() === '对话'))

  matchedChat.props.onClick()
  assert.deepEqual(harness.openSessionCalls, [DISPATCH_SESSION])

  // 命中的那条详情里有「执行对话」，没命中的那条没有
  const matchedTree = await openDetailByTitle(instance, tree, '进行中乙')
  assert.equal(detailSessionButtons(matchedTree).length, 1)
  assert.ok(textOf(detailSessionButtons(matchedTree)[0]).startsWith('执行对话'))

  const closeButton = buttons(matchedTree).find((node) => node.props['aria-label'] === '关闭')
  closeButton.props.onClick()
  const closed = await instance.run()
  const otherTree = await openDetailByTitle(instance, closed, '进行中甲')
  assert.equal(detailSessionButtons(otherTree).length, 0)
})

/* ══════════════════════════════════════════════════════════════
 * 用例：v0.2.0 组长条（主会话绑定 / 工作区组长）与派发模式
 * ══════════════════════════════════════════════════════════════ */

const MAIN_SESSION = 'session-main-1111'
const MAIN_SESSION_TITLE = '修复登录重试问题的对话'
const LEAD_A = 'session-lead-a'
const LEAD_B = 'session-lead-b'
const LEAD_C = 'session-lead-c'

function leadsFixture(overrides = {}) {
  return Object.assign(
    {
      main: { sessionId: MAIN_SESSION, title: MAIN_SESSION_TITLE, live: true, busy: false },
      workspaces: [
        { key: 'w1', label: '工作区 A', cwd: WS_A, sessionId: LEAD_A, title: 'A 组长会话', live: true, busy: false },
        { key: 'w2', label: '工作区 B', cwd: WS_B, sessionId: LEAD_B, title: 'B 组长会话', live: true, busy: true },
        { key: 'w3', label: '工作区 C', cwd: 'C:\\work\\c', sessionId: LEAD_C, title: 'C 组长会话', live: false, busy: false },
      ],
    },
    overrides,
  )
}

/** 等异步 RPC / setState 链落稳（驱动器不 await onClick，只能靠 setImmediate 排空）。 */
async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function leadBar(tree) {
  return collect(tree).find((node) => hasClass(node, 'tb-leads')) || null
}

function leadBarText(tree) {
  const bar = leadBar(tree)
  return bar ? textOf(bar) : ''
}

function leadCell(tree, kind, needle) {
  const bar = leadBar(tree)
  if (!bar) return null
  return (
    collect(bar).find((node) => hasClass(node, 'tb-lead-' + kind) && textOf(node).includes(needle)) || null
  )
}

function buttonByText(container, label) {
  return buttons(container).find((node) => textOf(node).trim() === label) || null
}

async function clickAndRun(instance, container, label) {
  const button = buttonByText(container, label)
  assert.ok(button, 'button must render: ' + label)
  button.props.onClick()
  await settle()
  return instance.run()
}

function rpcPayload(harness, endpoint) {
  const call = harness.rpcCalls.find((item) => item.endpoint === endpoint)
  return call ? Object.assign({}, call.payload) : null
}

test('组长条纯函数：状态点 / 标题尾 8 / 主会话行 / 工作区行 / 任务组长文案 / 派发模式', () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const helpers = harness.exported.__test

  // 派发模式：v0.2.0 缺省 / 未知值回退 workspace-lead（不回退 new）
  assert.deepEqual(Array.from(helpers.dispatchModes), ['workspace-lead', 'new', 'creator', 'auto'])
  assert.equal(helpers.dispatchModeOf({ dispatchMode: 'workspace-lead' }), 'workspace-lead')
  assert.equal(helpers.dispatchModeOf({ dispatchMode: 'creator' }), 'creator')
  assert.equal(helpers.dispatchModeOf({}), 'workspace-lead')
  assert.equal(helpers.dispatchModeOf({ dispatchMode: 'nonsense' }), 'workspace-lead')
  assert.equal(helpers.dispatchModeOf(null), 'workspace-lead')

  // 状态点：missing / offline / busy / online
  assert.equal(helpers.leadStatusKey(null), 'missing')
  assert.equal(helpers.leadStatusKey({ sessionId: '' }), 'missing')
  assert.equal(helpers.leadStatusKey({ sessionId: 's1', live: false }), 'offline')
  assert.equal(helpers.leadStatusKey({ sessionId: 's1' }), 'offline') // 缺 live 字段按离线，不误报在线
  assert.equal(helpers.leadStatusKey({ sessionId: 's1', live: true, busy: true }), 'busy')
  assert.equal(helpers.leadStatusKey({ sessionId: 's1', live: true, busy: false }), 'online')
  assert.equal(helpers.leadStatusKey({ sessionId: 's1', archived: true, live: true, busy: false }), 'archived')

  // 标题尾 8：长标题取后 8 字，空串用 fallback
  assert.equal(helpers.leadTitleTail(MAIN_SESSION_TITLE, '主会话'), MAIN_SESSION_TITLE.slice(-8))
  assert.equal(helpers.leadTitleTail('短标题', '主会话'), '短标题')
  assert.equal(helpers.leadTitleTail('', '主会话'), '主会话')
  assert.equal(helpers.leadTitleTail(null, '主会话'), '主会话')

  // 主会话行：未绑定 = null
  assert.equal(helpers.leadMainRow({ main: null }), null)
  assert.equal(helpers.leadMainRow(null), null)
  assert.deepEqual(
    JSON.parse(JSON.stringify(helpers.leadMainRow(leadsFixture()))),
    { sessionId: MAIN_SESSION, title: MAIN_SESSION_TITLE, status: 'online' },
  )

  // 任务组长文案：dispatchedSessionTitle 优先，其次会话 id 尾 8，都没有为空
  assert.equal(helpers.taskLeadLabel({ dispatchedSessionTitle: 'A 组长会话' }), 'A 组长会话')
  assert.equal(helpers.taskLeadLabel({ dispatchedSessionId: 'session-abcdef1234' }), 'cdef1234')
  assert.equal(helpers.taskLeadLabel({ dispatchedSessionTitle: '  ', dispatchedSessionId: 'abcd1234' }), 'abcd1234')
  assert.equal(helpers.taskLeadLabel({}), '')

  // 可见任务涉及的工作区：当前工作区优先、去重
  assert.deepEqual(
    Array.from(helpers.taskWorkspaceCwds([{ cwd: WS_A }, { cwd: 'c:/work/a/' }, { cwd: WS_B }], WS_A)),
    [WS_A, WS_B],
  )
  assert.deepEqual(Array.from(helpers.taskWorkspaceCwds([], '')), [])

  // 完整看板：列出全部；右栏：只列可见任务的 key，缺组长的补 missing 行
  const all = JSON.parse(JSON.stringify(helpers.workspaceLeadRows(leadsFixture(), [], { all: true })))
  assert.deepEqual(
    all.map((row) => row.key),
    ['w1', 'w2', 'w3'],
  )
  assert.deepEqual(
    all.map((row) => row.status),
    ['online', 'busy', 'offline'],
  )
  const filtered = JSON.parse(JSON.stringify(helpers.workspaceLeadRows(leadsFixture(), [WS_A], { all: false })))
  assert.deepEqual(
    filtered.map((row) => row.label),
    ['工作区 A'],
  )
  const missing = JSON.parse(JSON.stringify(helpers.workspaceLeadRows({ workspaces: [] }, [WS_B], { all: false })))
  assert.equal(missing.length, 1)
  assert.equal(missing[0].status, 'missing')
  assert.equal(missing[0].missing, true)
  assert.equal(missing[0].label, 'b')
  assert.equal(missing[0].cwd, WS_B)
})

test('BoardTab 组长条：未绑定主会话 + 绑定按钮 → bind-main-session{当前会话 id}', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })

  assert.ok(leadBar(rendered.tree), '两块看板共用的组长条必须渲染')
  assert.ok(leadBarText(rendered.tree).includes('未绑定主会话'))
  assert.ok(leadBarText(rendered.tree).includes('把当前对话设为主会话'))

  const bind = buttonByText(leadBar(rendered.tree), '把当前对话设为主会话')
  assert.ok(bind, 'bind button must render')
  assert.equal(bind.props.disabled, false)

  bind.props.onClick()
  await settle()
  assert.deepEqual(rpcPayload(harness, 'bind-main-session'), { sessionId: SESSION_A })
  const after = await rendered.instance.run()
  assert.ok(
    nodesWithClass(after, 'tb-banner').some((node) => includesText(node, '已把当前对话设为主会话')),
    'binding success must show an ok banner',
  )
  // 绑定成功后重新拉 snapshot
  assert.ok(countCalls(harness, 'snapshot') >= 2)
})

test('BoardTab 组长条：bind-main-session 失败时顶部错误条，不崩', async () => {
  const harness = createHarness({
    rpc: (channel, endpoint, payload) => {
      if (endpoint === 'session-info') {
        return Promise.resolve({ ok: true, value: { sessionId: payload && payload.sessionId, cwd: null } })
      }
      if (endpoint === 'bind-main-session') {
        return Promise.resolve({ ok: false, error: { code: 'bad-request', message: 'sessionId required' } })
      }
      return Promise.resolve({ ok: true, value: makeSnapshot() })
    },
  })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  const bind = buttonByText(leadBar(rendered.tree), '把当前对话设为主会话')
  assert.ok(bind)
  assert.doesNotThrow(() => bind.props.onClick())
  await settle()
  const after = await rendered.instance.run()
  const banners = nodesWithClass(after, 'tb-banner')
  assert.ok(
    banners.some((node) => node.props['data-tone'] === 'error' && includesText(node, '请求不合法')),
    'failed lead RPC must surface an error banner',
  )
  assert.ok(leadBar(after), 'lead bar still renders after the failed RPC')
})

test('BoardTab 组长条：拿不到当前会话 id（历史会话）时绑定按钮禁用并提示', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const { tree } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'))

  const bind = buttonByText(leadBar(tree), '把当前对话设为主会话')
  assert.ok(bind, 'bind button must still render')
  assert.equal(bind.props.disabled, true, 'no session id means the bind button is disabled')
  assert.match(String(bind.props.title), /拿不到当前会话 id/)
  assert.ok(leadBarText(tree).includes('拿不到当前会话 id'), 'disabled hint must be visible')
  assert.equal(countCalls(harness, 'bind-main-session'), 0)
})

test('BoardTab 组长条：已绑定主会话 → 标题尾 8 + 在线点 + 打开/换绑/解除绑定', async () => {
  const harness = createHarness({ snapshot: makeSnapshot({ leads: leadsFixture() }) })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })

  const barText = leadBarText(rendered.tree)
  assert.ok(barText.includes('主会话 · ' + MAIN_SESSION_TITLE.slice(-8)), 'main title tail must render: ' + barText)
  const mainCell = leadCell(rendered.tree, 'main', '主会话')
  assert.ok(mainCell, 'main led cell must render')
  const mainDot = collect(mainCell).find((node) => hasClass(node, 'tb-lead-dot'))
  assert.ok(mainDot)
  assert.equal(mainDot.props['data-status'], 'online')
  assert.ok(includesText(mainCell, '在线'))

  // 打开：走 uiWorkspace.openSession(主会话 id)
  let next = await clickAndRun(rendered.instance, mainCell, '打开')
  assert.deepEqual(harness.openSessionCalls, [MAIN_SESSION])

  // 换绑：再用当前会话 id 绑一次
  const rebindCell = leadCell(next, 'main', '主会话')
  await clickAndRun(rendered.instance, rebindCell, '换绑')
  assert.deepEqual(rpcPayload(harness, 'bind-main-session'), { sessionId: SESSION_A })

  // 解除绑定：clear-main-session {}
  const clearCell = leadCell(await rendered.instance.run(), 'main', '主会话')
  await clickAndRun(rendered.instance, clearCell, '解除绑定')
  assert.deepEqual(rpcPayload(harness, 'clear-main-session'), {})
})

test('BoardTab 组长条：主会话/工作区组长被归档 → 已归档状态 + 可重建组长', async () => {
  const leads = leadsFixture()
  leads.main = { ...leads.main, archived: true }
  leads.workspaces = leads.workspaces.map((row) => (row.key === 'w1' ? { ...row, archived: true } : row))
  const harness = createHarness({ snapshot: makeSnapshot({ leads }) })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })

  const barText = leadBarText(rendered.tree)
  assert.ok(barText.includes('已归档'), 'archived main/lead must render the archived state: ' + barText)

  const mainCell = leadCell(rendered.tree, 'main', '主会话')
  assert.ok(mainCell, 'main lead cell must render')
  const mainDot = collect(mainCell).find((node) => hasClass(node, 'tb-lead-dot'))
  assert.equal(mainDot.props['data-status'], 'archived')
  assert.ok(includesText(mainCell, '已归档'))

  const leadCellA = leadCell(rendered.tree, 'ws', '工作区 A')
  assert.ok(leadCellA, 'archived workspace lead cell must render')
  await clickAndRun(rendered.instance, leadCellA, '创建组长')
  assert.deepEqual(rpcPayload(harness, 'ensure-workspace-lead'), { cwd: WS_A })
})

test('BoardTab 组长条：工作区组长只列本看板可见任务涉及的工作区（在线/忙状态点 + 打开）', async () => {
  const harness = createHarness({ snapshot: makeSnapshot({ leads: leadsFixture() }) })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })

  const barText = leadBarText(rendered.tree)
  assert.ok(barText.includes('组长 · 工作区 A'), 'visible workspace lead must render: ' + barText)
  assert.ok(barText.includes('在线'))
  assert.ok(!barText.includes('工作区 B'), 'lead of another workspace must not leak into the right board')
  assert.ok(!barText.includes('工作区 C'), 'offline lead of another workspace must not leak either')

  const leadCellA = leadCell(rendered.tree, 'ws', '工作区 A')
  assert.ok(leadCellA, 'workspace lead cell must render')
  await clickAndRun(rendered.instance, leadCellA, '打开')
  assert.deepEqual(harness.openSessionCalls, [LEAD_A])
})

test('BoardTab 组长条：当前工作区没有组长 → 创建组长 → ensure-workspace-lead{cwd}', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })

  const missingCell = leadCell(rendered.tree, 'ws', '组长 · a')
  assert.ok(missingCell, 'current workspace without a lead must render a missing row')
  const dot = collect(missingCell).find((node) => hasClass(node, 'tb-lead-dot'))
  assert.equal(dot.props['data-status'], 'missing')
  assert.ok(includesText(missingCell, '未创建'))

  await clickAndRun(rendered.instance, missingCell, '创建组长')
  assert.deepEqual(rpcPayload(harness, 'ensure-workspace-lead'), { cwd: WS_A })
  const after = await rendered.instance.run()
  assert.ok(
    nodesWithClass(after, 'tb-banner').some((node) => includesText(node, '已创建工作区组长')),
    'creating a lead must confirm with an ok banner',
  )
})

test('PlatformBoard 组长条：列出全部工作区组长（含忙/离线），主会话打开走 openSession', async () => {
  const harness = createHarness({ snapshot: makeSnapshot({ leads: leadsFixture() }) })
  const rendered = await renderComponent(harness.componentOf('main'), {})

  const barText = leadBarText(rendered.tree)
  for (const label of ['组长 · 工作区 A', '组长 · 工作区 B', '组长 · 工作区 C']) {
    assert.ok(barText.includes(label), 'missing workspace lead row: ' + label)
  }
  assert.ok(barText.includes('在线'))
  assert.ok(barText.includes('忙'))
  assert.ok(barText.includes('离线'))

  const mainCell = leadCell(rendered.tree, 'main', '主会话')
  await clickAndRun(rendered.instance, mainCell, '打开')
  assert.deepEqual(harness.openSessionCalls, [MAIN_SESSION])

  // 根作用域的平台页没有 session 绑定（还没渲染过会话 header）→ 换绑禁用
  const rebind = buttonByText(mainCell, '换绑')
  assert.ok(rebind)
  assert.equal(rebind.props.disabled, true)
})

test('PlatformBoard 组长条：先渲染过会话 header 后，绑定按钮可用并带当前会话 id', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  // 会话 header 会记录「最近渲染过的对话 id」（根作用域的 main 页拿不到 session 绑定）
  await renderComponent(harness.componentOf('conversation.session.header.actions'), { sessionId: SESSION_A })
  const rendered = await renderComponent(harness.componentOf('main'), {})

  const bind = buttonByText(leadBar(rendered.tree), '把当前对话设为主会话')
  assert.ok(bind, 'bind button must render')
  assert.equal(bind.props.disabled, false, 'known current session id enables binding')
  bind.props.onClick()
  await settle()
  assert.deepEqual(rpcPayload(harness, 'bind-main-session'), { sessionId: SESSION_A })
})

test('PlatformBoard 组长条：没有 leads.workspaces 时不显示「创建组长」（完整看板只列已有组长）', async () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const rendered = await renderComponent(harness.componentOf('main'), {})
  assert.ok(leadBar(rendered.tree))
  assert.equal(buttonByText(leadBar(rendered.tree), '创建组长'), null)
  assert.ok(!leadBarText(rendered.tree).includes('组长 · '))
})

test('任务卡片 / 详情：卡片只留标题 + 操作按钮，组长与执行者移到详情浮层', async () => {
  const snapshot = makeSnapshot({
    tasks: [
      {
        id: 'lead-1',
        title: '带组长信息的任务',
        status: 'doing',
        cwd: WS_A,
        assignee: 'worker-42',
        dispatchedSessionId: LEAD_A,
        dispatchedSessionTitle: 'A 组长会话',
        updatedAt: minutesAgo(2),
      },
    ],
  })
  const harness = createHarness({ snapshot })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })

  const card = cardByTitle(rendered.tree, '带组长信息的任务')
  assert.ok(card, 'card must render')
  // t-33：卡片正文只剩标题 + 操作按钮，组长 / 执行者不再挂在卡片上（点标题看详情）
  assert.equal(card.children.length, 2, 'card body must be title + action row')
  const cardText = textOf(card)
  assert.ok(!cardText.includes('组长: '), 'lead chip must not render on the card: ' + cardText)
  assert.ok(!cardText.includes('执行者'), 'assignee must not render on the card: ' + cardText)
  assert.equal(buttons(card.children[1]).length, 5, 'doing card keeps 详情/完成/打回/编辑/对话')
  assert.deepEqual(
    buttons(card.children[1]).map((node) => textOf(node).trim()),
    ['详情', '完成', '打回', '编辑', '对话'],
    'action row keeps every card action',
  )
  assert.deepEqual(harness.openSessionCalls, [])

  const opened = await openDetailByTitle(rendered.instance, rendered.tree, '带组长信息的任务')
  const { dts, dds } = detailLabels(opened)
  assert.ok(dts.includes('组长'), 'detail must label the lead row')
  assert.ok(dds.includes('A 组长会话'), 'detail must show the lead title')
  assert.ok(dds.includes('worker-42'), 'detail keeps the assignee row')
})

test('组长条：leads 变化不 bump revision 也要在轮询后更新（运行时视图）', async () => {
  let current = makeSnapshot()
  const harness = createHarness({
    rpc: (channel, endpoint, payload) => {
      if (endpoint === 'session-info') {
        return Promise.resolve({ ok: true, value: { sessionId: payload && payload.sessionId, cwd: null } })
      }
      return Promise.resolve({ ok: true, value: current })
    },
  })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  assert.ok(leadBarText(rendered.tree).includes('未绑定主会话'))

  // revision 不变，只改运行时 leads（Host 的组长启停 / 绑主会话不会 bump revision）
  current = makeSnapshot({ revision: 1, leads: leadsFixture() })
  assert.equal(current.revision, 1)
  assert.equal(typeof harness.intervals[0].fn, 'function')
  harness.intervals[0].fn() // 模拟一次 2s 轮询
  await settle()
  const updated = await rendered.instance.run()
  assert.ok(
    leadBarText(updated).includes('主会话 · ' + MAIN_SESSION_TITLE.slice(-8)),
    'runtime leads change must repaint the lead bar without a revision bump',
  )
})

test('组长条：workspace-lead 三个新 skip reason 有中文映射', async () => {
  const cases = [
    ['lead-busy', '工作区组长正在运行，等它空下来再派'],
    ['lead-unavailable', '工作区组长不可用：稍后重试，或在看板点「创建组长」'],
    ['lead-no-workspace', '无法解析任务的工作区：请从目标工作区的会话里重新加这条任务'],
  ]
  for (const [reason, text] of cases) {
    const harness = createHarness({ snapshot: makeSnapshot({ poll: Object.assign(pollWithDispatch(), { lastSkipReason: reason }) }) })
    const { tree } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
    assert.ok(includesText(tree, text), 'missing skip text for ' + reason)
  }
})

test('派发模式：config 缺 dispatchMode 时选择器回退 workspace-lead，不是 new', async () => {
  const harness = createHarness({ snapshot: makeSnapshot({ config: { pollEnabled: true, pollIntervalMs: 15000 } }) })
  const { tree } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  const select = selectByAria(tree, '派发到')
  assert.ok(select)
  assert.equal(select.props.value, 'workspace-lead')
  assert.ok(includesText(select, '工作区组长（推荐）'))
})

test('doing 兜底 D：dispatchedSessionId 仍然优先于 poll 兜底', async () => {
  const snapshot = makeSnapshot({
    poll: pollWithDispatch(),
    tasks: [
      {
        id: 'd-1',
        title: '进行中的任务',
        status: 'doing',
        cwd: WS_A,
        dispatchedSessionId: 'session-ffff2222',
        updatedAt: minutesAgo(2),
      },
    ],
  })
  const harness = createHarness({ snapshot })
  const { tree, instance } = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), {
    sessionId: SESSION_A,
  })

  const card = cardByTitle(tree, '进行中的任务')
  const chat = buttons(card).find((node) => textOf(node).trim() === '对话')
  assert.ok(chat)
  chat.props.onClick()
  assert.deepEqual(harness.openSessionCalls, ['session-ffff2222'], 'dispatchedSessionId must win over the fallback')

  const opened = await openDetailByTitle(instance, tree, '进行中的任务')
  const runSession = detailSessionButtons(opened).find((node) => textOf(node).startsWith('执行对话'))
  assert.ok(runSession)
  assert.equal(textOf(runSession), '执行对话 · ffff2222')
  assert.equal(runSession.props.title, 'session-ffff2222')
  runSession.props.onClick()
  assert.deepEqual(harness.openSessionCalls, ['session-ffff2222', 'session-ffff2222'])
})

/* ══════════════════════════════════════════════════════════════
 * v0.2.0 粘贴图片附件：粘贴 → 上传 → 短引用 / 缩略图 → 详情 <img>
 * ══════════════════════════════════════════════════════════════ */

const ATTACHMENT_ID = '11111111-1111-4111-8111-111111111111'
const ATTACHMENT_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

/** 模拟上传 / 读取附件的 RPC（其余端点返回给定 snapshot）。 */
function attachmentRpc(snapshot, options = {}) {
  return (channel, endpoint, payload) => {
    if (endpoint === 'session-info') {
      return Promise.resolve({ ok: true, value: { sessionId: payload && payload.sessionId, cwd: options.sessionCwd || WS_A } })
    }
    if (endpoint === 'upload-attachment') {
      return Promise.resolve({
        ok: true,
        value: {
          id: ATTACHMENT_ID,
          ref: 'attachment://' + ATTACHMENT_ID,
          mime: 'image/png',
          size: 8,
          name: (payload && payload.name) || 'image.png',
        },
      })
    }
    if (endpoint === 'attachment') {
      return Promise.resolve({
        ok: true,
        value: { id: payload && payload.id, mime: 'image/png', size: 8, dataUrl: ATTACHMENT_DATA_URL },
      })
    }
    return Promise.resolve({ ok: true, value: snapshot })
  }
}

function fakeImageFile(dataUrl = ATTACHMENT_DATA_URL, name = 'image.png') {
  return { type: 'image/png', name, dataUrl }
}

/** 造一个 paste 事件；返回 { event, state }，state.prevented 记录是否拦截默认行为。 */
function clipboardEvent(files, items) {
  const state = { prevented: false }
  const event = {
    preventDefault() {
      state.prevented = true
    },
    clipboardData: {
      items:
        items ||
        files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      files: [],
    },
  }
  return { event, state }
}

async function settleAsync(times = 4) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function noteTextarea(tree) {
  return collect(tree).find((node) => node.type === 'textarea' && hasClass(node, 'tb-textarea')) || null
}

async function openNoteEditor(instance, tree) {
  const addNote = buttons(tree).find((node) => textOf(node).trim() === '加备注')
  assert.ok(addNote, '加备注 button must render')
  addNote.props.onClick()
  return instance.run()
}

test('BoardTab：备注粘贴图片 → 上传 → 短引用 + 缩略图；删除 / 提交都只动引用', async () => {
  const snapshot = makeSnapshot()
  const harness = createHarness({ snapshot, rpc: attachmentRpc(snapshot) })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  let tree = await openNoteEditor(rendered.instance, rendered.tree)
  let textarea = noteTextarea(tree)
  assert.ok(textarea, 'note textarea must render')
  assert.equal(typeof textarea.props.onPaste, 'function', 'note textarea must listen for paste')

  const first = clipboardEvent([fakeImageFile()])
  assert.equal(textarea.props.onPaste(first.event), true)
  assert.equal(first.state.prevented, true, 'image paste must prevent the default text insert')
  await settleAsync()
  tree = await rendered.instance.run()
  textarea = noteTextarea(tree)
  assert.ok(textarea.props.value.includes('![image](attachment://' + ATTACHMENT_ID + ')'), 'short ref must be inserted')
  assert.equal(textarea.props.value.includes('base64'), false, 'note never stores base64')
  const thumbs = nodesWithClass(tree, 'tb-attach-thumb')
  assert.equal(thumbs.length, 1, 'pending image thumbnail must render')
  assert.equal(thumbs[0].props.src, ATTACHMENT_DATA_URL)
  const uploadCall = harness.rpcCalls.find((call) => call.endpoint === 'upload-attachment')
  assert.ok(uploadCall, 'paste must call upload-attachment')
  assert.equal(uploadCall.channel, '/taskboard')
  assert.equal(uploadCall.payload.dataUrl, ATTACHMENT_DATA_URL)

  // 删除待提交图片：缩略图与 note 引用一起删。
  const remove = nodesWithClass(tree, 'tb-attach-remove')[0]
  assert.ok(remove, 'remove button must render')
  remove.props.onClick()
  tree = await rendered.instance.run()
  assert.equal(noteTextarea(tree).props.value.includes('attachment://'), false)
  assert.equal(nodesWithClass(tree, 'tb-attach-thumb').length, 0)

  // 再贴一次并提交：add-task 只带短引用。
  noteTextarea(tree).props.onPaste(clipboardEvent([fakeImageFile()]).event)
  await settleAsync()
  tree = await rendered.instance.run()
  composerInput(tree).props.onChange({ target: { value: '粘贴图片任务' } })
  tree = await rendered.instance.run()
  const submit = submitButton(tree)
  assert.equal(submit.props.disabled, false)
  submit.props.onClick()
  await settleAsync()
  const addCall = harness.rpcCalls.find((call) => call.endpoint === 'add-task')
  assert.ok(addCall, 'submit must call add-task')
  assert.equal(addCall.payload.note, '![image](attachment://' + ATTACHMENT_ID + ')')
  assert.equal(String(addCall.payload.note).includes('data:image'), false)
})

test('BoardTab：普通文本粘贴不拦截、不触发上传', async () => {
  const snapshot = makeSnapshot()
  const harness = createHarness({ snapshot, rpc: attachmentRpc(snapshot) })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  const tree = await openNoteEditor(rendered.instance, rendered.tree)
  const textarea = noteTextarea(tree)
  assert.ok(textarea)

  const text = clipboardEvent([], [{ kind: 'string', type: 'text/plain' }])
  assert.equal(textarea.props.onPaste(text.event), false)
  assert.equal(text.state.prevented, false, 'text paste must keep the browser default')
  assert.equal(countCalls(harness, 'upload-attachment'), 0)
})

test('BoardTab：一次粘贴超过 4 张只上传前 4 张并提示分次粘贴', async () => {
  const snapshot = makeSnapshot()
  const harness = createHarness({ snapshot, rpc: attachmentRpc(snapshot) })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  let tree = await openNoteEditor(rendered.instance, rendered.tree)
  const textarea = noteTextarea(tree)
  assert.ok(textarea)

  const files = Array.from({ length: 6 }, (_, index) => fakeImageFile(ATTACHMENT_DATA_URL, 'image-' + index + '.png'))
  textarea.props.onPaste(clipboardEvent(files).event)
  await settleAsync()
  tree = await rendered.instance.run()
  assert.equal(countCalls(harness, 'upload-attachment'), 4, 'a single paste must upload at most 4 images')
  assert.ok(includesText(tree, '一次最多粘贴 4 张图片'), 'the over-limit hint must render')
})

test('PlatformBoard：备注粘贴图片同样可用，提交仍带必选工作区', async () => {
  const snapshot = makeSnapshot()
  const harness = createHarness({ snapshot, rpc: attachmentRpc(snapshot) })
  const rendered = await renderComponent(harness.componentOf('main'), {})
  let tree = await openNoteEditor(rendered.instance, rendered.tree)

  const workspaceSelect = selectByAria(tree, '任务所属工作区')
  assert.ok(workspaceSelect, 'platform composer must offer a workspace select')
  workspaceSelect.props.onChange({ target: { value: WS_A } })
  tree = await rendered.instance.run()

  const textarea = noteTextarea(tree)
  assert.ok(textarea)
  const paste = clipboardEvent([fakeImageFile()])
  assert.equal(textarea.props.onPaste(paste.event), true)
  assert.equal(paste.state.prevented, true)
  await settleAsync()
  tree = await rendered.instance.run()
  assert.ok(noteTextarea(tree).props.value.includes('![image](attachment://' + ATTACHMENT_ID + ')'))
  assert.equal(nodesWithClass(tree, 'tb-attach-thumb').length, 1)

  composerInput(tree).props.onChange({ target: { value: '平台贴图任务' } })
  tree = await rendered.instance.run()
  const submit = submitButton(tree)
  assert.equal(submit.props.disabled, false)
  submit.props.onClick()
  await settleAsync()
  const addCall = harness.rpcCalls.find((call) => call.endpoint === 'add-task')
  assert.ok(addCall)
  assert.equal(addCall.payload.cwd, WS_A)
  assert.equal(addCall.payload.note, '![image](attachment://' + ATTACHMENT_ID + ')')
})

test('Detail：note / result 里的附件引用按需拉取并渲染 <img class="tb-rich-img">', async () => {
  const note = '截图：\n\n![image](attachment://' + ATTACHMENT_ID + ')\n\n验收标准：按钮可点。'
  const result = '已修复，效果见 ![image](attachment://' + ATTACHMENT_ID + ')'
  const snapshot = makeSnapshot({
    tasks: [
      {
        id: 't-attachment',
        title: '带截图的完成',
        status: 'done',
        cwd: WS_A,
        note,
        result,
        updatedAt: minutesAgo(2),
      },
    ],
  })
  const harness = createHarness({ snapshot, rpc: attachmentRpc(snapshot) })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  let tree = await openDetailByTitle(rendered.instance, rendered.tree, '带截图的完成')
  await settleAsync()
  tree = await rendered.instance.run()

  const images = nodesWithClass(tree, 'tb-rich-img')
  assert.equal(images.length, 2, 'note and result each render one image')
  assert.equal(images[0].props.src, ATTACHMENT_DATA_URL)
  assert.equal(images[0].props.alt, 'image')
  // 同一 id 在 note / result 各出现一次，但只请求一次（缓存）。
  const attachmentCalls = harness.rpcCalls.filter((call) => call.endpoint === 'attachment')
  assert.equal(attachmentCalls.length, 1)
  assert.equal(attachmentCalls[0].payload.id, ATTACHMENT_ID)
})

test('附件纯函数：引用插入去重 / 删除 / 识别粘贴图片 / 上限常量', () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const helpers = harness.exported.__test
  assert.equal(helpers.attachmentRef(ATTACHMENT_ID), '![image](attachment://' + ATTACHMENT_ID + ')')
  const note = helpers.insertAttachmentRef('验收标准', ATTACHMENT_ID)
  assert.equal(note, '验收标准\n![image](attachment://' + ATTACHMENT_ID + ')')
  assert.equal(helpers.insertAttachmentRef(note, ATTACHMENT_ID), note, 'same id must not be inserted twice')
  assert.equal(helpers.attachmentIdsIn(note, note).join(','), ATTACHMENT_ID)
  assert.equal(helpers.removeAttachmentRef(note, ATTACHMENT_ID), '验收标准')
  assert.equal(helpers.maxPasteImages, 4)
  assert.equal(helpers.clipboardImageFiles({ clipboardData: { items: [{ kind: 'string', type: 'text/plain' }] } }).length, 0)
  assert.equal(
    helpers
      .clipboardImageFiles({ clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => 'f' }] } })
      .join(','),
    'f',
  )
})


/* ══════════════════════════════════════════════════════════════
 * t-34 收尾：附件边界（5 MB 预检 / 上传计数 / 8 引用预检 / 缓存上限 / 占位）
 * ══════════════════════════════════════════════════════════════ */

/** 生成第 index 个合法 uuid（附件引用只认 uuid 形态）。 */
function attachmentIdAt(index) {
  return String(index + 1).padStart(8, '0') + '-1111-4111-8111-111111111111'
}

/** note 里放 count 个不同附件引用。 */
function noteWithRefs(count) {
  const parts = []
  for (let i = 0; i < count; i += 1) parts.push('![image](attachment://' + attachmentIdAt(i) + ')')
  return '验收标准：按钮可点。\n' + parts.join('\n')
}

test('BoardTab：粘贴前按 file.size 预检 5 MB，超限图片不发请求、混合批次只传合法的', async () => {
  const snapshot = makeSnapshot()
  const harness = createHarness({ snapshot, rpc: attachmentRpc(snapshot) })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  let tree = await openNoteEditor(rendered.instance, rendered.tree)
  const textarea = noteTextarea(tree)
  assert.ok(textarea)

  const tooBig = fakeImageFile(ATTACHMENT_DATA_URL, 'huge.png')
  tooBig.size = 5 * 1024 * 1024 + 1
  const paste = clipboardEvent([tooBig])
  assert.equal(textarea.props.onPaste(paste.event), true)
  assert.equal(paste.state.prevented, true, 'image paste is still intercepted')
  await settleAsync()
  tree = await rendered.instance.run()
  assert.equal(countCalls(harness, 'upload-attachment'), 0, 'oversized image must not be uploaded')
  assert.ok(includesText(tree, '单张图片不能超过 5 MB'), 'size hint must render')
  assert.ok(includesText(tree, '已跳过 1 张'))
  assert.equal(nodesWithClass(tree, 'tb-attach-thumb').length, 0)

  // 混合批次：大图跳过，小图照常上传
  noteTextarea(tree).props.onPaste(clipboardEvent([tooBig, fakeImageFile()]).event)
  await settleAsync()
  tree = await rendered.instance.run()
  assert.equal(countCalls(harness, 'upload-attachment'), 1)
  assert.equal(nodesWithClass(tree, 'tb-attach-thumb').length, 1)
  assert.ok(noteTextarea(tree).props.value.includes('attachment://' + ATTACHMENT_ID))
})

test('BoardTab：上传是计数——Enter / 提交按钮在上传中都不提交，连续粘贴不会提前解除禁用', async () => {
  const snapshot = makeSnapshot()
  const pendingUploads = []
  const baseRpc = attachmentRpc(snapshot)
  const rpc = (channel, endpoint, payload) => {
    if (endpoint === 'upload-attachment') {
      return new Promise((resolve) => {
        pendingUploads.push(() =>
          resolve({
            ok: true,
            value: { id: ATTACHMENT_ID, ref: 'attachment://' + ATTACHMENT_ID, mime: 'image/png', size: 8, name: 'image.png' },
          }),
        )
      })
    }
    return baseRpc(channel, endpoint, payload)
  }
  const harness = createHarness({ snapshot, rpc })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  let tree = await openNoteEditor(rendered.instance, rendered.tree)
  composerInput(tree).props.onChange({ target: { value: '上传中的任务' } })
  tree = await rendered.instance.run()

  // 两次连续粘贴 → 两个上传在飞（计数 2）
  noteTextarea(tree).props.onPaste(clipboardEvent([fakeImageFile()]).event)
  tree = await rendered.instance.run()
  noteTextarea(tree).props.onPaste(clipboardEvent([fakeImageFile('data:image/png;base64,AAAA')]).event)
  tree = await rendered.instance.run()
  await settleAsync(6)
  assert.equal(pendingUploads.length, 2)
  assert.equal(submitButton(tree).props.disabled, true, 'uploading must keep submit disabled')

  // 上传中按 Enter：不提交
  composerInput(tree).props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await settleAsync()
  assert.equal(countCalls(harness, 'add-task'), 0, 'Enter must not submit while uploading')

  // 只完成第一个上传：计数仍为 1 → 仍不能提交
  pendingUploads[0]()
  await settleAsync(6)
  tree = await rendered.instance.run()
  assert.equal(submitButton(tree).props.disabled, true, 'one finished upload must not re-enable submit')
  composerInput(tree).props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await settleAsync()
  assert.equal(countCalls(harness, 'add-task'), 0)

  // 全部完成 → 才允许提交
  pendingUploads[1]()
  await settleAsync(6)
  tree = await rendered.instance.run()
  assert.equal(submitButton(tree).props.disabled, false)
  composerInput(tree).props.onKeyDown({ key: 'Enter', shiftKey: false, preventDefault() {} })
  await settleAsync()
  assert.equal(countCalls(harness, 'add-task'), 1)
})

test('BoardTab：提交前统计 note 附件引用，超过 8 个给具体提示而不是通用「请求不合法」', async () => {
  const snapshot = makeSnapshot()
  const harness = createHarness({ snapshot, rpc: attachmentRpc(snapshot) })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  let tree = await openNoteEditor(rendered.instance, rendered.tree)
  composerInput(tree).props.onChange({ target: { value: '引用超限的任务' } })
  tree = await rendered.instance.run()

  noteTextarea(tree).props.onChange({ target: { value: noteWithRefs(9) } })
  tree = await rendered.instance.run()
  submitButton(tree).props.onClick()
  await settleAsync()
  tree = await rendered.instance.run()
  assert.equal(countCalls(harness, 'add-task'), 0, 'over-limit note must not be sent')
  assert.ok(includesText(tree, '一条任务最多 8 个图片附件（当前 9 个）'), 'specific over-limit hint must render')

  // 降到 8 个即恢复提交
  noteTextarea(tree).props.onChange({ target: { value: noteWithRefs(8) } })
  tree = await rendered.instance.run()
  submitButton(tree).props.onClick()
  await settleAsync()
  const addCall = harness.rpcCalls.find((call) => call.endpoint === 'add-task')
  assert.ok(addCall, 'note with 8 refs must be submitted')
  assert.equal(addCall.payload.note, noteWithRefs(8))
})

test('Detail：附件缓存上限 8 条，淘汰最旧的就绪项且不吞刚加载的一张', async () => {
  const ids = Array.from({ length: 9 }, (_, index) => attachmentIdAt(index))
  const note = ids.map((id) => '![image](attachment://' + id + ')').join('\n')
  const snapshot = makeSnapshot({
    tasks: [{ id: 't-cache', title: '九张截图的任务', status: 'todo', cwd: WS_A, note, updatedAt: minutesAgo(1) }],
  })
  const harness = createHarness({ snapshot, rpc: attachmentRpc(snapshot) })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  let tree = await openDetailByTitle(rendered.instance, rendered.tree, '九张截图的任务')
  await settleAsync(20)
  tree = await rendered.instance.run()

  assert.equal(harness.rpcCalls.filter((call) => call.endpoint === 'attachment').length, 9)
  assert.equal(nodesWithClass(tree, 'tb-rich-img').length, 8, 'cache keeps at most 8 data URLs')
  assert.equal(nodesWithClass(tree, 'tb-rich-attachment').length, 1, 'the evicted id falls back to the loading placeholder')
})

test('Detail：附件加载中 / 失败分别显示占位文本，不阻塞其它 Markdown 块', async () => {
  const note = '截图：\n\n![image](attachment://' + ATTACHMENT_ID + ')\n\n验收标准：按钮可点。'
  const snapshot = makeSnapshot({
    tasks: [{ id: 't-placeholder', title: '占位任务', status: 'todo', cwd: WS_A, note, updatedAt: minutesAgo(1) }],
  })

  // 加载中：attachment 一直不返回
  const loadingHarness = createHarness({
    snapshot,
    rpc: (channel, endpoint, payload) =>
      endpoint === 'attachment' ? new Promise(() => {}) : attachmentRpc(snapshot)(channel, endpoint, payload),
  })
  const loadingRendered = await renderNarrow(loadingHarness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  const loadingTree = await openDetailByTitle(loadingRendered.instance, loadingRendered.tree, '占位任务')
  assert.ok(includesText(loadingTree, '图片加载中…'), 'loading placeholder must render')
  assert.ok(includesText(loadingTree, '验收标准：按钮可点。'), 'other blocks must still render')
  assert.equal(nodesWithClass(loadingTree, 'tb-rich-img').length, 0)

  // 加载失败：attachment 返回 not-found
  const failedHarness = createHarness({
    snapshot,
    rpc: (channel, endpoint, payload) =>
      endpoint === 'attachment'
        ? Promise.resolve({ ok: false, error: { code: 'not-found', message: '附件不存在' } })
        : attachmentRpc(snapshot)(channel, endpoint, payload),
  })
  const failedRendered = await renderNarrow(failedHarness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  let failedTree = await openDetailByTitle(failedRendered.instance, failedRendered.tree, '占位任务')
  await settleAsync()
  failedTree = await failedRendered.instance.run()
  assert.ok(includesText(failedTree, '图片不可用'), 'failed placeholder must render')
  assert.equal(nodesWithClass(failedTree, 'tb-rich-img').length, 0)
  assert.ok(includesText(failedTree, '验收标准：按钮可点。'))
})

test('附件边界纯函数：5 MB 预检 / 上传计数 / 提交闸门 / 8 引用预检 / 死 locale 键已删', () => {
  const harness = createHarness({ snapshot: makeSnapshot() })
  const helpers = harness.exported.__test

  assert.equal(helpers.maxAttachmentBytes, 5 * 1024 * 1024)
  assert.equal(helpers.maxAttachmentMb, 5)
  assert.equal(helpers.maxNoteAttachments, 8)
  assert.equal(helpers.maxAttachmentCache, 8)

  const small = { size: 1024 }
  const big = { size: 5 * 1024 * 1024 + 1 }
  const budget = helpers.splitPasteImages([big, small, small, small, small, small])
  assert.equal(budget.tooLarge, 1)
  assert.equal(budget.accepted.length, 4, 'accepted keeps the 4-image paste cap')
  assert.equal(budget.skipped, 1)
  assert.equal(helpers.splitPasteImages([]).accepted.length, 0)
  assert.equal(helpers.splitPasteImages(undefined).tooLarge, 0)
  assert.equal(helpers.splitPasteImages([{}]).accepted.length, 1, 'unknown size is treated as 0, not as oversized')

  assert.equal(helpers.isUploading(0), false)
  assert.equal(helpers.isUploading(1), true)
  assert.equal(helpers.isUploading(undefined), false)
  assert.equal(helpers.isUploading(NaN), false)

  assert.equal(helpers.submitBlocked({ uploading: 1, title: '任务' }), true)
  assert.equal(helpers.submitBlocked({ uploading: 0, title: '任务' }), false)
  assert.equal(helpers.submitBlocked({ uploading: 0, title: '   ' }), true)
  assert.equal(helpers.submitBlocked({ uploading: 0, title: '任务', busy: 'add' }), true)
  assert.equal(helpers.submitBlocked({ uploading: 0, title: '任务', workspaceRequired: true }), true)

  const t = (key, params) => helpers.interpolate(helpers.DICT_ZH[key] || key, params)
  assert.equal(helpers.noteAttachmentLimitText(t, ''), '')
  assert.equal(helpers.noteAttachmentLimitText(t, noteWithRefs(8)), '')
  assert.equal(helpers.noteAttachmentLimitText(t, noteWithRefs(9)), '一条任务最多 8 个图片附件（当前 9 个）')

  // t-34 清理：卡片 meta / 页面副标题等 locale 键已无引用，zh/en 双份都删掉
  for (const dict of [helpers.DICT_ZH, helpers.DICT_EN]) {
    assert.equal(typeof dict['composer.imageTooLarge'], 'string')
    assert.equal(typeof dict['composer.attachmentTooMany'], 'string')
    for (const key of [
      'card.assignee',
      'card.result',
      'card.notified',
      'card.workspace',
      'card.lead',
      'card.deleteConfirm',
      'page.subtitle',
      'detail.status',
      'lead.archivedHint',
    ]) {
      assert.equal(dict[key], undefined, 'dead locale key must be gone: ' + key)
    }
  }
})

test('BoardTab：同批上传单项失败（读取 / 上传）不丢已成功的图片', async () => {
  const snapshot = makeSnapshot()
  const baseRpc = attachmentRpc(snapshot)
  const BAD_UPLOAD_DATA_URL = 'data:image/png;base64,QkFEWVBM'
  const rpc = (channel, endpoint, payload) => {
    if (endpoint === 'upload-attachment') {
      if (payload.dataUrl === BAD_UPLOAD_DATA_URL) {
        return Promise.resolve({ ok: false, error: { code: 'bad-request', message: '图片解析失败' } })
      }
      return Promise.resolve({
        ok: true,
        value: { id: ATTACHMENT_ID, ref: 'attachment://' + ATTACHMENT_ID, mime: 'image/png', size: 8, name: 'image.png' },
      })
    }
    return baseRpc(channel, endpoint, payload)
  }
  const harness = createHarness({ snapshot, rpc })
  const rendered = await renderNarrow(harness.componentOf('sidebar.right.pane.tab'), { sessionId: SESSION_A })
  let tree = await openNoteEditor(rendered.instance, rendered.tree)

  const badUpload = fakeImageFile(BAD_UPLOAD_DATA_URL, 'bad-upload.png')
  const badRead = {
    type: 'image/png',
    name: 'bad-read.png',
    get dataUrl() {
      throw new Error('read boom')
    },
  }
  noteTextarea(tree).props.onPaste(clipboardEvent([badUpload, badRead, fakeImageFile()]).event)
  await settleAsync(8)
  tree = await rendered.instance.run()

  assert.equal(countCalls(harness, 'upload-attachment'), 2, 'the unreadable file never reaches upload; the other two do')
  assert.equal(nodesWithClass(tree, 'tb-attach-thumb').length, 1, 'the successful upload must survive the batch')
  assert.ok(noteTextarea(tree).props.value.includes('attachment://' + ATTACHMENT_ID), 'successful short ref must stay in the note')
  assert.ok(includesText(tree, '图片解析失败'), 'the concrete upload error is surfaced')
})
