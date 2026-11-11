import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 文档桩：够 injectCss() 幂等注入用，并记录 <style> 数量。 */
function createDocumentStub() {
  const styleTags = []
  return {
    visibilityState: 'visible',
    styleTags,
    querySelector() {
      return null
    },
    createElement() {
      return {
        attrs: {},
        textContent: '',
        setAttribute(name, value) {
          this.attrs[name] = value
        },
        appendChild() {},
        removeChild() {},
      }
    },
    head: {
      appendChild(tag) {
        styleTags.push(tag)
      },
    },
    documentElement: { appendChild() {} },
  }
}

/** 在 vm 里跑 client bundle：stub window.__ModuleLoader__ 与 react，取回 factory 的导出。 */
function loadClient() {
  let captured = null
  const doc = createDocumentStub()
  const fakeWindow = {
    __ModuleLoader__: {
      load: (options) => {
        captured = options
      },
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    confirm: () => true,
  }
  const sandbox = {
    window: fakeWindow,
    document: doc,
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Promise,
    Symbol,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }
  vm.createContext(sandbox)
  vm.runInContext(clientSource, sandbox, { filename: 'lib/client.js' })
  assert.ok(captured, 'window.__ModuleLoader__.load must be called')
  assert.equal(captured.id, 'dsh-taskboard')

  const fakeReact = {
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
  }
  const exported = captured.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error('unexpected require: ' + id)
  })
  return { exported, captured, doc }
}

/**
 * apply 级测试宿主：支持 ctx.inject(deps, cb)、槽位注册、右栏 tab 注册。
 * - 服务按需提供（sidebarRightTabs / sidebarRight 可分别缺失，模拟 cordis 里「服务未就绪 → 不回调」）。
 * - scope.effect 会立即执行回调并记录 cleanup，用来断言「register 包在 effect 里，卸载会 dispose」。
 */
function createApplyHarness(options = {}) {
  const { exported, doc } = loadClient()

  const registrations = []
  const slotInjections = []
  const injectRequests = []
  const scopeEffects = []
  const tabs = { definitions: [], disposed: [] }
  const openTabCalls = []
  const localeRegistrations = []
  const effects = []
  const cleanups = []

  const styleTags = doc.styleTags

  const slots = options.slots === false ? undefined : {
    inject(name, factory) {
      slotInjections.push(name)
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(registration, component) {
      registrations.push({ options: registration, component })
      return () => {}
    },
  }

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
    slots,
    connection: {
      rpc: {
        call: async () => ({ ok: true, value: { tasks: [] } }),
      },
    },
    locale: {
      register(namespace, lang) {
        localeRegistrations.push({ namespace, lang })
        return () => {}
      },
      unregister() {},
      bind: () => (key) => key,
      getLocale: () => ({ active: 'zh-CN' }),
    },
  }

  const scopeServices = { sidebarRightTabs: tabsService, sidebarRight: sidebarRightService }

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
    // 模拟 cordis 的 fiber 注入：所有依赖就绪才回调，否则一直 pending（不调用、不抛错）。
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
    interval() {
      return () => {}
    },
    timeout() {
      return () => {}
    },
    on() {
      return () => {}
    },
  }

  exported.apply(fakeCtx)

  return {
    exported,
    registrations,
    slotInjections,
    injectRequests,
    scopeEffects,
    tabs,
    openTabCalls,
    localeRegistrations,
    styleTags,
    effects,
    cleanups,
    services,
  }
}

test('client bundle exposes apply/inject and only requires react', () => {
  const { exported, captured } = loadClient()
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual([...exported.inject], ['slots', 'connection', 'timer', 'locale'])
  assert.equal(captured.id, 'dsh-taskboard')
})

