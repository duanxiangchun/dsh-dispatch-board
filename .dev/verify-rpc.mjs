#!/usr/bin/env node
/**
 * dsh-taskboard RPC 探针：对运行中的 dsh web 实例跑一遍 /taskboard 的全部端点。
 *
 * 用法：
 *   node .dev/verify-rpc.mjs http://127.0.0.1:3099
 *
 * 只做本机 HTTP 调用，不依赖 dsh 进程内的任何模块；退出码 0 = 全部通过。
 * 会写入/删除两条测试任务（id 前缀 t-，标题带 [probe]），跑完自动归档，不污染真实看板。
 */

const baseUrl = (process.argv[2] || 'http://127.0.0.1:3099').replace(/\/+$/, '')
const CHANNEL = '/taskboard'

let rpcId = 0
let failures = 0
let checks = 0

function check(name, condition, detail) {
  checks += 1
  if (condition) {
    console.log('  ok   ' + name)
    return true
  }
  failures += 1
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)))
  return false
}

async function call(method, payload = {}, options = {}) {
  const id = 'probe-' + ++rpcId
  const response = await fetch(baseUrl + CHANNEL + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }),
  })
  const status = response.status
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 也照原样报错 */
  }
  if (options.raw) return { status, text, json, rpcId: id }
  if (status !== 200) throw new Error(method + ': HTTP ' + status + ' ' + text.slice(0, 200))
  if (!json || json.type !== 'server-response' || json.rpcId !== id) {
    throw new Error(method + ': bad envelope ' + text.slice(0, 300))
  }
  if (json.result && json.result.ok === false && !options.allowError) {
    throw new Error(method + ': ' + JSON.stringify(json.result.error))
  }
  return { status, json, result: json.result, rpcId: id }
}

async function expectError(method, payload, code) {
  const { result } = await call(method, payload, { allowError: true })
  return check(method + ' → ' + code, !!result && result.ok === false && result.error && result.error.code === code, result && result.error)
}

async function main() {
  console.log('dsh-taskboard probe @ ' + baseUrl)
  // 探针会 add/delete 任务；轮询开着会把它们真的派发给主 Agent（幽灵任务）。
  // 先暂停轮询，跑完（或失败）再恢复原值。
  const initial = await call('snapshot')
  const restore = {
    pollEnabled: initial.result.value.config.pollEnabled,
    pollIntervalMs: initial.result.value.config.pollIntervalMs,
  }
  await call('set-config', { pollEnabled: false })
  try {
    await runChecks(initial)
  } finally {
    await call('set-config', restore).catch((error) => console.error('restore config failed: ' + error.message))
  }
}

