#!/usr/bin/env node
/**
 * dsh-taskboard RPC 探针：对运行中的 dsh web 实例跑一遍 /taskboard 的全部端点。
 *
 * 用法：
 *   node .dev/verify-rpc.mjs http://127.0.0.1:3099
 *
 * 只做本机 HTTP 调用，不依赖 dsh 进程内的任何模块；退出码 0 = 全部通过。
 * 会写入/删除两条测试任务（id 前缀 t-，标题带 [probe]），跑完自动归档，不污染真实看板。
 * v0.2.0 追加：snapshot 运行时视图（config / leads / pluginVersion）、主会话绑定往返、
 * ensure-workspace-lead、dispatchMode 往返、upload-attachment / attachment（粘贴图片附件）；
 * 跑完把主会话绑定与 config 恢复原值
 * （原先绑定的主会话若当前离线，恢复绑定后 `mainSessionTitle` 会是空串——RPC 无法直接写标题）。
 * 注意：ensure-workspace-lead 会为该 cwd 真实创建/复用一个工作区组长会话（可接受的测试副作用）。
 * 粘贴图片探针会上传一张 1x1 PNG 并留在附件索引里（没有删除端点），体积可忽略；介意可手动清理
 * `$DSH_HOME/storages/dsh-taskboard/attachments/`。
 */