test('apply 注册右栏 tab 类型（包在 effect 里）并注册三个槽位', () => {
  const harness = createApplyHarness()

  // 1) 两个 cordis 注入点：tab 类型 + 右栏导航服务
  assert.deepEqual(harness.injectRequests, [['sidebarRightTabs'], ['sidebarRight']])

  // 2) tab 类型定义：register 包在 scope.effect 里，definition 形状正确
  //    （sidebarRight 句柄也会注册一个清理 effect，所以按 label 精确找 tab 类型那个。）
  const effectEntry = harness.scopeEffects.find((entry) => /sidebar-right tab type/.test(String(entry.label)))
  assert.ok(effectEntry, 'tab type register must run inside scope.effect')
  assert.equal(typeof effectEntry.cleanup, 'function', 'effect must hand back the register disposer')

  assert.equal(harness.tabs.definitions.length, 1)
  const definition = harness.tabs.definitions[0]
  assert.equal(definition.id, 'dsh-taskboard')
  assert.equal(definition.kind, 'taskboard')
  assert.equal(definition.priority, 'extension')
  assert.equal(typeof definition.title, 'function')
  assert.equal(definition.title(), '任务看板')
  assert.equal(Array.isArray(definition.guide), true)
  assert.equal(definition.guide.length, 1)
  const guide = definition.guide[0]
  assert.equal(guide.id, 'taskboard')
  assert.equal(guide.order, 20)
  assert.equal(typeof guide.title, 'function')
  assert.equal(guide.title(), '任务看板')
  assert.equal(typeof guide.description, 'function')
  assert.ok(guide.description().includes('右侧栏'), 'guide description should explain the right sidebar')
  assert.equal(typeof guide.icon, 'function', 'guide icon is the BoardGlyph component')

  // 卸载：effect cleanup 会 dispose 掉 tab 类型注册
  effectEntry.cleanup()
  assert.deepEqual(harness.tabs.disposed, ['dsh-taskboard'])
  assert.equal(harness.tabs.definitions.length, 0)

  // 3) 槽位：右栏 tab 正文 + tab chip + 会话 header 入口
  assert.deepEqual(harness.slotInjections, [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'conversation.session.header.actions',
  ])
  assert.deepEqual(
    harness.registrations.map((entry) => entry.options.name),
    ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'conversation.session.header.actions'],
  )

  const tabBody = harness.registrations[0]
  assert.equal(tabBody.options.key, 'dsh-taskboard')
  assert.equal(typeof tabBody.component, 'function')

  const tabTitle = harness.registrations[1]
  assert.equal(tabTitle.options.key, 'dsh-taskboard')
  assert.equal(typeof tabTitle.component, 'function')

  const headerAction = harness.registrations[2]
  assert.equal(headerAction.options.id, 'taskboard')
  assert.equal(headerAction.options.order, 40)
  assert.equal(typeof headerAction.options.label, 'function')
  assert.equal(headerAction.options.label(), '任务看板')
  assert.equal(typeof headerAction.component, 'function')

  // 旧契约（左侧栏入口 + main 页面）不应再注册
  assert.ok(!harness.registrations.some((entry) => entry.options.name === 'sidebar.panellist'))
  assert.ok(!harness.registrations.some((entry) => entry.options.name === 'main'))

  // 4) 插件资源：样式只注入一次；locale 字典 zh/en
  assert.equal(harness.styleTags.length, 1)
  assert.deepEqual(harness.localeRegistrations.map((entry) => entry.lang), ['zh', 'en'])
})

test('apply 在右侧栏服务缺失时安静降级（不崩、槽位照常注册）', () => {
  const harness = createApplyHarness({ sidebarRightTabs: false, sidebarRight: false })

  // 注入请求已被发起，但服务未就绪 → 回调不执行
  assert.deepEqual(harness.injectRequests, [['sidebarRightTabs'], ['sidebarRight']])
  assert.equal(harness.scopeEffects.length, 0)
  assert.equal(harness.tabs.definitions.length, 0)
  assert.equal(harness.openTabCalls.length, 0)

  // 槽位与资源注册不受影响
  assert.equal(harness.registrations.length, 3)
  assert.deepEqual(harness.slotInjections, [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'conversation.session.header.actions',
  ])
  assert.equal(harness.styleTags.length, 1)
})

test('apply survives a missing slots service', () => {
  const { exported } = loadClient()
  const fakeCtx = {
    get: () => undefined,
    effect: (fn) => {
      fn()
      return () => {}
    },
  }
  assert.doesNotThrow(() => exported.apply(fakeCtx))
})

test('formatting helpers behave', () => {
  const { exported } = loadClient()
  const helpers = exported.__test
  assert.equal(helpers.interpolate('a {n} b', { n: 3 }), 'a 3 b')
  assert.equal(helpers.interpolate('a {missing} b', {}), 'a {missing} b')
  assert.equal(helpers.fmtInterval(15000), '15s')
  assert.equal(helpers.fmtInterval(300000), '5min')
  assert.equal(helpers.shortSession('0123456789abcdef'), '89abcdef')
  assert.equal(helpers.shortSession('session-0a81b2c3'), '0a81b2c3')
  assert.equal(helpers.shortSession(null), '–')
  assert.equal(Array.from(helpers.statusOrder).join(','), 'todo,doing,done,archived')

  const groups = helpers.groupTasks([
    { id: 't-1', status: 'todo' },
    { id: 't-2', status: 'done' },
    { id: 't-3', status: 'nonsense' },
  ])
  assert.equal(groups.todo.map((task) => task.id).join(','), 't-1')
  assert.equal(groups.done.map((task) => task.id).join(','), 't-2')
  assert.equal(groups.doing.length, 0)

  const t0 = (key, params) => helpers.interpolate(helpers.DICT_ZH[key] || key, params)
  assert.equal(helpers.fmtAgo(t0, null), '')
  assert.equal(helpers.fmtAgo(t0, new Date(Date.now() - 1000).toISOString(), Date.now()), '刚刚')
  assert.equal(helpers.fmtAgo(t0, new Date(Date.now() - 5 * 60000).toISOString(), Date.now()), '5 分钟前')
  assert.equal(helpers.fmtAgo(t0, new Date(Date.now() - 3 * 3600000).toISOString(), Date.now()), '3 小时前')
})