async function runChecks(initial) {
  const snap = initial.result.value
  console.log('1) 传输层与信封')
  const nonPost = await fetch(baseUrl + CHANNEL + '/snapshot', { method: 'GET' })
  check('GET 被拒绝（405）', nonPost.status === 405, nonPost.status)

  const badType = await fetch(baseUrl + CHANNEL + '/snapshot', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'x',
  })
  check('非 JSON content-type 被拒绝（415）', badType.status === 415, badType.status)

  const badEnvelope = await call('snapshot', {}, { raw: true })
  check('合法信封返回 200', badEnvelope.status === 200)
  check('rpcId 原样回显', badEnvelope.json && badEnvelope.json.rpcId === badEnvelope.rpcId)

  const broken = await fetch(baseUrl + CHANNEL + '/snapshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  const brokenJson = await broken.json()
  check('坏信封返回 bad-request', brokenJson.result && brokenJson.result.error && brokenJson.result.error.code === 'bad-request', brokenJson)

  console.log('2) snapshot')
  check('version = 1', snap.version === 1)
  check('tasks 是数组', Array.isArray(snap.tasks))
  check('config.pollIntervalMs 在范围内', snap.config.pollIntervalMs >= 5000 && snap.config.pollIntervalMs <= 300000)
  check('poll 字段齐全', snap.poll && typeof snap.poll.running === 'boolean')
  check('agents 是数组', Array.isArray(snap.agents))
  check('preset 已安装', snap.preset && snap.preset.installed === true, snap.preset)
  check('两个模式都在名单里', Array.isArray(snap.preset.presets) && snap.preset.presets.length === 2, snap.preset.presets)
  check('两个模式都无 broken', snap.preset.presets.every((p) => !p.broken), snap.preset.presets)
  check('boardPath 指向 board.json', /board\.json$/.test(snap.boardPath))
  check('revision 是数字', typeof snap.revision === 'number')

  console.log('3) add-task / update-task / delete-task')
  const added = await call('add-task', { title: '[probe] RPC 验证任务', note: '由 .dev/verify-rpc.mjs 创建' })
  const task = added.result.value.task
  check('add-task 返回递增 id', !!task && /^t-\d+$/.test(task.id), task && task.id)
  check('新任务状态是 todo', task.status === 'todo')
  check('新任务 source=user', task.source === 'user')

  await expectError('add-task', { title: '   ' }, 'bad-request')
  await expectError('update-task', { id: 't-999999', status: 'doing' }, 'not-found')
  await expectError('update-task', { id: task.id, status: 'weird' }, 'bad-request')

  const doing = await call('update-task', { id: task.id, status: 'doing', assignee: 'probe-child' })
  check('todo → doing', doing.result.value.task.status === 'doing')
  check('assignee 写入', doing.result.value.task.assignee === 'probe-child')
  await expectError('update-task', { id: task.id, status: 'done-typo' }, 'bad-request')
  const done = await call('update-task', { id: task.id, status: 'done', result: 'probe ok' })
  check('doing → done', done.result.value.task.status === 'done')
  check('result 写入', done.result.value.task.result === 'probe ok')
  const archived = await call('update-task', { id: task.id, status: 'archived' })
  check('done → archived', archived.result.value.task.status === 'archived')

  console.log('4) dispatch-now')
  const probeTask = await call('add-task', { title: '[probe] dispatch-now 验证' })
  const dispatch = await call('dispatch-now', { id: probeTask.result.value.task.id }, { allowError: true })
  check('dispatch-now 返回结构化结果', dispatch.result.ok === true && typeof dispatch.result.value.dispatched === 'boolean', dispatch.result)
  // 没有在线会话/或会话忙碌都算正常（不派发），关键是不崩、结果可解释
  check('dispatched=false 时给出 reason', dispatch.result.value.dispatched === true || !!dispatch.result.value.reason, dispatch.result.value)
  await call('delete-task', { id: probeTask.result.value.task.id })

  console.log('5) set-config / archive-done / install-preset')
  const configured = await call('set-config', { pollEnabled: false, pollIntervalMs: 30000 })
  check('set-config 生效', configured.result.value.config.pollEnabled === false && configured.result.value.config.pollIntervalMs === 30000, configured.result.value.config)
  await call('set-config', { pollEnabled: snap.config.pollEnabled, pollIntervalMs: snap.config.pollIntervalMs })
  const archiveDone = await call('archive-done')
  check('archive-done 返回数量', Number.isInteger(archiveDone.result.value.archived))
  const preset = await call('install-preset')
  check('install-preset 兼容端点只刷新状态', preset.result.value && preset.result.value.action === 'none' && preset.result.value.installed === true, preset.result.value)

  console.log('6) session-info（冷会话工作区兜底）')
  const info = await call('session-info', { sessionId: 'session-not-a-real-id' })
  check('session-info 未知会话返回 cwd=null', info.result.ok && info.result.value.cwd === null)
  const infoEmpty = await call('session-info', {})
  check('session-info 空参数不崩', infoEmpty.result.ok && infoEmpty.result.value.cwd === null)

  console.log('7) 非法端点')
  await expectError('nope', {}, 'bad-request')

  console.log('')
  console.log((failures === 0 ? 'PASS' : 'FAIL') + '：' + (checks - failures) + '/' + checks + ' 项通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('probe crashed: ' + (error && error.message ? error.message : error))
  process.exit(1)
})