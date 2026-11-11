import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 在 vm 里跑 client bundle：stub window.__ModuleLoader__ 与 react，取回 factory 的导出。 */
function loadClient() {
  let captured = null
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
  }
  const sandbox = {
    window: fakeWindow,
    document: {
      querySelector: () => null,
      createElement: () => ({ setAttribute() {}, textContent: '' }),
      head: { appendChild() {} },
      documentElement: { appendChild() {} },
      visibilityState: 'visible',
    },
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
  return { exported, captured }
}

test('client bundle exposes apply/inject and only requires react', () => {
  const { exported, captured } = loadClient()
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual([...exported.inject], ['slots', 'connection', 'timer', 'locale'])
  assert.equal(captured.id, 'dsh-taskboard')
})

test('apply registers the sidebar icon and the main page', () => {
  const { exported } = loadClient()
  const registrations = []
  const injections = []
  const slots = {
    inject(name, factory) {
      injections.push(name)
      factory()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const fakeCtx = {
    get: (name) => {
      if (name === 'slots') return slots
      if (name === 'connection') return { rpc: { call: async () => ({ ok: true, value: {} }) } }
      if (name === 'locale') return null
      return undefined
    },
    effect: (fn) => {
      fn()
      return () => {}
    },
    interval: () => () => {},
    timeout: () => () => {},
  }
  exported.apply(fakeCtx)
  assert.deepEqual(injections, ['sidebar.panellist', 'main'])
  assert.equal(registrations.length, 2)
  assert.equal(registrations[0].options.name, 'sidebar.panellist')
  assert.equal(registrations[0].options.id, 'taskboard')
  assert.equal(typeof registrations[0].options.label, 'function')
  assert.equal(registrations[0].options.label(), '任务看板')
  assert.equal(registrations[1].options.name, 'main')
  assert.equal(registrations[1].options.key, 'taskboard')
})

test('apply survives a missing connection service', () => {
  const { exported } = loadClient()
  const slots = {
    inject: (_name, factory) => factory(),
    register: () => () => {},
  }
  const fakeCtx = {
    get: (name) => (name === 'slots' ? slots : undefined),
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
