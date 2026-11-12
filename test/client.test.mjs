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
  assert.equal(captured.id, 'dsh-dispatch-board')

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
  assert.equal(captured.id, 'dsh-dispatch-board')
})

test('apply 注册右栏 tab 类型 + 右栏三处入口 + 左侧栏平台看板', () => {
  const harness = createApplyHarness()

  // 1) 两个 cordis 注入点：tab 类型 + 右栏导航服务
  assert.deepEqual(harness.injectRequests, [['sidebarRightTabs'], ['uiWorkspace'], ['sidebarRight']])

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

  // 3) 槽位：右栏 tab 正文 + tab chip + 会话 header 入口 + 左侧栏平台看板
  const expectedSlots = [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'conversation.session.header.actions',
    'sidebar.panellist',
    'main',
  ]
  assert.deepEqual(harness.slotInjections, expectedSlots)
  assert.deepEqual(
    harness.registrations.map((entry) => entry.options.name),
    expectedSlots,
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

  // 左侧栏平台看板：入口图标（todo+doing 角标）+ main 页面，key/id 一致
  const platformIcon = harness.registrations[3]
  assert.equal(platformIcon.options.id, 'taskboard-platform')
  assert.equal(platformIcon.options.order, 25)
  assert.equal(typeof platformIcon.options.label, 'function')
  assert.equal(platformIcon.options.label(), '任务看板')
  assert.equal(platformIcon.options.locale, 'taskboard')
  assert.equal(typeof platformIcon.component, 'function')

  const platformPage = harness.registrations[4]
  assert.equal(platformPage.options.key, 'taskboard-platform')
  assert.equal(typeof platformPage.options.label, 'function')
  assert.equal(platformPage.options.label(), '任务看板')
  assert.equal(platformPage.options.locale, 'taskboard')
  assert.equal(typeof platformPage.component, 'function')
  // 平台看板的 slot key 与入口 icon 的 id 必须一致，点击图标才能切到页面
  assert.equal(platformPage.options.key, platformIcon.options.id)

  // 4) 插件资源：样式只注入一次；locale 字典 zh/en
  assert.equal(harness.styleTags.length, 1)
  assert.deepEqual(harness.localeRegistrations.map((entry) => entry.lang), ['zh', 'en'])
})

test('apply 在右侧栏服务缺失时安静降级（不崩、槽位照常注册）', () => {
  const harness = createApplyHarness({ sidebarRightTabs: false, sidebarRight: false })

  // 注入请求已被发起，但服务未就绪 → 回调不执行
  assert.deepEqual(harness.injectRequests, [['sidebarRightTabs'], ['uiWorkspace'], ['sidebarRight']])
  assert.equal(harness.scopeEffects.length, 0)
  assert.equal(harness.tabs.definitions.length, 0)
  assert.equal(harness.openTabCalls.length, 0)

  // 槽位与资源注册不受影响（右栏三处 + 左侧栏平台看板两处）
  assert.equal(harness.registrations.length, 5)
  assert.deepEqual(harness.slotInjections, [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'conversation.session.header.actions',
    'sidebar.panellist',
    'main',
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

test('v0.2.0 i18n：派发模式 / 组长条 / workspace-lead 三个 skip reason 中英齐全', () => {
  const { exported } = loadClient()
  const zh = exported.__test.DICT_ZH
  const en = exported.__test.DICT_EN

  // 模式选择器：值 'workspace-lead' 的文案必须是「工作区组长（推荐）」，旧三模式保留
  assert.equal(zh['dispatch.mode.workspace-lead'], '工作区组长（推荐）')
  assert.equal(en['dispatch.mode.workspace-lead'], 'Workspace lead (recommended)')
  for (const mode of ['workspace-lead', 'new', 'creator', 'auto']) {
    assert.equal(typeof zh['dispatch.mode.' + mode], 'string', 'missing zh dispatch mode: ' + mode)
    assert.equal(typeof en['dispatch.mode.' + mode], 'string', 'missing en dispatch mode: ' + mode)
  }

  // 组长条 / 主会话绑定 / 卡片详情的组长文案
  const keys = [
    'lead.barLabel',
    'lead.mainLabel',
    'lead.mainFallback',
    'lead.unbound',
    'lead.bind',
    'lead.rebind',
    'lead.clear',
    'lead.open',
    'lead.wsLabel',
    'lead.wsFallback',
    'lead.create',
    'lead.status.online',
    'lead.status.busy',
    'lead.status.offline',
    'lead.status.missing',
    'lead.noCurrentSession',
    'lead.bindOk',
    'lead.clearOk',
    'lead.ensureOk',
    'detail.lead',
    'detail.noLead',
    'poll.skip.lead-busy',
    'poll.skip.lead-unavailable',
    'poll.skip.lead-no-workspace',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', 'missing zh key: ' + key)
    assert.equal(typeof en[key], 'string', 'missing en key: ' + key)
    assert.notEqual(zh[key], '', 'empty zh value: ' + key)
    assert.notEqual(en[key], '', 'empty en value: ' + key)
  }

  // skip reason 文案与契约 §1.5 的表一致（宿主 lastError 文案同源）
  assert.equal(zh['poll.skip.lead-busy'], '工作区组长正在运行，等它空下来再派')
  assert.equal(zh['poll.skip.lead-unavailable'], '工作区组长不可用：稍后重试，或在看板点「创建组长」')
  assert.equal(zh['poll.skip.lead-no-workspace'], '无法解析任务的工作区：请从目标工作区的会话里重新加这条任务')
})

test('工作区路径纯函数：归一化 / 同路径比较 / 展示名 / 过滤', () => {
  const { exported } = loadClient()
  const helpers = exported.__test

  assert.equal(helpers.baseName('C:\\work\\demo'), 'demo')
  assert.equal(helpers.baseName('/home/u/demo/'), 'demo')
  assert.equal(helpers.baseName(''), '')
  assert.equal(helpers.normalizePath('C:/work/demo/'), 'C:\\work\\demo')
  assert.equal(helpers.normalizePath(''), '')

  // 反斜杠/斜杠、尾斜杠、Windows 盘符大小写都算同一个工作区
  assert.equal(helpers.samePath('C:\\work\\a', 'C:/work/a'), true)
  assert.equal(helpers.samePath('C:\\work\\a\\', 'C:\\work\\a'), true)
  assert.equal(helpers.samePath('C:\\Work\\A', 'c:\\work\\a'), true)
  assert.equal(helpers.samePath('C:\\work\\a', 'C:\\work\\b'), false)
  assert.equal(helpers.samePath('/home/u/a', '/home/u/a/'), true)
  assert.equal(helpers.samePath('', 'C:\\work\\a'), false)
  assert.equal(helpers.samePath(null, null), false)

  const workspaces = [
    { id: 'w1', path: 'C:\\work\\a', title: '工作区 A' },
    { id: 'w2', path: 'C:\\work\\b', title: '' },
  ]
  assert.equal(helpers.workspaceTitleOf(workspaces, 'C:/work/a/'), '工作区 A')
  assert.equal(helpers.workspaceTitleOf(workspaces, 'C:\\work\\b'), 'b') // title 为空 → 路径尾段
  assert.equal(helpers.workspaceTitleOf(workspaces, 'C:\\work\\missing'), 'missing')
  assert.equal(helpers.workspaceTitleOf(null, 'C:\\work\\a'), 'a')

  const tasks = [
    { id: 't-1', cwd: 'C:\\work\\a' },
    { id: 't-2', cwd: 'c:/work/a' },
    { id: 't-3', cwd: 'C:\\work\\b' },
    { id: 't-4', cwd: null },
  ]
  assert.deepEqual(helpers.tasksForWorkspace(tasks, 'C:\\work\\a').map((task) => task.id), ['t-1', 't-2'])
  assert.equal(helpers.tasksForWorkspace(tasks, '').length, 0, 'unknown workspace shows no tasks')
  assert.deepEqual(helpers.tasksForFilter(tasks, 'C:\\work\\b').map((task) => task.id), ['t-3'])
  assert.equal(helpers.tasksForFilter(tasks, '').length, 4)
})

test('v0.2.3：resolveWorkspaceSelection 恢复工作区过滤选择（有效 / 脏值 / 全部 / 未就绪）', () => {
  const { exported } = loadClient()
  const helpers = exported.__test
  const workspaces = [
    { id: 'w1', path: 'C:\\work\\a', title: '工作区 A' },
    { id: 'w2', path: 'C:\\work\\b', title: '' },
  ]

  // 字段缺失 / 空串 / 全空白 = 「全部工作区」（默认选择）
  assert.equal(helpers.resolveWorkspaceSelection(undefined, workspaces), '')
  assert.equal(helpers.resolveWorkspaceSelection(null, workspaces), '')
  assert.equal(helpers.resolveWorkspaceSelection('', workspaces), '')
  assert.equal(helpers.resolveWorkspaceSelection('   ', workspaces), '')

  // 有效值命中：斜杠 / 大小写归一化后返回注册表里的规范 path
  assert.equal(helpers.resolveWorkspaceSelection('C:\\work\\b', workspaces), 'C:\\work\\b')
  assert.equal(helpers.resolveWorkspaceSelection('c:/work/a/', workspaces), 'C:\\work\\a')

  // 脏值回退：工作区被删 / 改名 / 非字符串 → 「全部工作区」，不把无效值当选中项
  assert.equal(helpers.resolveWorkspaceSelection('C:\\work\\gone', workspaces), '')
  assert.equal(helpers.resolveWorkspaceSelection(42, workspaces), '')
  assert.equal(helpers.resolveWorkspaceSelection({ path: 'C:\\work\\a' }, workspaces), '')

  // 工作区列表为空（注册表还没就绪）→ null：等下一条 snapshot，别误判成「工作区已删除」
  assert.equal(helpers.resolveWorkspaceSelection('C:\\work\\b', []), null)
  assert.equal(helpers.resolveWorkspaceSelection('C:\\work\\b', null), null)
  // 「全部工作区」不依赖列表，立刻可判定
  assert.equal(helpers.resolveWorkspaceSelection('', []), '')
})

test('v0.2.4：taskWorkspaceLabel 优先工作区 title、回退目录名、空 cwd 用 — 占位', () => {
  const { exported } = loadClient()
  const helpers = exported.__test
  const workspaces = [
    { id: 'w1', path: 'C:\\work\\a', title: '工作区 A' },
    { id: 'w2', path: 'C:\\work\\b', title: '' },
  ]

  // 命中 snapshot.workspaces → 用工作区 title（斜杠 / 尾斜杠 / 大小写按 samePath 归一化）
  assert.equal(helpers.taskWorkspaceLabel(workspaces, { cwd: 'C:\\work\\a' }), '工作区 A')
  assert.equal(helpers.taskWorkspaceLabel(workspaces, { cwd: 'c:/work/a/' }), '工作区 A')

  // title 为空 / cwd 没注册到 snapshot.workspaces → 回退路径尾段（与下拉选项同一规则）
  assert.equal(helpers.taskWorkspaceLabel(workspaces, { cwd: 'C:\\work\\b' }), 'b')
  assert.equal(helpers.taskWorkspaceLabel(workspaces, { cwd: 'C:\\work\\ghost' }), 'ghost')
  assert.equal(helpers.taskWorkspaceLabel(null, { cwd: 'C:\\work\\ghost' }), 'ghost')

  // cwd 为空 / 非字符串 / 任务缺失 → 「—」占位：不抛错、不出现 undefined
  for (const task of [{ cwd: '' }, { cwd: null }, { cwd: 42 }, {}, null, undefined]) {
    const label = helpers.taskWorkspaceLabel(workspaces, task)
    assert.equal(label, helpers.workspaceLabelNone)
    assert.equal(label, '—', '空 cwd 用破折号占位')
    assert.ok(!String(label).includes('undefined'))
  }
})

test('v0.2.2 待你处理：needsUserTasks 排除归档、askedAt 最旧优先，withoutNeedsUser 去掉 flagged', () => {
  const { exported } = loadClient()
  const helpers = exported.__test
  const tasks = [
    { id: 't-1', status: 'todo', needsUser: true, askedAt: '2026-11-12T01:00:00.000Z' },
    { id: 't-2', status: 'doing', needsUser: true, askedAt: '2026-11-12T00:00:00.000Z' },
    { id: 't-3', status: 'archived', needsUser: true, askedAt: '2026-11-11T00:00:00.000Z' },
    { id: 't-4', status: 'todo', needsUser: false },
    { id: 't-5', status: 'done', needsUser: true },
    { id: 't-6', status: 'todo' },
  ]
  // 归档的 flagged 任务不出现在「待你处理」；缺 askedAt 的排最后
  assert.equal(helpers.needsUserTasks(tasks).map((task) => task.id).join(','), 't-2,t-1,t-5')
  // 普通四列 / lane 用：未归档的 flagged 去掉；已归档的 flagged 不在「待你处理」里，留归档列
  assert.equal(helpers.withoutNeedsUser(tasks).map((task) => task.id).join(','), 't-3,t-4,t-6')
  assert.deepEqual(Array.from(helpers.needsUserTasks(null)), [])
  assert.deepEqual(Array.from(helpers.needsUserTasks([])), [])
  assert.deepEqual(Array.from(helpers.withoutNeedsUser(null)), [])
})

test('v0.2.2 待你处理：i18n 文案中英齐全', () => {
  const { exported } = loadClient()
  const zh = exported.__test.DICT_ZH
  const en = exported.__test.DICT_EN

  assert.equal(zh['column.needsUser'], '待你处理')
  assert.equal(en['column.needsUser'], 'Needs you')
  const keys = [
    'column.needsUser',
    'needsUser.title',
    'needsUser.question',
    'needsUser.answerPlaceholder',
    'needsUser.submit',
    'needsUser.badge',
    'needsUser.open',
    'needsUser.lastAnswer',
    'needsUser.answerOk',
    'needsUser.answerFailed',
    'needsUser.answerEmpty',
    'needsUser.answerTooLong',
    'needsUser.pickOption',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', 'missing zh key: ' + key)
    assert.equal(typeof en[key], 'string', 'missing en key: ' + key)
    assert.notEqual(zh[key], '', 'empty zh value: ' + key)
    assert.notEqual(en[key], '', 'empty en value: ' + key)
  }
})

test('v0.2.2 待你处理：i18n 保持无 needsUser.empty 死键', () => {
  const { exported } = loadClient()
  for (const [lang, dict] of [
    ['zh', exported.__test.DICT_ZH],
    ['en', exported.__test.DICT_EN],
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(dict, 'needsUser.empty'),
      false,
      lang + ' 不应再有 needsUser.empty 死键',
    )
  }
  assert.equal(clientSource.includes('needsUser.empty'), false, '源码不得引用 needsUser.empty')
})

/* ══════════════════════════════════════════════════════════════
 * t-89：侧栏角标贴「任务看板」文字右上角
 * 宿主契约只给 { size, active }，位置靠「量宿主标签 rect」换算；真实几何在真机测，
 * 这里守纯函数：标签 rect → 相对 .tb-icon 的角标左上角、以及宿主标签节点识别。
 * ══════════════════════════════════════════════════════════════ */

test('t-89 labelBadgeAnchor：标签 rect 换算成相对 .tb-icon 的角标左上角（左缘回缩 1px、上缘上提 6px）', () => {
  const { exported } = loadClient()
  const { labelBadgeAnchor } = exported.__test
  // 真机 1280 展开态实测（rc.1 / rc.2 相对偏移一致）：icon(20,200,16x16) / label(42,197,56x22)
  assert.deepEqual({ ...labelBadgeAnchor({ left: 42, top: 197, right: 98, bottom: 219 }, { left: 20, top: 200 }) }, {
    left: 77,
    top: -9,
  })
  // 侧栏宽度 / 行高变化只改 rect，不改公式
  assert.deepEqual({ ...labelBadgeAnchor({ left: 100, top: 300, right: 160, bottom: 322 }, { left: 80, top: 304 }) }, {
    left: 79,
    top: -10,
  })
  // 亚像素四舍五入到 0.01px（避免 React 每次重渲染都写新 style）
  assert.deepEqual({ ...labelBadgeAnchor({ left: 42.333, top: 197.666, right: 98.777, bottom: 219 }, { left: 20.111, top: 200.4 }) }, {
    left: 77.67,
    top: -8.73,
  })
})

test('t-89 hostLabelNode：认出宿主行里的文字标签，折叠态（无标签）/ 结构异常返回 null', () => {
  const { exported } = loadClient()
  const { hostLabelNode } = exported.__test
  const icon = {}
  const glyph = { className: 'hHd-Xa_panelGlyph', textContent: '11', contains: (node) => node === icon }
  const title = { className: 'hHd-Xa_panelTitle hHd-Xa_wide', textContent: '任务看板', contains: () => false }

  // 展开态：图标在 panelGlyph 里，文字标签是同一按钮的另一个子节点
  assert.equal(hostLabelNode({ children: [glyph, title] }, icon), title)
  // 类名变了（宿主换构建哈希前缀）仍按「不含图标 + 有文字」兜底
  const plain = { className: '', textContent: '任务看板', contains: () => false }
  assert.equal(hostLabelNode({ children: [glyph, plain] }, icon), plain)
  // 折叠态：宿主不渲染标签，只剩图标 → null（CSS 退回图标右上角）
  assert.equal(hostLabelNode({ children: [glyph] }, icon), null)
  // 空文字 / 缺失节点 / 没有 children 都不抛错
  const empty = { className: 'x_panelTitle', textContent: '   ', contains: () => false }
  assert.equal(hostLabelNode({ children: [glyph, empty] }, icon), null)
  assert.equal(hostLabelNode(null, icon), null)
  assert.equal(hostLabelNode({ children: [title] }, null), null)
  assert.equal(hostLabelNode({}, icon), null)
})
