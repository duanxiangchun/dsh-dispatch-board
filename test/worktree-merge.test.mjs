import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TASK_MERGE_WORKTREE_OUTPUT_SCHEMA,
  addTask,
  clearGitRepoInfoCache,
  createEmptyBoard,
  ensureTaskWorktree,
  mergeAndCleanupTaskWorktree,
  resolveGitRepoInfo,
} from '../lib/index.js'

/* ------------------------------------------------------------------ *
 * v0.5.11：隔离工作树合入 = 逐文件三方合并
 *   事故回归：旧实现用 `git diff` + 按文件 `git apply` 合入，两次误删主工作区未提交文件。
 *   这组用例锁死新语义：绝不覆盖 / 删除主工作区未提交文件，冲突时主工作区逐字节不变。
 * ------------------------------------------------------------------ */

const MERGE_KEYS = [
  'branch',
  'cleaned',
  'conflict',
  'conflictFiles',
  'id',
  'merged',
  'noChanges',
  'summary',
  'worktreePath',
]

/** 契约：9 个字段不变、类型不变（与 TASK_MERGE_WORKTREE_OUTPUT_SCHEMA 对齐）。 */
function assertMergeShape(result) {
  assert.deepEqual(Object.keys(result).sort(), MERGE_KEYS, '工具输出必须仍是 9 个契约字段')
  const required = TASK_MERGE_WORKTREE_OUTPUT_SCHEMA.required
  for (const key of required) assert.ok(key in result, '缺少契约字段 ' + key)
  assert.equal(typeof result.id, 'string')
  assert.equal(typeof result.merged, 'boolean')
  assert.equal(typeof result.noChanges, 'boolean')
  assert.equal(typeof result.conflict, 'boolean')
  assert.equal(typeof result.cleaned, 'boolean')
  assert.equal(typeof result.branch, 'string')
  assert.equal(typeof result.worktreePath, 'string')
  assert.equal(typeof result.summary, 'string')
  assert.ok(Array.isArray(result.conflictFiles))
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    encoding: 'utf8',
  }).trim()
}

function initRepo(repoDir) {
  mkdirSync(join(repoDir, 'src'), { recursive: true })
  mkdirSync(join(repoDir, 'node_modules', 'demo-dep'), { recursive: true })
  writeFileSync(join(repoDir, 'node_modules', 'demo-dep', 'index.js'), 'export const dep = 42\n')
  writeFileSync(join(repoDir, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(repoDir, 'src', 'a.js'), 'export const a = 1\n')
  writeFileSync(join(repoDir, 'src', 'b.js'), 'export const b = 1\n')
  writeFileSync(join(repoDir, 'src', 'shared.js'), 'line1\nline2\nline3\nline4\nline5\nline6\n')
  git(repoDir, ['init'])
  git(repoDir, ['config', 'user.name', 'test'])
  git(repoDir, ['config', 'user.email', 'test@local'])
  git(repoDir, ['add', '.gitignore', 'src'])
  git(repoDir, ['commit', '-m', 'initial commit'])
}

/** 与宿主 apply() 里同构的最小 runtime（只用到 state / filePath）。 */
function makeFixture(prefix) {
  clearGitRepoInfoCache()
  const root = mkdtempSync(join(tmpdir(), prefix))
  const repoDir = join(root, 'repo')
  const storageDir = join(root, 'storage')
  mkdirSync(storageDir, { recursive: true })
  initRepo(repoDir)
  const filePath = join(storageDir, 'board.json')
  const state = createEmptyBoard()
  const task = addTask(state, { title: '逐文件三方合并测试卡', cwd: repoDir, source: 'agent' }, Date.now())
  const rt = {
    ctx: { get: () => undefined },
    state,
    filePath,
    poll: {},
    reviveFailures: new Map(),
    flushingReceipts: false,
  }
  const repoInfo = resolveGitRepoInfo(repoDir, { fresh: true })
  const wt = ensureTaskWorktree(rt, task, repoInfo)
  assert.ok(wt && wt.worktreePath, '隔离工作树必须创建成功')
  return { root, repoDir, storageDir, filePath, task, rt, wtPath: wt.worktreePath }
}

function readBoardTask(filePath, taskId) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'))
  return (raw.tasks || []).find((item) => item && item.id === taskId)
}