import { randomUUID } from 'node:crypto'

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
  // v0.2.0 探针还会临时改主会话绑定与 dispatchMode：跑完（或失败）同样恢复原值。
  const initial = await call('snapshot')
  const initialConfig = initial.result.value.config
  const restore = {
    pollEnabled: initialConfig.pollEnabled,
    pollIntervalMs: initialConfig.pollIntervalMs,
    dispatchMode: initialConfig.dispatchMode,
  }
  const restoreMainSessionId =
    typeof initialConfig.mainSessionId === 'string' && initialConfig.mainSessionId !== '' ? initialConfig.mainSessionId : ''
  await call('set-config', { pollEnabled: false })
  try {
    await runChecks(initial)
  } finally {
    await call('set-config', restore).catch((error) => console.error('restore config failed: ' + error.message))
    const restoreMain = restoreMainSessionId
      ? call('bind-main-session', { sessionId: restoreMainSessionId })
      : call('clear-main-session')
    await restoreMain.catch((error) => console.error('restore main session failed: ' + error.message))
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

  console.log('8) snapshot v0.2.0 运行时视图')
  check('config.dispatchMode 合法', ['workspace-lead', 'new', 'creator', 'auto'].includes(snap.config.dispatchMode), snap.config.dispatchMode)
  check(
    'config.mainSessionId 是字符串或 null',
    snap.config.mainSessionId === null || typeof snap.config.mainSessionId === 'string',
    snap.config.mainSessionId,
  )
  check(
    'config.workspaceLeads 是普通对象',
    !!snap.config.workspaceLeads && typeof snap.config.workspaceLeads === 'object' && !Array.isArray(snap.config.workspaceLeads),
  )
  check(
    'leads.main 形状（null 或 MainSessionRef）',
    !!snap.leads &&
      (snap.leads.main === null ||
        (typeof snap.leads.main.sessionId === 'string' &&
          typeof snap.leads.main.title === 'string' &&
          typeof snap.leads.main.live === 'boolean' &&
          typeof snap.leads.main.busy === 'boolean')),
    snap.leads && snap.leads.main,
  )
  check('leads.workspaces 是数组', !!snap.leads && Array.isArray(snap.leads.workspaces), snap.leads && snap.leads.workspaces)
  check('顶层 pluginVersion 是版本号', typeof snap.pluginVersion === 'string' && /^\d+\.\d+\.\d+/.test(snap.pluginVersion), snap.pluginVersion)

  console.log('9) bind-main-session / clear-main-session')
  const probeMainSessionId = 'probe-main-' + Date.now()
  const bound = await call('bind-main-session', { sessionId: probeMainSessionId })
  const mainRef = bound.result.value.main
  check('bind-main-session 回显 main.sessionId', !!mainRef && mainRef.sessionId === probeMainSessionId, mainRef)
  check('未在线会话 live=false', !!mainRef && mainRef.live === false, mainRef && mainRef.live)
  const boundSnap = await call('snapshot')
  check(
    'snapshot.leads.main 命中绑定会话',
    !!boundSnap.result.value.leads.main && boundSnap.result.value.leads.main.sessionId === probeMainSessionId,
    boundSnap.result.value.leads.main,
  )
  await expectError('bind-main-session', { sessionId: '' }, 'bad-request')
  const cleared = await call('clear-main-session')
  check('clear-main-session 返回 ok:true', cleared.result.value.ok === true, cleared.result.value)
  const clearedSnap = await call('snapshot')
  check('clear 后 snapshot.leads.main = null', clearedSnap.result.value.leads.main === null, clearedSnap.result.value.leads.main)

  console.log('10) ensure-workspace-lead')
  const probeCwd = process.cwd()
  const lead = await call('ensure-workspace-lead', { cwd: probeCwd })
  const leadRef = lead.result.value.lead
  check('ensure-workspace-lead 返回非空 sessionId', !!leadRef && typeof leadRef.sessionId === 'string' && leadRef.sessionId !== '', leadRef)
  check(
    'LeadRef.key / cwd 非空',
    !!leadRef && typeof leadRef.key === 'string' && leadRef.key !== '' && typeof leadRef.cwd === 'string' && leadRef.cwd !== '',
    leadRef,
  )
  const leadSnap = await call('snapshot')
  check(
    'snapshot.leads.workspaces 含该组长',
    !!leadSnap.result.value.leads &&
      Array.isArray(leadSnap.result.value.leads.workspaces) &&
      leadSnap.result.value.leads.workspaces.some((row) => row && row.sessionId === leadRef.sessionId),
    leadSnap.result.value.leads && leadSnap.result.value.leads.workspaces,
  )
  await expectError('ensure-workspace-lead', { cwd: '' }, 'bad-request')

  console.log('11) set-config dispatchMode 往返')
  const modeNow = (await call('snapshot')).result.value.config.dispatchMode
  const modeRoundTrip = modeNow === 'workspace-lead' ? 'new' : 'workspace-lead'
  const modeChanged = await call('set-config', { dispatchMode: modeRoundTrip })
  check('set-config 切换 dispatchMode', modeChanged.result.value.config.dispatchMode === modeRoundTrip, modeChanged.result.value.config.dispatchMode)
  const modeRestored = await call('set-config', { dispatchMode: modeNow })
  check('set-config 恢复 dispatchMode', modeRestored.result.value.config.dispatchMode === modeNow, modeRestored.result.value.config.dispatchMode)

  console.log('12) upload-attachment / attachment（粘贴图片附件）')
  const probePng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lp3J8QAAAABJRU5ErkJggg=='
  const uploaded = await call('upload-attachment', { dataUrl: probePng, name: 'probe.png' })
  const attachment = uploaded.result.value
  check('upload-attachment 返回 UUID id', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(attachment.id), attachment)
  check('short ref = attachment://<id>', attachment.ref === 'attachment://' + attachment.id, attachment.ref)
  check(
    'mime 是四种允许格式之一',
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mime),
    attachment.mime,
  )
  const readBack = await call('attachment', { id: attachment.id })
  check(
    'attachment 返回 data URL',
    !!readBack.result.value && typeof readBack.result.value.dataUrl === 'string' && readBack.result.value.dataUrl.startsWith('data:image/'),
    readBack.result.value && String(readBack.result.value.dataUrl).slice(0, 40),
  )
  await expectError('upload-attachment', { dataUrl: 'data:text/plain;base64,aGVsbG8=' }, 'bad-request')
  await expectError('upload-attachment', { dataUrl: 'data:image/png;base64,AAAA' }, 'bad-request')
  await expectError('attachment', { id: '../../board.json' }, 'bad-request')
  await expectError('attachment', { id: randomUUID() }, 'not-found')
  const nineRefs = Array.from({ length: 9 }, () => '![image](attachment://' + randomUUID() + ')').join('\n')
  await expectError('add-task', { title: '[probe] 附件上限', note: nineRefs }, 'bad-request')

  console.log('')
  console.log((failures === 0 ? 'PASS' : 'FAIL') + '：' + (checks - failures) + '/' + checks + ' 项通过')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('probe crashed: ' + (error && error.message ? error.message : error))
  process.exit(1)
})