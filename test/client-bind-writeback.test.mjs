import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/* ══════════════════════════════════════════════════════════════
 * t-92 回归守卫：bind 回写字段在两份看板副本（对话侧 + 平台侧边栏）里都要有
 * 回答框是受控组件，草稿存在看板组件 state 里、经共享 bind 对象传给 Detail
 * 浮层；某份副本漏回写 → bind.answerDraft 永远 undefined → 每次按键被复位、
 * 选项不填入、「回复并继续」恒禁用。v0.2.5 拆分双看板时侧边栏漏抄过一次。
 * ══════════════════════════════════════════════════════════════ */

test('t-92 回归守卫：needsUserTasks / answerDraft / answerError 在两份看板副本的 bind 回写里各出现 ≥2 次', () => {
  const fields = [
    'boardBindRef.current.needsUserTasks',
    'boardBindRef.current.answerDraft',
    'boardBindRef.current.answerError',
  ]
  for (const field of fields) {
    const occurrences = clientSource.split(field).length - 1
    assert.ok(
      occurrences >= 2,
      `${field} 只出现 ${occurrences} 次（应 ≥2：对话侧 + 平台侧边栏各一份）。` +
        '某份看板副本漏回写，会导致回答框打不进字（t-92）',
    )
  }
})