test('v0.5.11 三方合并：主工作区无关未提交改动与未跟踪文件逐字节不变', () => {
  const fx = makeFixture('dsh-taskboard-v0511-unrelated-')
  try {
    const userWip = 'line1\nUSER_WIP_LINE\nline3\nline4\nline5\nline6\n'
    const untracked = 'user notes, keep me byte for byte\n'
    writeFileSync(join(fx.repoDir, 'src', 'shared.js'), userWip)
    writeFileSync(join(fx.repoDir, 'notes.txt'), untracked)
    // worker 只改 src/a.js（与主工作区在途改动无关）
    writeFileSync(join(fx.wtPath, 'src', 'a.js'), 'export const a = 100\n')

    const result = mergeAndCleanupTaskWorktree(fx.rt, fx.task.id)
    assertMergeShape(result)
    assert.equal(result.merged, true)
    assert.equal(result.conflict, false)
    assert.equal(result.cleaned, true)
    assert.deepEqual(result.conflictFiles, [])
    assert.equal(readFileSync(join(fx.repoDir, 'src', 'a.js'), 'utf8'), 'export const a = 100\n')
    assert.equal(readFileSync(join(fx.repoDir, 'src', 'shared.js'), 'utf8'), userWip, '无关的未提交改动必须逐字节不变')
    assert.equal(readFileSync(join(fx.repoDir, 'notes.txt'), 'utf8'), untracked, '未跟踪文件必须逐字节不变')
    assert.equal(existsSync(fx.wtPath), false, '成功后回收临时工作树')
    assert.equal(fx.task.worktreePath, null)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('v0.5.11 三方合并：同一文件不重叠改动 → 两处改动都保留', () => {
  const fx = makeFixture('dsh-taskboard-v0511-nonoverlap-')
  try {
    // 主工作区改第 1 行（用户 WIP），worker 改第 6 行（不重叠）
    writeFileSync(join(fx.repoDir, 'src', 'shared.js'), 'MAIN_TOP\nline2\nline3\nline4\nline5\nline6\n')
    writeFileSync(join(fx.wtPath, 'src', 'shared.js'), 'line1\nline2\nline3\nline4\nline5\nWORKER_BOTTOM\n')

    const result = mergeAndCleanupTaskWorktree(fx.rt, fx.task.id)
    assertMergeShape(result)
    assert.equal(result.merged, true)
    assert.equal(result.conflict, false)
    const merged = readFileSync(join(fx.repoDir, 'src', 'shared.js'), 'utf8')
    assert.match(merged, /MAIN_TOP/, '主工作区在途改动必须保留')
    assert.match(merged, /WORKER_BOTTOM/, 'worker 改动必须合入')
    assert.doesNotMatch(merged, /<<<<<<</, '成功路径不得写冲突标记')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('v0.5.11 三方合并：同一文件改动重叠 → conflict、主工作区逐字节不变、工作树保留', () => {
  const fx = makeFixture('dsh-taskboard-v0511-overlap-')
  try {
    const mainContent = 'export const b = "MAIN_CONFLICT"\n'
    writeFileSync(join(fx.repoDir, 'src', 'b.js'), mainContent)
    writeFileSync(join(fx.wtPath, 'src', 'b.js'), 'export const b = "WORKER_CONFLICT"\n')

    const result = mergeAndCleanupTaskWorktree(fx.rt, fx.task.id)
    assertMergeShape(result)
    assert.equal(result.merged, false)
    assert.equal(result.conflict, true)
    assert.equal(result.cleaned, false)
    assert.ok(result.conflictFiles.includes('src/b.js'), '冲突文件应包含 src/b.js：' + result.conflictFiles.join(','))
    assert.match(result.summary, /主工作区未被修改/)
    assert.match(result.summary, /src\/b\.js/)
    assert.equal(readFileSync(join(fx.repoDir, 'src', 'b.js'), 'utf8'), mainContent, '冲突时主工作区逐字节不变')
    assert.ok(existsSync(fx.wtPath), '冲突时保留隔离工作树供人工处理')
    assert.equal(result.worktreePath, fx.wtPath)
    assert.ok(fx.task.worktreePath, '任务仍保留 worktreePath')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('v0.5.11 三方合并（误删回归）：worker 删除文件而主工作区该文件有未提交改动 → 不删除、conflict', () => {
  const fx = makeFixture('dsh-taskboard-v0511-delete-dirty-')
  try {
    const userWip = 'export const a = "USER_WIP_DO_NOT_DELETE"\n'
    writeFileSync(join(fx.repoDir, 'src', 'a.js'), userWip)
    unlinkSync(join(fx.wtPath, 'src', 'a.js'))

    const result = mergeAndCleanupTaskWorktree(fx.rt, fx.task.id)
    assertMergeShape(result)
    assert.equal(result.merged, false)
    assert.equal(result.conflict, true)
    assert.ok(result.conflictFiles.includes('src/a.js'), '冲突文件应包含 src/a.js：' + result.conflictFiles.join(','))
    assert.equal(
      readFileSync(join(fx.repoDir, 'src', 'a.js'), 'utf8'),
      userWip,
      'worker 删除绝不能落到主工作区未提交文件上（误删回归）',
    )
    assert.ok(existsSync(fx.wtPath), '冲突时保留隔离工作树')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('v0.5.11 三方合并：worker 新增文件而主工作区已有同路径未跟踪文件 → 不覆盖、conflict', () => {
  const fx = makeFixture('dsh-taskboard-v0511-add-collide-')
  try {
    const userUntracked = 'user local scratch file\n'
    writeFileSync(join(fx.repoDir, 'src', 'new-file.js'), userUntracked)
    writeFileSync(join(fx.wtPath, 'src', 'new-file.js'), 'export const brandNew = true\n')

    const result = mergeAndCleanupTaskWorktree(fx.rt, fx.task.id)
    assertMergeShape(result)
    assert.equal(result.merged, false)
    assert.equal(result.conflict, true)
    assert.ok(result.conflictFiles.includes('src/new-file.js'), '冲突文件应包含 src/new-file.js')
    assert.equal(
      readFileSync(join(fx.repoDir, 'src', 'new-file.js'), 'utf8'),
      userUntracked,
      '主工作区同路径未跟踪文件绝不被覆盖',
    )
    assert.ok(existsSync(fx.wtPath), '冲突时保留隔离工作树')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('v0.5.11 三方合并：worker 在全新目录下新增文件 → 自动补建父目录、合入成功并回收工作树', () => {
  const fx = makeFixture('dsh-taskboard-v0511-add-newdir-')
  try {
    mkdirSync(join(fx.wtPath, 'src', 'newdir'), { recursive: true })
    writeFileSync(join(fx.wtPath, 'src', 'newdir', 'deep.js'), 'export const deep = true\n')
    assert.equal(existsSync(join(fx.repoDir, 'src', 'newdir')), false, '主工作区此时没有这个目录')

    const result = mergeAndCleanupTaskWorktree(fx.rt, fx.task.id)
    assertMergeShape(result)
    assert.equal(result.merged, true, '新目录下的新增文件不应被误判冲突：' + result.summary)
    assert.equal(result.conflict, false)
    assert.equal(result.cleaned, true)
    assert.equal(
      readFileSync(join(fx.repoDir, 'src', 'newdir', 'deep.js'), 'utf8'),
      'export const deep = true\n',
      '新增文件内容必须原样落盘',
    )
    assert.equal(existsSync(fx.wtPath), false, '成功后回收临时工作树')
    assert.equal(fx.task.worktreePath, null)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('v0.5.12 部分合入：一个文件干净 + 一个文件冲突 → 先合入干净文件，冲突文件保持原样、工作树保留', () => {
  const fx = makeFixture('dsh-taskboard-v0512-partial-apply-')
  try {
    const mainConflict = 'export const b = "MAIN_CONFLICT"\n'
    writeFileSync(join(fx.repoDir, 'src', 'b.js'), mainConflict)
    writeFileSync(join(fx.wtPath, 'src', 'a.js'), 'export const a = 200\n')
    writeFileSync(join(fx.wtPath, 'src', 'b.js'), 'export const b = "WORKER_CONFLICT"\n')

    const result = mergeAndCleanupTaskWorktree(fx.rt, fx.task.id)
    assertMergeShape(result)
    assert.equal(result.merged, false)
    assert.equal(result.conflict, true, '有冲突文件时仍是 conflict:true')
    assert.equal(result.cleaned, false, '冲突路径绝不 cleanup')
    assert.ok(result.conflictFiles.includes('src/b.js'), '冲突文件应包含 src/b.js：' + result.conflictFiles.join(','))
    assert.equal(
      readFileSync(join(fx.repoDir, 'src', 'a.js'), 'utf8'),
      'export const a = 200\n',
      '无冲突文件必须先合入（不再整段放弃）',
    )
    assert.equal(readFileSync(join(fx.repoDir, 'src', 'b.js'), 'utf8'), mainConflict, '冲突文件在主工作区保持原样')
    assert.ok(existsSync(fx.wtPath), '冲突时保留隔离工作树供组长处理')
    assert.equal(result.worktreePath, fx.wtPath)
    assert.match(result.summary, /已合入 1 个无冲突文件/, '摘要要说清已合入几个无冲突文件：' + result.summary)
    assert.match(result.summary, /冲突需组长处理/, '摘要要提示组长介入处理冲突文件')
    assert.match(result.summary, /src\/b\.js/)
    assert.doesNotMatch(result.summary, /主工作区未被修改/, '已经写过文件，不能再声称主工作区未被修改')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('v0.5.12 部分合入：组长处理冲突文件后重跑 → 全部已存在、合入成功并回收工作树', () => {
  const fx = makeFixture('dsh-taskboard-v0512-retry-after-resolve-')
  try {
    const workerB = 'export const b = "WORKER_CONFLICT"\n'
    writeFileSync(join(fx.repoDir, 'src', 'b.js'), 'export const b = "MAIN_CONFLICT"\n')
    writeFileSync(join(fx.wtPath, 'src', 'a.js'), 'export const a = 200\n')
    writeFileSync(join(fx.wtPath, 'src', 'b.js'), workerB)

    const first = mergeAndCleanupTaskWorktree(fx.rt, fx.task.id)
    assert.equal(first.conflict, true)
    assert.equal(first.cleaned, false)
    assert.ok(existsSync(fx.wtPath))

    // 组长手工解冲突：把主工作区冲突文件改成工作树版本（等价于人工采纳 worker 改动）
    writeFileSync(join(fx.repoDir, 'src', 'b.js'), workerB)

    const second = mergeAndCleanupTaskWorktree(fx.rt, fx.task.id)
    assertMergeShape(second)
    assert.equal(second.merged, true, '冲突处理完重跑应当成功：' + second.summary)
    assert.equal(second.conflict, false)
    assert.equal(second.cleaned, true)
    assert.deepEqual(second.conflictFiles, [])
    assert.equal(second.worktreePath, '')
    assert.equal(readFileSync(join(fx.repoDir, 'src', 'a.js'), 'utf8'), 'export const a = 200\n')
    assert.equal(readFileSync(join(fx.repoDir, 'src', 'b.js'), 'utf8'), workerB)
    assert.equal(existsSync(fx.wtPath), false, '成功后回收临时工作树')
    assert.equal(fx.task.worktreePath, null)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('v0.5.11 三方合并：成功后回收工作树并清空 board 字段（worktreePath/branch/base/links）', () => {
  const fx = makeFixture('dsh-taskboard-v0511-cleanup-')
  try {
    writeFileSync(join(fx.wtPath, 'src', 'a.js'), 'export const a = 321\n')
    const result = mergeAndCleanupTaskWorktree(fx.rt, fx.task.id)
    assertMergeShape(result)
    assert.equal(result.merged, true)
    assert.equal(result.cleaned, true)
    assert.equal(result.worktreePath, '')
    assert.equal(readFileSync(join(fx.repoDir, 'src', 'a.js'), 'utf8'), 'export const a = 321\n')
    assert.equal(existsSync(fx.wtPath), false, '临时工作树目录已删除')

    const persisted = readBoardTask(fx.filePath, fx.task.id)
    assert.ok(persisted, 'board.json 必须落盘该任务')
    assert.equal(persisted.worktreePath, null)
    assert.equal(persisted.worktreeBranch, null)
    assert.equal(persisted.worktreeBaseCommit, null)
    assert.deepEqual(persisted.worktreeLinks, [])
    assert.equal(git(fx.repoDir, ['branch', '--list', 'taskboard/' + fx.task.id]), '', '临时分支已删除')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('v0.5.11 三方合并：worker 删除干净的已跟踪文件 → 正常删除（新语义不放宽成一律冲突）', () => {
  const fx = makeFixture('dsh-taskboard-v0511-delete-clean-')
  try {
    unlinkSync(join(fx.wtPath, 'src', 'a.js'))
    const result = mergeAndCleanupTaskWorktree(fx.rt, fx.task.id)
    assertMergeShape(result)
    assert.equal(result.merged, true)
    assert.equal(result.conflict, false)
    assert.equal(existsSync(join(fx.repoDir, 'src', 'a.js')), false, '干净的已跟踪文件按 worker 意图删除')
    assert.equal(readFileSync(join(fx.repoDir, 'src', 'b.js'), 'utf8'), 'export const b = 1\n', '其它文件不动')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
})
