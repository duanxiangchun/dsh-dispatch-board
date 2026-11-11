/**
 * dsh-taskboard —— 浏览器端 bundle（经 window.__ModuleLoader__ 加载）。
 *
 * 两处界面：
 *  1. sidebar.panellist —— 侧栏面板入口图标（原创看板 SVG + 待办数量角标）。
 *  2. main (key: taskboard) —— 完整看板页：待开始 / 进行中 / 已完成 / 已归档 四列，
 *     顶部新建任务、轮询状态与间隔、同步模式预设，底部展示 board.json 路径。
 *
 * 数据通道：Host 在 webServer 注册的 /taskboard 前缀路由，经 Connection RPC 信封调用
 * （snapshot / add-task / update-task / delete-task / dispatch-now / set-config /
 *   archive-done / install-preset）。契约见 docs/architecture.md。
 *
 * 呈现层：手写 <style> 幂等注入，颜色 / 字体 / 圆角 / 焦点环全部来自官方 --dsw-* 主题变量，
 * 亮暗主题自动成立。唯一硬编码色是四列状态强调色（可视化用途）。
 *
 * 约束：只 require('react')；禁止 require 任何 @deepseek-ai/* 包（会崩槽位）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-taskboard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef
    const useCallback = React.useCallback

    const BUNDLE_ID = 'dsh-taskboard'
    const RPC_CHANNEL = '/taskboard'
    const CSS_TAG_ID = BUNDLE_ID + '/client.css'
    const PLUGIN_VERSION = '0.1.0'
    const POLL_VISIBLE_MS = 2000
    const POLL_HIDDEN_MS = 10000
    const ICON_POLL_MS = 6000

    const STATUS_ORDER = ['todo', 'doing', 'done', 'archived']
    const STATUS_ACCENT = {
      todo: '#4f8ff7',
      doing: '#f0a24a',
      done: '#22b573',
      archived: '#98a2b3',
    }

    /* ══════════════════════════════════════════════════════════════
     * 样式（幂等注入；只引用 --dsw-* 主题变量）
     * ══════════════════════════════════════════════════════════════ */

    const CSS = [
      // ── 页面骨架 ───────────────────────────────────────────────
      '.tb-page{display:flex;flex-direction:column;gap:12px;height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:14px 18px 18px;width:100%;max-width:none;margin:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}',
      '.tb-page *{box-sizing:border-box}',
      '.tb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.tb-head-main{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.tb-title{margin:0;font:var(--dsw-font-s-14);font-size:18px;font-weight:600;letter-spacing:-.005em}',
      '.tb-sub{margin:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.tb-head-side{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
      '.tb-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:0 0 auto}',
      '.tb-dot[data-on=false]{background:var(--dsw-alias-label-tertiary)}',

      // ── 按钮 / 徽标 / 输入 ─────────────────────────────────────
      '.tb-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 11px;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font:var(--dsw-font-xxs-strong-12);font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .15s ease,border-color .15s ease,color .15s ease,opacity .15s ease}',
      '.tb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.tb-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.tb-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.tb-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.tb-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.tb-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.tb-btn-sm{height:24px;padding:0 8px;font:var(--dsw-font-xxxs-strong-11)}',
      '.tb-btn-ghost{border-color:transparent}',
      '.tb-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.tb-input,.tb-textarea{width:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:0 10px;font:var(--dsw-font-xs-13);outline:none}',
      '.tb-input{height:32px}',
      '.tb-textarea{height:56px;padding:7px 10px;resize:vertical;font:var(--dsw-font-xxs-12)}',
      '.tb-input:focus,.tb-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.tb-input::placeholder,.tb-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}',

      // ── 新建区 ─────────────────────────────────────────────────
      '.tb-composer{display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md)}',
      '.tb-composer-row{display:flex;align-items:center;gap:8px;min-width:0}',
      '.tb-composer-row .tb-input{flex:1 1 auto}',
      '.tb-composer-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.tb-select{height:28px;max-width:290px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:0 6px;font:var(--dsw-font-xxxs-11);outline:none}',
      '.tb-select:focus-visible{border-color:var(--dsw-alias-state-business-primary)}',
      '.tb-linkbtn{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:var(--dsw-alias-link);cursor:pointer;padding:0;font:inherit}',
      '.tb-linkbtn:hover{text-decoration:underline}',

      // ── 看板 ───────────────────────────────────────────────────
      '.tb-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:stretch;min-width:0;flex:1 1 auto;min-height:240px}',
      '.tb-col{display:flex;flex-direction:column;gap:8px;min-width:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:9px 9px 11px;min-height:220px;height:100%}',
      '.tb-col[data-status=archived]{opacity:.92}',
      '.tb-colhead{display:flex;align-items:center;gap:7px;padding:1px 1px 5px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.tb-coldot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--tb-accent)}',
      '.tb-colname{font:var(--dsw-font-xxs-strong-12);font-weight:600;letter-spacing:.01em}',
      '.tb-colcount{min-width:18px;height:18px;padding:0 5px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:color-mix(in srgb,var(--tb-accent) 16%,transparent);color:var(--tb-accent);font:var(--dsw-font-xxxs-strong-11);font-variant-numeric:tabular-nums}',
      '.tb-colhead-actions{margin-left:auto;display:flex;align-items:center;gap:4px}',
      '.tb-cards{display:flex;flex-direction:column;gap:8px;min-height:0}',
      '.tb-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:14px 10px;text-align:center;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);line-height:1.6}',

      // ── 卡片 ───────────────────────────────────────────────────
      '.tb-card{display:flex;flex-direction:column;gap:6px;padding:9px 10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--tb-accent);border-radius:var(--dsw-radius-sm);min-width:0}',
      '.tb-card-title{font:var(--dsw-font-xxs-strong-12);font-weight:600;line-height:1.45;word-break:break-word}',
      '.tb-card-note{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.tb-card-result{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-success-primary);line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.tb-card-error{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-error-primary);line-height:1.5;word-break:break-word}',
      '.tb-card-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.tb-card-tag{padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-strong-11)}',
      '.tb-card-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding-top:2px}',
      '.tb-edit{display:flex;flex-direction:column;gap:6px}',
      '.tb-edit-actions{display:flex;align-items:center;gap:6px;justify-content:flex-end}',

      // ── 页脚 / 提示 ────────────────────────────────────────────
      '.tb-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.tb-foot code{font:var(--dsw-font-xxxs-11);padding:1px 5px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton);word-break:break-all}',
      '.tb-banner{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:var(--dsw-radius-sm);font:var(--dsw-font-xxxs-11);line-height:1.55}',
      '.tb-banner[data-tone=error]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.tb-banner[data-tone=warn]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.tb-banner[data-tone=ok]{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}',
      '.tb-banner-close{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:2px 4px;border-radius:var(--dsw-radius-xs)}',
      '.tb-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',

      // ── 侧栏图标角标 ───────────────────────────────────────────
      '.tb-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;line-height:0}',
      '.tb-badge{position:absolute;top:-4px;right:-7px;min-width:14px;height:14px;padding:0 3px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font:var(--dsw-font-xxxs-strong-11);font-size:9px;line-height:1;font-variant-numeric:tabular-nums}',

      // ── 响应式 ─────────────────────────────────────────────────
      '@media (max-width:1200px){.tb-board{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (max-width:720px){.tb-page{padding:10px}.tb-board{grid-template-columns:minmax(0,1fr)}.tb-head{flex-direction:column}.tb-head-side{justify-content:flex-start}}',
    ].join('\n')

    function injectCss() {
      if (typeof document === 'undefined') return null
      const existing = document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]')
      if (existing) return existing
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', CSS_TAG_ID)
      tag.textContent = CSS
      ;(document.head || document.documentElement).appendChild(tag)
      return tag
    }

    /* ══════════════════════════════════════════════════════════════
     * i18n（locale 服务可用就注册字典，否则用内置中文）
     * ══════════════════════════════════════════════════════════════ */

    const DICT_ZH = {
      'panel.label': '任务看板',
      'page.title': '任务看板',
      'page.subtitle': '主 Agent 只派单、子 Agent 干活。待开始列会被自动轮询派发。',
      'page.refresh': '刷新',
      'page.refreshing': '刷新中…',
      'poll.on': '每 {interval} 轮询',
      'poll.off': '轮询已暂停',
      'poll.lastRun': '上次检查 {time}',
      'poll.never': '尚未检查',
      'poll.lastDispatch': '上次派发 {time} → {session}',
      'poll.pause': '暂停轮询',
      'poll.resume': '恢复轮询',
      'poll.interval': '间隔',
      'poll.skip.poll-disabled': '轮询已暂停',
      'poll.skip.agent-busy': '目标会话正在运行，稍后自动重试',
      'poll.skip.agent-offline': '任务指定的会话不在线',
      'poll.skip.no-live-agent': '没有在线的会话，打开一个会话即可派发',
      'poll.skip.no-agents-service': 'agents 服务不可用',
      'poll.skip.followup-failed': '投递消息失败',
      'composer.title': '添加任务',
      'composer.placeholder': '一句话说清要做什么，回车添加…',
      'composer.note': '补充备注（背景 / 范围 / 验收标准）',
      'composer.addNote': '加备注',
      'composer.hideNote': '收起备注',
      'composer.submit': '添加到待开始',
      'composer.target': '派发给',
      'composer.auto': '自动（最近活跃会话）',
      'composer.targetHint': '任务会轮询派发给这个会话的主 Agent；选「自动」则用最近活跃的空闲会话。',
      'composer.empty': '先写任务标题',
      'column.todo': '待开始',
      'column.doing': '进行中',
      'column.done': '已完成',
      'column.archived': '已归档',
      'column.empty.todo': '没有待开始的任务。加一条，主 Agent 会自动派发。',
      'column.empty.doing': '没有正在执行的任务。',
      'column.empty.done': '还没有完成的任务。',
      'column.empty.archived': '归档区是空的。',
      'column.dispatchAll': '全部派发',
      'column.archiveAll': '全部归档',
      'card.start': '开始',
      'card.dispatchNow': '立即派发',
      'card.complete': '完成',
      'card.reopen': '打回',
      'card.archive': '归档',
      'card.unarchive': '重新打开',
      'card.edit': '编辑',
      'card.delete': '删除',
      'card.save': '保存',
      'card.cancel': '取消',
      'card.deleteConfirm': '删除任务「{title}」？',
      'card.assignee': '执行者',
      'card.result': '结论',
      'card.notified': '已通知 {n} 次',
      'card.ago.now': '刚刚',
      'card.ago.min': '{n} 分钟前',
      'card.ago.hour': '{n} 小时前',
      'card.ago.day': '{n} 天前',
      'banner.presetMissing': '没有找到「派单看板模式」：{reason}',
      'banner.presetBroken': '派单看板模式加载失败：{reason}',
      'banner.error': '连接看板服务失败：{message}',
      'banner.retrying': '连接断开，正在重试…',
      'action.archived': '已归档 {n} 个任务',
      'action.dispatched': '已派发给会话 {session}',
      'footer.path': '数据文件',
      'footer.tip': '看板数据保存在本机，不随会话结束丢失。',
      'footer.version': 'v{version}',
      'badge.label': '{n} 个待开始任务',
      'error.bad-request': '请求不合法',
      'error.not-found': '任务不存在',
      'error.conflict': '{message}',
      'error.internal': '服务内部错误',
      'error.network': '网络错误',
    }

    const DICT_EN = {
      'panel.label': 'Task board',
      'page.title': 'Task board',
      'page.subtitle': 'The main agent dispatches, subagents do the work. Todo tasks are polled and dispatched automatically.',
      'page.refresh': 'Refresh',
      'page.refreshing': 'Refreshing…',
      'poll.on': 'Polling every {interval}',
      'poll.off': 'Polling paused',
      'poll.lastRun': 'Last check {time}',
      'poll.never': 'Not checked yet',
      'poll.lastDispatch': 'Last dispatch {time} → {session}',
      'poll.pause': 'Pause polling',
      'poll.resume': 'Resume polling',
      'poll.interval': 'Interval',
      'poll.skip.poll-disabled': 'Polling paused',
      'poll.skip.agent-busy': 'Target session is busy; retrying later',
      'poll.skip.agent-offline': 'The task session is offline',
      'poll.skip.no-live-agent': 'No live session; open a session to dispatch',
      'poll.skip.no-agents-service': 'agents service unavailable',
      'poll.skip.followup-failed': 'Failed to deliver the message',
      'composer.title': 'Add a task',
      'composer.placeholder': 'Describe the task in one line, press Enter…',
      'composer.note': 'Notes (background / scope / acceptance criteria)',
      'composer.addNote': 'Add notes',
      'composer.hideNote': 'Hide notes',
      'composer.submit': 'Add to todo',
      'composer.target': 'Dispatch to',
      'composer.auto': 'Auto (most recent session)',
      'composer.targetHint': 'The task is dispatched to this session main agent; Auto picks the most recently active idle session.',
      'composer.empty': 'Title is required',
      'column.todo': 'Todo',
      'column.doing': 'In progress',
      'column.done': 'Done',
      'column.archived': 'Archived',
      'column.empty.todo': 'No todo tasks. Add one and the main agent dispatches it automatically.',
      'column.empty.doing': 'Nothing in progress.',
      'column.empty.done': 'Nothing completed yet.',
      'column.empty.archived': 'Archive is empty.',
      'column.dispatchAll': 'Dispatch all',
      'column.archiveAll': 'Archive all',
      'card.start': 'Start',
      'card.dispatchNow': 'Dispatch now',
      'card.complete': 'Complete',
      'card.reopen': 'Send back',
      'card.archive': 'Archive',
      'card.unarchive': 'Reopen',
      'card.edit': 'Edit',
      'card.delete': 'Delete',
      'card.save': 'Save',
      'card.cancel': 'Cancel',
      'card.deleteConfirm': 'Delete task "{title}"?',
      'card.assignee': 'Assignee',
      'card.result': 'Result',
      'card.notified': 'Notified {n} times',
      'card.ago.now': 'just now',
      'card.ago.min': '{n} min ago',
      'card.ago.hour': '{n} h ago',
      'card.ago.day': '{n} d ago',
      'banner.presetMissing': 'Dispatcher mode not found: {reason}',
      'banner.presetBroken': 'Dispatcher mode failed to load: {reason}',
      'banner.error': 'Cannot reach the task board service: {message}',
      'banner.retrying': 'Connection lost, retrying…',
      'action.archived': 'Archived {n} tasks',
      'action.dispatched': 'Dispatched to session {session}',
      'footer.path': 'Data file',
      'footer.tip': 'Board data lives on this machine and survives session end.',
      'footer.version': 'v{version}',
      'badge.label': '{n} todo tasks',
      'error.bad-request': 'Invalid request',
      'error.not-found': 'Task not found',
      'error.conflict': '{message}',
      'error.internal': 'Internal error',
      'error.network': 'Network error',
    }

    function detectLang(locale) {
      try {
        if (locale && typeof locale.getLocale === 'function') {
          const active = locale.getLocale()
          const code = active && typeof active.active === 'string' ? active.active : ''
          return code.toLowerCase().startsWith('zh') ? 'zh' : 'en'
        }
      } catch (e) {
        /* fall through */
      }
      return 'zh'
    }

    function interpolate(text, params) {
      if (!params) return text
      return text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      )
    }

    function createTranslator(locale) {
      let lang = detectLang(locale)
      const dictOf = (code) => (code === 'zh' ? DICT_ZH : DICT_EN)
      return {
        t(key, params) {
          const dict = dictOf(lang)
          const fallback = dictOf('zh')
          const raw = Object.prototype.hasOwnProperty.call(dict, key)
            ? dict[key]
            : Object.prototype.hasOwnProperty.call(fallback, key)
              ? fallback[key]
              : key
          return interpolate(raw, params)
        },
        lang() {
          lang = detectLang(locale)
          return lang
        },
      }
    }

    function registerDictionaries(locale) {
      if (!locale || typeof locale.register !== 'function') return null
      try {
        locale.register('taskboard', 'zh', DICT_ZH)
        locale.register('taskboard', 'en', DICT_EN)
        return () => {
          try {
            if (typeof locale.unregister === 'function') locale.unregister('taskboard')
          } catch (e) {
            /* best-effort */
          }
        }
      } catch (e) {
        return null
      }
    }

    /* ══════════════════════════════════════════════════════════════
     * 纯函数小工具
     * ══════════════════════════════════════════════════════════════ */

    function fmtClock(iso, lang) {
      if (!iso) return ''
      const ms = Date.parse(iso)
      if (!Number.isFinite(ms)) return ''
      try {
        return new Date(ms).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      } catch (e) {
        return new Date(ms).toISOString().slice(11, 19)
      }
    }

    function fmtAgo(t, iso, now) {
      if (!iso) return ''
      const ms = Date.parse(iso)
      if (!Number.isFinite(ms)) return ''
      const diff = Math.max(0, (now || Date.now()) - ms)
      const minutes = Math.floor(diff / 60000)
      if (minutes < 1) return t('card.ago.now')
      if (minutes < 60) return t('card.ago.min', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('card.ago.hour', { n: hours })
      return t('card.ago.day', { n: Math.floor(hours / 24) })
    }

    function fmtInterval(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '–'
      if (ms % 1000 !== 0) return ms + 'ms'
      const seconds = ms / 1000
      if (seconds < 60) return seconds + 's'
      return Math.round(seconds / 60) + 'min'
    }

    // 会话 id 形如 session-xxxxxxxx…：取尾部更可区分（头部对每个会话都一样）。
    function shortSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return '–'
      return sessionId.length > 8 ? sessionId.slice(-8) : sessionId
    }

    function groupTasks(tasks) {
      const groups = { todo: [], doing: [], done: [], archived: [] }
      for (const task of Array.isArray(tasks) ? tasks : []) {
        if (!groups[task.status]) continue
        groups[task.status].push(task)
      }
      return groups
    }

    /** 模式 id → 展示名（来自 snapshot.preset.presets），查不到就返回空串。 */
    function presetNameOf(preset, presetId) {
      if (!preset || !presetId || !Array.isArray(preset.presets)) return ''
      const hit = preset.presets.find((item) => item && item.id === presetId)
      return hit && typeof hit.name === 'string' ? hit.name : ''
    }

    function errorText(t, error) {
      if (!error || typeof error !== 'object') return t('error.internal')
      const code = error.code || 'internal'
      if (code === 'conflict') return t('error.conflict', { message: error.message || '' })
      const known = 'error.' + code
      const text = t(known)
      return text === known ? error.message || t('error.internal') : text
    }

    /* ══════════════════════════════════════════════════════════════
     * 插件主体
     * ══════════════════════════════════════════════════════════════ */

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined || slots === null) return

      const connection = ctx.get('connection')

      let locale = null
      try {
        locale = ctx.get('locale')
      } catch (e) {
        locale = null
      }

      // 样式与 locale 字典是插件资源：在 ctx.effect 里注册，卸载时移除。
      const registerClientResources = () => {
        const styleTag = injectCss()
        const disposeDictionary = registerDictionaries(locale)
        return () => {
          try {
            if (styleTag && styleTag.parentNode) styleTag.parentNode.removeChild(styleTag)
          } catch (e) {
            /* style tag may already be detached */
          }
          if (typeof disposeDictionary === 'function') {
            try {
              disposeDictionary()
            } catch (e) {
              /* best-effort */
            }
          }
        }
      }
      let resourceEffectRegistered = false
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => registerClientResources(), 'dsh-taskboard: client resources')
          resourceEffectRegistered = true
        }
      } catch (e) {
        resourceEffectRegistered = false
      }
      if (!resourceEffectRegistered) {
        try {
          registerClientResources()
        } catch (e) {
          /* resources are best-effort; rendering must still work */
        }
      }

      const translator = createTranslator(locale)
      const t = (key, params) => translator.t(key, params)
      const lang = () => translator.lang()

      /** Connection RPC 调用：失败统一转成 {ok:false,error}，绝不 reject。 */
      function callRpc(endpoint, payload) {
        if (connection === undefined || connection === null || !connection.rpc || typeof connection.rpc.call !== 'function') {
          return Promise.resolve({ ok: false, error: { code: 'internal', message: 'connection service unavailable' } })
        }
        let pending
        try {
          const signal =
            typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
              ? AbortSignal.timeout(15000)
              : undefined
          pending = connection.rpc.call(RPC_CHANNEL, endpoint, payload || {}, signal)
        } catch (e) {
          return Promise.resolve({ ok: false, error: { code: 'internal', message: String((e && e.message) || e) } })
        }
        return Promise.resolve(pending).then(
          (result) => {
            if (result !== null && typeof result === 'object' && typeof result.ok === 'boolean') return result
            return { ok: false, error: { code: 'internal', message: 'malformed RPC response' } }
          },
          (error) => ({ ok: false, error: { code: 'network', message: String((error && error.message) || error) } }),
        )
      }

      /** 定时器：优先 ctx.interval，退化 window.setInterval。返回停止函数。 */
      function every(fn, ms) {
        try {
          if (ctx && typeof ctx.interval === 'function') {
            const dispose = ctx.interval(fn, ms)
            if (typeof dispose === 'function') return dispose
          }
        } catch (e) {
          /* fall through */
        }
        if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return () => {}
        const id = window.setInterval(fn, ms)
        return () => {
          window.clearInterval(id)
        }
      }

      function isDocVisible() {
        try {
          return typeof document === 'undefined' || document.visibilityState === 'visible'
        } catch (e) {
          return true
        }
      }

      /* ── 侧栏面板图标 ───────────────────────────────────────── */

      function PanelIcon(props) {
        const size = typeof props.size === 'number' && props.size > 0 ? props.size : 20
        const active = props.active === true
        const [pending, setPending] = useState(-1)

        useEffect(() => {
          let alive = true
          const read = () => {
            if (!isDocVisible()) return
            callRpc('snapshot', {}).then((res) => {
              if (!alive) return
              if (!res.ok || !res.value || !Array.isArray(res.value.tasks)) return
              let count = 0
              for (const task of res.value.tasks) if (task.status === 'todo') count += 1
              setPending(count)
            })
          }
          read()
          const stop = every(read, ICON_POLL_MS)
          return () => {
            alive = false
            stop()
          }
        }, [])

        const badge = pending > 0 ? (pending > 99 ? '99+' : String(pending)) : null

        return h(
          'span',
          {
            className: 'tb-icon',
            title: t('panel.label') + (pending > 0 ? ' · ' + t('badge.label', { n: pending }) : ''),
          },
          h(
            'svg',
            {
              width: size,
              height: size,
              viewBox: '0 0 20 20',
              fill: 'none',
              'aria-hidden': 'true',
              style: { color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
            },
            h('rect', {
              x: 2.4,
              y: 3.4,
              width: 15.2,
              height: 13.2,
              rx: 2.6,
              stroke: 'currentColor',
              strokeWidth: 1.3,
              opacity: 0.9,
            }),
            h('rect', { x: 4.7, y: 6.4, width: 2.7, height: 7.3, rx: 0.9, fill: 'currentColor' }),
            h('rect', { x: 8.6, y: 6.4, width: 2.7, height: 4.4, rx: 0.9, fill: 'currentColor', opacity: 0.68 }),
            h('rect', { x: 12.5, y: 6.4, width: 2.7, height: 6.1, rx: 0.9, fill: 'currentColor', opacity: 0.85 }),
          ),
          badge === null
            ? null
            : h('span', { className: 'tb-badge', 'aria-hidden': 'true' }, badge),
        )
      }

      /* ── 看板页 ─────────────────────────────────────────────── */

      function BoardPage() {
        const [snap, setSnap] = useState(null)
        const [error, setError] = useState(null)
        const [failures, setFailures] = useState(0)
        const [busy, setBusy] = useState('')
        const [notice, setNotice] = useState(null)
        const [now, setNow] = useState(Date.now())
        const [title, setTitle] = useState('')
        const [note, setNote] = useState('')
        const [showNote, setShowNote] = useState(false)
        const [target, setTarget] = useState('')
        const [editing, setEditing] = useState(null)
        const aliveRef = useRef(true)

        const refresh = useCallback(() => {
          return callRpc('snapshot', {}).then((res) => {
            if (!aliveRef.current) return res
            if (res.ok && res.value) {
              setSnap(res.value)
              setError(null)
              setFailures(0)
            } else {
              setError(res.error || { code: 'internal', message: 'no value' })
              setFailures((value) => value + 1)
            }
            return res
          })
        }, [])

        useEffect(() => {
          aliveRef.current = true
          refresh()
          return () => {
            aliveRef.current = false
          }
        }, [refresh])

        // 轮询：页面可见 2s，隐藏时跳过（回到可见会马上补一次）。
        useEffect(() => {
          let wasVisible = isDocVisible()
          const stop = every(() => {
            const visible = isDocVisible()
            if (!visible && wasVisible) {
              wasVisible = false
              return
            }
            wasVisible = visible
            if (!visible) return
            refresh()
          }, POLL_VISIBLE_MS)
          return () => stop()
        }, [refresh])

        // 相对时间每分钟重算一次。
        useEffect(() => {
          const stop = every(() => setNow(Date.now()), 30000)
          return () => stop()
        }, [])

        const config = (snap && snap.config) || { pollEnabled: true, pollIntervalMs: 15000 }
        const tasks = (snap && snap.tasks) || []
        const groups = groupTasks(tasks)
        const agents = (snap && snap.agents) || []
        const poll = (snap && snap.poll) || {}
        const preset = (snap && snap.preset) || null

        /** 统一执行一次写操作：忙态 + 错误提示 + 成功后刷新。 */
        const run = useCallback(
          async (key, call, successText) => {
            setBusy(key)
            try {
              const res = await call()
              if (!res.ok) {
                setNotice({ tone: 'error', text: errorText(t, res.error) })
                return null
              }
              setNotice(successText ? { tone: 'ok', text: successText } : null)
              await refresh()
              return res.value
            } finally {
              if (aliveRef.current) setBusy('')
            }
          },
          [refresh],
        )

        function submitTask() {
          const trimmedTitle = title.trim()
          if (trimmedTitle === '') {
            setNotice({ tone: 'warn', text: t('composer.empty') })
            return
          }
          const payload = { title: trimmedTitle }
          if (note.trim() !== '') payload.note = note.trim()
          if (target !== '') payload.sessionId = target
          run('add', () => callRpc('add-task', payload)).then((value) => {
            if (!value) return
            setTitle('')
            setNote('')
            setShowNote(false)
          })
        }

        function updateTask(id, patch, successText) {
          run('update:' + id, () => callRpc('update-task', Object.assign({ id }, patch)), successText)
        }

        function removeTask(task) {
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            if (!window.confirm(t('card.deleteConfirm', { title: task.title }))) return
          }
          run('delete:' + task.id, () => callRpc('delete-task', { id: task.id }))
        }

        function dispatchNow(task) {
          run('dispatch:' + task.id, () => callRpc('dispatch-now', { id: task.id })).then((value) => {
            if (!value) return
            if (value.dispatched) {
              setNotice({ tone: 'ok', text: t('action.dispatched', { session: shortSession(value.sessionId) }) })
            } else {
              const reason = (poll && poll.lastSkipReason) || value.reason || ''
              setNotice({ tone: 'warn', text: t('poll.skip.' + reason) === 'poll.skip.' + reason ? reason : t('poll.skip.' + reason) })
            }
          })
        }

        function setConfig(patch) {
          run('config', () => callRpc('set-config', patch))
        }

        function archiveDone() {
          run('archiveDone', () => callRpc('archive-done', {})).then((value) => {
            if (value && value.archived > 0) setNotice({ tone: 'ok', text: t('action.archived', { n: value.archived }) })
          })
        }

        function startEdit(task) {
          setEditing({ id: task.id, title: task.title, note: task.note || '' })
        }

        function saveEdit() {
          if (!editing) return
          const trimmedTitle = String(editing.title || '').trim()
          if (trimmedTitle === '') {
            setNotice({ tone: 'warn', text: t('composer.empty') })
            return
          }
          updateTask(editing.id, { title: trimmedTitle, note: String(editing.note || '').trim() })
          setEditing(null)
        }

        /* ── 子组件 ───────────────────────────────────────────── */

        function Banner(props) {
          if (!props.item || !props.item.text) return null
          return h(
            'div',
            { className: 'tb-banner', 'data-tone': props.item.tone || 'warn', role: props.item.tone === 'error' ? 'alert' : 'status' },
            h('span', null, props.item.text),
            props.onClose
              ? h('button', { type: 'button', className: 'tb-banner-close', onClick: props.onClose, 'aria-label': 'close' }, '\u00d7')
              : null,
          )
        }

        function Col(props) {
          const status = props.status
          const list = props.tasks
          return h(
            'section',
            { className: 'tb-col', 'data-status': status, 'aria-label': t('column.' + status) },
            h(
              'header',
              { className: 'tb-colhead', style: { '--tb-accent': STATUS_ACCENT[status] } },
              h('span', { className: 'tb-coldot', 'aria-hidden': 'true' }),
              h('span', { className: 'tb-colname' }, t('column.' + status)),
              h('span', { className: 'tb-colcount' }, String(list.length)),
              h(
                'div',
                { className: 'tb-colhead-actions' },
                status === 'todo' && list.length > 0
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'tb-btn tb-btn-sm tb-btn-ghost',
                        disabled: busy !== '',
                        onClick: () => {
                          const next = list.find((task) => task.status === 'todo')
                          if (next) dispatchNow(next)
                        },
                      },
                      t('column.dispatchAll'),
                    )
                  : null,
                status === 'done' && list.length > 0
                  ? h(
                      'button',
                      { type: 'button', className: 'tb-btn tb-btn-sm tb-btn-ghost', disabled: busy !== '', onClick: archiveDone },
                      t('column.archiveAll'),
                    )
                  : null,
              ),
            ),
            list.length === 0
              ? h('div', { className: 'tb-empty' }, t('column.empty.' + status))
              : h('div', { className: 'tb-cards' }, list.map((task) => h(Card, { key: task.id, task }))),
          )
        }

        function Card(props) {
          const task = props.task
          const status = task.status
          const isEditing = editing !== null && editing.id === task.id
          const busyKey = 'update:' + task.id

          if (isEditing) {
            return h(
              'article',
              { className: 'tb-card', style: { '--tb-accent': STATUS_ACCENT[status] } },
              h(
                'div',
                { className: 'tb-edit' },
                h('input', {
                  className: 'tb-input',
                  value: editing.title,
                  'aria-label': t('card.edit'),
                  onChange: (event) => setEditing(Object.assign({}, editing, { title: event.target.value })),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      saveEdit()
                    } else if (event.key === 'Escape') {
                      setEditing(null)
                    }
                  },
                }),
                h('textarea', {
                  className: 'tb-textarea',
                  value: editing.note,
                  placeholder: t('composer.note'),
                  onChange: (event) => setEditing(Object.assign({}, editing, { note: event.target.value })),
                }),
                h(
                  'div',
                  { className: 'tb-edit-actions' },
                  h('button', { type: 'button', className: 'tb-btn tb-btn-sm', onClick: () => setEditing(null) }, t('card.cancel')),
                  h('button', { type: 'button', className: 'tb-btn tb-btn-sm tb-btn-primary', disabled: busy !== '', onClick: saveEdit }, t('card.save')),
                ),
              ),
            )
          }

          const actions = []
          if (status === 'todo') {
            actions.push(['start', () => updateTask(task.id, { status: 'doing' }), true])
            actions.push(['dispatchNow', () => dispatchNow(task), false])
            actions.push(['edit', () => startEdit(task), false])
            actions.push(['delete', () => removeTask(task), false])
          } else if (status === 'doing') {
            actions.push(['complete', () => updateTask(task.id, { status: 'done' }), true])
            actions.push(['reopen', () => updateTask(task.id, { status: 'todo' }), false])
            actions.push(['edit', () => startEdit(task), false])
          } else if (status === 'done') {
            actions.push(['archive', () => updateTask(task.id, { status: 'archived' }), true])
            actions.push(['reopen', () => updateTask(task.id, { status: 'doing' }), false])
            actions.push(['edit', () => startEdit(task), false])
          } else {
            actions.push(['unarchive', () => updateTask(task.id, { status: 'todo' }), true])
            actions.push(['delete', () => removeTask(task), false])
          }

          const metaBits = [h('span', { key: 'id', className: 'tb-card-tag' }, task.id)]
          if (task.source === 'agent') metaBits.push(h('span', { key: 'src', className: 'tb-card-tag' }, 'agent'))
          metaBits.push(h('span', { key: 'time' }, fmtAgo(t, task.updatedAt, now)))
          if (task.notificationCount > 0 && status === 'todo') {
            metaBits.push(h('span', { key: 'notified' }, t('card.notified', { n: task.notificationCount })))
          }
          if (task.assignee) metaBits.push(h('span', { key: 'assignee' }, t('card.assignee') + ': ' + task.assignee))

          return h(
            'article',
            { className: 'tb-card', style: { '--tb-accent': STATUS_ACCENT[status] } },
            h('div', { className: 'tb-card-title' }, task.title),
            task.note
              ? h('div', { className: 'tb-card-note', title: task.note }, task.note)
              : null,
            task.result ? h('div', { className: 'tb-card-result', title: task.result }, t('card.result') + ': ' + task.result) : null,
            task.lastError ? h('div', { className: 'tb-card-error' }, task.lastError) : null,
            h('div', { className: 'tb-card-meta' }, metaBits),
            h(
              'div',
              { className: 'tb-card-actions' },
              actions.map((entry) =>
                h(
                  'button',
                  {
                    key: entry[0],
                    type: 'button',
                    className:
                      'tb-btn tb-btn-sm' +
                      (entry[2] ? ' tb-btn-primary' : '') +
                      (entry[0] === 'delete' ? ' tb-btn-danger tb-btn-ghost' : ''),
                    disabled: busy === busyKey || busy === 'dispatch:' + task.id || busy === 'delete:' + task.id,
                    onClick: entry[1],
                  },
                  t('card.' + entry[0]),
                ),
              ),
            ),
          )
        }

        /* ── 顶部状态文案 ─────────────────────────────────────── */

        const intervalText = fmtInterval(config.pollIntervalMs)
        const busyNow = busy !== ''
        const skipReason = poll.lastSkipReason || ''
        const skipKey = 'poll.skip.' + skipReason
        const skipText = skipReason === '' ? '' : t(skipKey) === skipKey ? skipReason : t(skipKey)

        const presetBanner = (() => {
          if (!preset) return null
          if (preset.broken) return { tone: 'error', text: t('banner.presetBroken', { reason: preset.broken }) }
          if (preset.installed === false) {
            return { tone: 'warn', text: t('banner.presetMissing', { reason: preset.reason || preset.path || '' }) }
          }
          return null
        })()

        return h(
          'div',
          { className: 'tb-page' },
          h(
            'header',
            { className: 'tb-head' },
            h(
              'div',
              { className: 'tb-head-main' },
              h('h1', { className: 'tb-title' }, t('page.title')),
              h('p', { className: 'tb-sub' },
                h('span', { className: 'tb-dot', 'data-on': config.pollEnabled ? 'true' : 'false', 'aria-hidden': 'true' }),
                h('span', null, config.pollEnabled ? t('poll.on', { interval: intervalText }) : t('poll.off')),
                h('span', null, '·'),
                h('span', null, poll.lastRunAt ? t('poll.lastRun', { time: fmtClock(poll.lastRunAt, lang()) }) : t('poll.never')),
                poll.lastDispatchAt
                  ? h('span', null, '· ' + t('poll.lastDispatch', {
                      time: fmtClock(poll.lastDispatchAt, lang()),
                      session: poll.lastDispatchSessionTitle || shortSession(poll.lastDispatchSessionId),
                    }))
                  : null,
                skipText ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '· ' + skipText) : null,
              ),
            ),
            h(
              'div',
              { className: 'tb-head-side' },
              h(
                'label',
                { className: 'tb-composer-meta', style: { gap: '5px' } },
                h('span', null, t('poll.interval')),
                h(
                  'select',
                  {
                    className: 'tb-select',
                    value: String(config.pollIntervalMs),
                    disabled: busyNow,
                    onChange: (event) => setConfig({ pollIntervalMs: Number(event.target.value) }),
                  },
                  [5000, 15000, 30000, 60000].map((ms) => h('option', { key: ms, value: String(ms) }, fmtInterval(ms))),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tb-btn',
                  disabled: busyNow,
                  onClick: () => setConfig({ pollEnabled: !config.pollEnabled }),
                },
                config.pollEnabled ? t('poll.pause') : t('poll.resume'),
              ),
              h(
                'button',
                { type: 'button', className: 'tb-btn', disabled: busyNow || busy === 'refresh', onClick: () => refresh() },
                busy === 'refresh' ? t('page.refreshing') : t('page.refresh'),
              ),
            ),
          ),

          presetBanner ? h(Banner, { item: presetBanner }) : null,
          notice ? h(Banner, { item: notice, onClose: () => setNotice(null) }) : null,
          failures > 0 && error
            ? h(Banner, {
                item: {
                  tone: 'error',
                  text: failures >= 5 ? t('banner.retrying') : t('banner.error', { message: errorText(t, error) }),
                },
              })
            : null,

          h(
            'div',
            { className: 'tb-composer' },
            h(
              'div',
              { className: 'tb-composer-row' },
              h('input', {
                className: 'tb-input',
                placeholder: t('composer.placeholder'),
                value: title,
                'aria-label': t('composer.title'),
                onChange: (event) => setTitle(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    submitTask()
                  } else if (event.key === 'Escape') {
                    setTitle('')
                  }
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tb-btn tb-btn-primary',
                  disabled: busyNow || title.trim() === '',
                  onClick: submitTask,
                },
                t('composer.submit'),
              ),
            ),
            showNote
              ? h('textarea', {
                  className: 'tb-textarea',
                  placeholder: t('composer.note'),
                  value: note,
                  onChange: (event) => setNote(event.target.value),
                })
              : null,
            h(
              'div',
              { className: 'tb-composer-meta' },
              h(
                'button',
                { type: 'button', className: 'tb-linkbtn', onClick: () => setShowNote(!showNote), 'aria-expanded': showNote ? 'true' : 'false' },
                showNote ? t('composer.hideNote') : t('composer.addNote'),
              ),
              h('span', null, t('composer.target')),
              h(
                'select',
                {
                  className: 'tb-select',
                  value: target,
                  'aria-label': t('composer.target'),
                  title: t('composer.targetHint'),
                  onChange: (event) => setTarget(event.target.value),
                },
                h('option', { value: '' }, t('composer.auto')),
                agents.map((agent) => {
                  const bits = [agent.title || shortSession(agent.sessionId)]
                  if (agent.status === 'running') bits.push('running')
                  const modeName = presetNameOf(preset, agent.preset)
                  if (modeName) bits.push(modeName)
                  return h('option', { key: agent.sessionId, value: agent.sessionId }, bits.join(' · '))
                }),
              ),
            ),
          ),

          h(
            'div',
            { className: 'tb-board' },
            STATUS_ORDER.map((status) => h(Col, { key: status, status, tasks: groups[status] })),
          ),

          h(
            'footer',
            { className: 'tb-foot' },
            h('span', null, t('footer.path') + ':'),
            h('code', null, (snap && snap.boardPath) || ''),
            h('span', null, '·'),
            h('span', null, t('footer.tip')),
            h('span', { style: { marginLeft: 'auto' } }, t('footer.version', { version: (snap && snap.pluginVersion) || PLUGIN_VERSION })),
          ),
        )
      }

      /* ── 槽位注册 ───────────────────────────────────────────── */

      slots.inject('sidebar.panellist', () =>
        slots.register(
          {
            name: 'sidebar.panellist',
            id: 'taskboard',
            order: 25,
            label: () => t('panel.label'),
          },
          PanelIcon,
        ),
      )

      slots.inject('main', () =>
        slots.register(
          {
            name: 'main',
            key: 'taskboard',
            label: () => t('panel.label'),
          },
          BoardPage,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection', 'timer', 'locale']

    /** 纯函数测试口（test/client-logic.test.mjs 用 node:vm 加载后断言）。 */
    exports.__test = {
      DICT_ZH,
      DICT_EN,
      interpolate,
      fmtAgo,
      fmtClock,
      fmtInterval,
      shortSession,
      groupTasks,
      statusAccent: STATUS_ACCENT,
      statusOrder: STATUS_ORDER,
    }

    return module.exports
  },
})
