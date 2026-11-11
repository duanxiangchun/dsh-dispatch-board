/**
 * dsh-taskboard —— 浏览器端 bundle（经 window.__ModuleLoader__ 加载）。
 *
 * 两块看板：
 *  1. 右侧栏「本工作区看板」—— sidebarRightTabs 注册 kind=taskboard 的页类型，
 *     sidebar.right.pane.tab / .title 提供正文与 chip，conversation.session.header.actions
 *     提供会话 header 入口按钮；只显示 cwd 与当前会话工作区相同的任务（窄栏 lane / 宽栏四列）。
 *  2. 左侧栏「平台任务看板」—— sidebar.panellist 入口图标（todo+doing 角标）+ main
 *     (key: taskboard-platform) 页面；显示全部工作区的任务、每卡带工作区 tag，
 *     新建任务必须选工作区（add-task 传 cwd，不传 sessionId）。
 *
 * 数据通道：Host 在 webServer 注册的 /taskboard 前缀路由，经 Connection RPC 信封调用
 * （snapshot / session-info / add-task / update-task / delete-task / dispatch-now /
 *   set-config / archive-done / install-preset）。snapshot 带 tasks / agents / workspaces。
 * 契约见 docs/architecture.md。
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

    // 右侧栏 tab 类型的身份：tab 系统里唯一（用包名），kind 是 openTab() 的参数。
    const TAB_TYPE_ID = 'dsh-taskboard'
    const TAB_KIND = 'taskboard'

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

      // ── 会话 header 入口按钮 / 右栏 tab chip ───────────────────
      '.tb-headbtn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:0}',
      '.tb-headbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.tb-headbtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.tb-badge{position:absolute;top:-3px;right:-5px;min-width:14px;height:14px;padding:0 3px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font:var(--dsw-font-xxxs-strong-11);font-size:9px;line-height:1;font-variant-numeric:tabular-nums}',
      '.tb-tabtitle{display:inline-flex;align-items:center;gap:5px;min-width:0}',

      // ── 右栏窄面板：lane 纵向堆叠 ──────────────────────────────
      '.tb-lanes{display:flex;flex-direction:column;gap:10px;min-height:0;flex:1 1 auto}',
      '.tb-page{position:relative}',
      '.tb-card-titlebtn{cursor:pointer}',
      '.tb-card-titlebtn:hover{text-decoration:underline}',
      // ── 任务详情浮层 ─────────────────────────────────────────
      '.tb-detail-mask{position:fixed;inset:0;z-index:9000;background:rgba(8,12,20,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto;animation:tb-fade-in .12s ease-out}',
      '@keyframes tb-fade-in{from{opacity:0}to{opacity:1}}',
      '.tb-detail{width:100%;max-width:760px;max-height:calc(100vh - 48px);display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 28px 72px rgba(0,0,0,.42);animation:tb-pop-in .14s ease-out}',
      '@keyframes tb-pop-in{from{transform:translateY(6px) scale(.99);opacity:.6}to{transform:none;opacity:1}}',
      '.tb-detail-head{display:flex;align-items:flex-start;gap:10px;padding:13px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
      '.tb-detail-headline{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px}',
      '.tb-detail-badges{display:flex;flex-wrap:wrap;align-items:center;gap:5px}',
      '.tb-detail-title{margin:0;font:var(--dsw-font-sm-13);font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.tb-detail-close{flex:0 0 auto;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#68707d);font-size:18px;line-height:1;cursor:pointer}',
      '.tb-detail-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.tb-statusbadge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px 1px 6px;border-radius:999px;font:var(--dsw-font-xxxs-11);font-weight:500;background:var(--dsw-alias-bg-skeleton);color:var(--dsw-alias-label-secondary,#667085)}',
      '.tb-statusbadge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.9}',
      '.tb-statusbadge[data-status=todo]{color:var(--dsw-alias-state-business-primary,#3b82f6)}',
      '.tb-statusbadge[data-status=doing]{color:var(--dsw-alias-state-warn-primary,#d97706)}',
      '.tb-statusbadge[data-status=done]{color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.tb-statusbadge[data-status=archived]{color:var(--dsw-alias-label-tertiary,#98a2b3)}',
      '.tb-detail-chip{padding:1px 7px;border-radius:5px;background:var(--dsw-alias-bg-skeleton);color:var(--dsw-alias-label-secondary,#667085);font:var(--dsw-font-xxxs-11);white-space:nowrap}',
      '.tb-timeline{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-skeleton)}',
      '.tb-timeline-item{display:flex;flex-direction:column;gap:2px;min-width:0;padding:0 4px;border-left:1px solid var(--dsw-alias-border-l1)}',
      '.tb-timeline-item:first-child{border-left:0;padding-left:0}',
      '.tb-timeline-label{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary,#68707d)}',
      '.tb-timeline-value{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-primary);white-space:nowrap}',
      '@media (max-width: 760px){.tb-timeline{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:7px}.tb-timeline-item{padding-left:0;border-left:0}}',
      '.tb-detail-body{padding:11px 16px 4px;overflow:auto;display:flex;flex-direction:column;gap:11px;flex:1 1 auto}',
      '.tb-detail-section{display:flex;flex-direction:column;gap:4px}',
      '.tb-detail-sub{margin:0;font:var(--dsw-font-xxxs-11);font-weight:600;color:var(--dsw-alias-label-secondary,#68707d);letter-spacing:.02em}',
      '.tb-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:18px;row-gap:0;margin:0;font:var(--dsw-font-xxs-12)}',
      '.tb-detail-row{display:grid;grid-template-columns:74px minmax(0,1fr);gap:8px;align-items:baseline;padding:3px 0;min-width:0}',
      '@media (max-width: 760px){.tb-detail-grid{grid-template-columns:minmax(0,1fr)}.tb-detail-row{border-bottom:1px dashed var(--dsw-alias-border-l1)}.tb-detail-row:last-child{border-bottom:0}}',
      '.tb-detail-grid dt{color:var(--dsw-alias-label-secondary,#68707d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tb-detail-grid dd{margin:0;word-break:break-all;min-width:0;line-height:1.55}',
      '.tb-detail-text{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-skeleton);font:var(--dsw-font-xs-12);line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto;color:var(--dsw-alias-label-primary)}',
      '.tb-rich > :first-child{margin-top:0}',
      '.tb-rich > :last-child{margin-bottom:0}',
      '.tb-rich p{margin:0 0 8px}',
      '.tb-rich .tb-rich-h{margin:10px 0 6px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.tb-rich .tb-rich-h[data-level="1"]{font-size:13px}',
      '.tb-rich .tb-rich-list{margin:2px 0 8px;padding-left:18px;display:flex;flex-direction:column;gap:3px}',
      '.tb-rich .tb-rich-list li{line-height:1.6}',
      '.tb-rich .tb-rich-code{margin:6px 0 8px;padding:8px 10px;border-radius:7px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxxs-11);line-height:1.6;overflow:auto;max-height:180px;white-space:pre}',
      '.tb-rich code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);font:var(--dsw-font-xxxs-11)}',
      '.tb-rich .tb-rich-code code{padding:0;border:0;background:transparent}',
      '.tb-rich .tb-rich-quote{margin:6px 0;padding:6px 10px;border-left:2px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary,#68707d)}',
      '.tb-rich .tb-rich-hr{margin:8px 0;border:0;border-top:1px dashed var(--dsw-alias-border-l1)}',
      '.tb-rich a{color:var(--dsw-alias-state-business-primary,#3b82f6);text-decoration:underline}',
      '.tb-rich .tb-rich-tablewrap{margin:6px 0 10px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;max-height:260px}',
      '.tb-rich .tb-rich-table{width:100%;border-collapse:collapse;font:var(--dsw-font-xxs-12)}',
      '.tb-rich .tb-rich-table th{position:sticky;top:0;background:var(--dsw-alias-bg-base);padding:7px 10px;text-align:left;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.tb-rich .tb-rich-table td{padding:6px 10px;border-bottom:1px dashed var(--dsw-alias-border-l1);vertical-align:top;line-height:1.55}',
      '.tb-rich .tb-rich-table tr:last-child td{border-bottom:0}',
      '.tb-detail-result{max-height:360px}',
      '.tb-detail-result-filled{border-left:3px solid var(--dsw-alias-state-success-primary,#16a34a)}',
      '.tb-detail-result[data-status=doing]{border-left:3px solid var(--dsw-alias-state-warn-primary,#d97706)}',
      '.tb-detail-muted{color:var(--dsw-alias-label-secondary,#68707d);font-style:normal}',
      '.tb-detail-error{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary,rgba(217,119,6,.12))}',
      '.tb-detail-sessions{display:flex;flex-wrap:wrap;gap:8px}',
      '.tb-detail-sessions .tb-btn{border-radius:8px}',
      '.tb-detail-actions{display:flex;justify-content:flex-end;gap:8px;padding:9px 16px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);flex:0 0 auto}',
      '.tb-page[data-narrow=true]{padding:10px 10px 12px;gap:9px}',
      '.tb-page[data-narrow=true] .tb-title{font-size:16px}',
      '.tb-page[data-narrow=true] .tb-head{flex-direction:column;align-items:stretch;gap:8px}',
      '.tb-page[data-narrow=true] .tb-head-side{justify-content:flex-start}',
      '.tb-page[data-narrow=true] .tb-optional{display:none}',
      '.tb-page[data-narrow=true] .tb-board{grid-template-columns:minmax(0,1fr)}',
      '.tb-page[data-layout=medium] .tb-board{grid-template-columns:repeat(2,minmax(0,1fr))}',
      '.tb-page[data-narrow=true] .tb-col{min-height:0;height:auto;padding:8px 8px 9px}',
      '.tb-page[data-narrow=true] .tb-empty{padding:8px}',
      '.tb-page[data-narrow=true] .tb-select{max-width:100%}',
      '.tb-page[data-narrow=true] .tb-foot{font-size:10px}',

      // ── 平台看板 / 工作区 ──────────────────────────────────────
      '.tb-wsname{color:var(--dsw-alias-label-tertiary)}',
      '.tb-notice{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.tb-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;min-width:0}',
      '.tb-toolbar-filter{display:inline-flex;align-items:center;gap:6px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.tb-toolbar-count{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.tb-workspace-select{max-width:220px}',
      '.tb-platform-empty{margin-top:2px}',
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
      'guide.description': '看板在右侧栏里：待开始 / 进行中 / 已完成 / 已归档，主 Agent 会自动挑待开始的任务派发。',
      'action.openBoard': '打开任务看板（右侧栏）',
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
      'dispatch.mode': '派发到',
      'dispatch.mode.new': '新对话',
      'dispatch.mode.creator': '回发起对话',
      'dispatch.mode.auto': '空闲会话',
      'dispatch.modeHint': '新对话：每个任务在它自己的工作区新开一个对话执行（推荐）；回发起对话：派回创建它的那个对话；空闲会话：自动挑一个空闲会话。',
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
      'composer.autoHint': '加进「待开始」后由主 Agent 自动接手，你只管加任务和看结论。',
      'composer.autoHintWorkspace': '加进「待开始」后由主 Agent 自动接手；任务会回到本对话执行（工作区：{name}）。',
      'card.workspace': '工作区 {name}',
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
      'card.deleteConfirmShort': '确认删除',
      'card.detail': '详情',
      'card.openChat': '对话',
      'detail.sessions': '关联对话',
      'detail.creatorSession': '发起对话',
      'detail.runSession': '执行对话',
      'detail.noSession': '（这条任务还没有关联对话）',
      'detail.status': '状态',
      'detail.basicInfo': '基本信息',
      'detail.timeline': '时间线',
      'detail.workspace': '工作区',
      'detail.created': '创建时间',
      'detail.updated': '最后更新',
      'detail.started': '开始时间',
      'detail.finished': '完成时间',
      'detail.archived': '归档时间',
      'detail.assignee': '执行者',
      'detail.assigneeAuto': '主 Agent（自动派发）',
      'detail.source': '创建来源',
      'detail.sourceUser': '用户（看板 / 对话）',
      'detail.sourceAgent': '主 Agent（模型工具）',
      'detail.notify': '派发提醒次数',
      'detail.id': '任务 id',
      'detail.note': '备注 / 验收标准',
      'detail.result': '完成结论',
      'detail.error': '最近错误',
      'detail.emptyNote': '（没有备注）',
      'detail.emptyResult': '任务已完成，但主 Agent 还没有写结论。',
      'detail.emptyResultPending': '任务还没完成，完成后主 Agent 会把结论写在这里。',
      'detail.close': '关闭',
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

      // 平台看板（左侧栏）
      'platform.label': '任务看板',
      'platform.title': '任务看板',
      'platform.total': '共 {n} 条',
      'platform.filter': '工作区',
      'platform.filterAll': '全部工作区',
      'platform.workspace': '任务所属工作区',
      'platform.workspacePlaceholder': '选择工作区',
      'platform.workspaceRequired': '先选择任务所属的工作区',
      'platform.refresh': '立即刷新',
      'platform.archiveDone': '一键归档已完成',
      'platform.empty': '没有任务。选个工作区加一条，主 Agent 会自动接手。',

      // 右栏「本工作区看板」
      'board.workspaceUnknown': '无法确定当前工作区（历史会话），这里只显示已绑定本工作区的任务。',
      'board.workspaceSuffix': '· {name}',
      'board.unboundHint': '另有 {n} 条任务没有绑定工作区（旧任务或别的会话创建的），在左侧栏「任务看板」可见。',
      'badge.open': '{n} 条待处理',

      // 新增派发 reason
      'poll.skip.workspace-session': '已派发给本工作区的会话',
      'poll.skip.workspace-busy': '这条任务所属工作区的对话正在忙，等它空下来再派',
      'poll.skip.workspace-offline': '这条任务所属工作区没有打开的对话：先在那个工作区开一个对话，或点「立即派发」改派',
      'poll.skip.creator-busy': '创建这条任务的对话正在运行，等它空下来再派',
      'poll.skip.creator-cold': '创建这条任务的对话还没激活（历史会话）：在那边发一条消息，任务就会回到该对话执行；急的话点「立即派发」',
    }

    const DICT_EN = {
      'panel.label': 'Task board',
      'guide.description': 'The board lives in this right sidebar: todo / in progress / done / archived, and the main agent dispatches todo tasks for you.',
      'action.openBoard': 'Open task board (right sidebar)',
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
      'dispatch.mode': 'Dispatch to',
      'dispatch.mode.new': 'New chat',
      'dispatch.mode.creator': 'Creator chat',
      'dispatch.mode.auto': 'Idle chat',
      'dispatch.modeHint': 'New chat: start a fresh conversation in the task workspace (recommended); Creator chat: reuse the conversation that created it; Idle chat: pick any idle conversation.',
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
      'composer.autoHint': 'The main agent picks up new todo tasks automatically — just add tasks and read the results.',
      'composer.autoHintWorkspace': 'The main agent picks this up automatically and runs it back in this conversation (workspace: {name}).',
      'card.workspace': 'workspace {name}',
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
      'card.deleteConfirmShort': 'Confirm delete',
      'card.detail': 'Details',
      'card.openChat': 'Chat',
      'detail.sessions': 'Linked conversations',
      'detail.creatorSession': 'Created in',
      'detail.runSession': 'Dispatched to',
      'detail.noSession': '(this task has no linked conversation yet)',
      'detail.status': 'Status',
      'detail.basicInfo': 'Details',
      'detail.timeline': 'Timeline',
      'detail.workspace': 'Workspace',
      'detail.created': 'Created',
      'detail.updated': 'Last updated',
      'detail.started': 'Started',
      'detail.finished': 'Finished',
      'detail.archived': 'Archived',
      'detail.assignee': 'Runner / assignee',
      'detail.assigneeAuto': 'Main agent (auto dispatch)',
      'detail.source': 'Created by',
      'detail.sourceUser': 'User (board or chat)',
      'detail.sourceAgent': 'Main agent (model tool)',
      'detail.notify': 'Dispatch reminders',
      'detail.id': 'Task id',
      'detail.note': 'Note / acceptance',
      'detail.result': 'Result',
      'detail.error': 'Last error',
      'detail.emptyNote': '(no note)',
      'detail.emptyResult': 'Task is done but the main agent has not written a result yet.',
      'detail.emptyResultPending': 'Not finished yet; the main agent writes the result here when done.',
      'detail.close': 'Close',
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

      // Platform board (left sidebar)
      'platform.label': 'Task board',
      'platform.title': 'Task board',
      'platform.total': '{n} tasks',
      'platform.filter': 'Workspace',
      'platform.filterAll': 'All workspaces',
      'platform.workspace': 'Task workspace',
      'platform.workspacePlaceholder': 'Choose a workspace',
      'platform.workspaceRequired': 'Choose the workspace first',
      'platform.refresh': 'Refresh now',
      'platform.archiveDone': 'Archive all done',
      'platform.empty': 'No tasks yet. Pick a workspace, add one, and the main agent picks it up automatically.',

      // Right-column board (this workspace)
      'board.workspaceUnknown': 'Cannot determine the current workspace (legacy session); only tasks bound to this workspace are shown.',
      'board.workspaceSuffix': '· {name}',
      'board.unboundHint': '{n} task(s) have no workspace (legacy or created in another conversation); they are visible in the left sidebar task board.',
      'badge.open': '{n} pending',

      // New dispatch reasons
      'poll.skip.workspace-session': 'Dispatched to a session in this workspace',
      'poll.skip.workspace-busy': 'A conversation in the task workspace is busy; retrying later',
      'poll.skip.workspace-offline': 'No open conversation in the task workspace: open one there, or click Dispatch now',
      'poll.skip.creator-busy': 'The conversation that created this task is running; retrying later',
      'poll.skip.creator-cold': 'The creating conversation is not active yet (legacy session): send a message there to receive the task, or click Dispatch now',
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

    /** 路径取尾段作为工作区展示名（兼容 Windows 反斜杠）。 */
    function baseName(path) {
      if (typeof path !== 'string' || path === '') return ''
      const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
      return parts.length > 0 ? parts[parts.length - 1] : path
    }

    /** 路径比较用归一化：统一反斜杠、去尾斜杠（大小写在 samePath 里按平台处理）。 */
    function normalizePath(path) {
      if (typeof path !== 'string' || path === '') return ''
      return path.replace(/[\\/]+$/, '').replace(/\//g, '\\')
    }

    /** 是否 Windows 风格路径（盘符或反斜杠）：只有它们才忽略大小写。 */
    function isWindowsPath(path) {
      return /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\')
    }

    /**
     * 两个工作区路径是否指向同一个目录：反斜杠统一、去尾斜杠，
     * Windows 风格路径忽略大小写；任一方为空一律视为不同。
     */
    function samePath(a, b) {
      const left = normalizePath(a)
      const right = normalizePath(b)
      if (left === '' || right === '') return false
      if (isWindowsPath(left) || isWindowsPath(right)) return left.toLowerCase() === right.toLowerCase()
      return left === right
    }

    /** 按路径在工作区列表里找展示名：命中用 title，缺失回退路径尾段。 */
    function workspaceTitleOf(workspaces, path) {
      const list = Array.isArray(workspaces) ? workspaces : []
      if (typeof path !== 'string' || path === '') return ''
      const hit = list.find((workspace) => workspace && samePath(workspace.path, path))
      if (hit && typeof hit.title === 'string' && hit.title !== '') return hit.title
      return baseName(path)
    }

    /**
     * 右栏「本工作区看板」的过滤：
     *  - cwd 与当前工作区相同的任务；或
     *  - 创建于本对话的任务（sessionId 相同）——旧任务/模型工具建的任务可能没有 cwd，
     *    但它们确实属于这个对话，不能凭空消失。
     * 工作区路径拿不到时，只按「创建于本对话」兜底。
     */
    function tasksForWorkspace(tasks, workspacePath, sessionId) {
      const list = Array.isArray(tasks) ? tasks : []
      const path = typeof workspacePath === 'string' ? workspacePath : ''
      const session = typeof sessionId === 'string' ? sessionId : ''
      if (path === '' && session === '') return []
      return list.filter((task) => {
        if (!task) return false
        if (path !== '' && samePath(task.cwd, path)) return true
        if (session !== '' && task.sessionId === session) return true
        return false
      })
    }

    /** 平台看板的工作区过滤：空字符串 = 全部工作区。 */
    function tasksForFilter(tasks, filterPath) {
      const list = Array.isArray(tasks) ? tasks : []
      if (typeof filterPath !== 'string' || filterPath === '') return list
      return list.filter((task) => task && samePath(task.cwd, filterPath))
    }

    // 会话 id 形如 session-xxxxxxxx…：取尾部更可区分（头部对每个会话都一样）。
    function shortSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return '–'
      return sessionId.length > 8 ? sessionId.slice(-8) : sessionId
    }

    /** 绝对时间（本地时区，YYYY-MM-DD HH:mm:ss）：详情浮层用，空值显示破折号。 */
    function fmtWhen(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const ms = Date.parse(value)
      if (!Number.isFinite(ms)) return value
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return (
        date.getFullYear() +
        '-' + pad(date.getMonth() + 1) +
        '-' + pad(date.getDate()) +
        ' ' + pad(date.getHours()) +
        ':' + pad(date.getMinutes()) +
        ':' + pad(date.getSeconds())
      )
    }

    /** 行内格式：**粗体**、`代码`、[链接](url)。 */
    function renderInline(text, keyPrefix) {
      const nodes = []
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/
      const parts = String(text).split(pattern)
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        if (part === '') continue
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          nodes.push(h('strong', { key: keyPrefix + 'b' + i }, part.slice(2, -2)))
        } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          nodes.push(h('code', { key: keyPrefix + 'c' + i }, part.slice(1, -1)))
        } else if (part.startsWith('[') && part.includes('](') && part.endsWith(')')) {
          const close = part.indexOf('](')
          const label = part.slice(1, close)
          const href = part.slice(close + 2, -1)
          nodes.push(
            /^https?:\/\//i.test(href)
              ? h('a', { key: keyPrefix + 'a' + i, href, target: '_blank', rel: 'noreferrer' }, label)
              : h('span', { key: keyPrefix + 'x' + i }, label),
          )
        } else {
          nodes.push(part)
        }
      }
      return nodes
    }

    /**
     * 把纯文本结论/备注渲染成有层级的节点：标题、列表、代码块、引用、分隔线、段落、行内粗体/代码。
     * 主 Agent 和子 Agent 写回的内容常见这些结构，直接堆成一段大白话很难读。
     */
    /** 一整段没有结构的密集文本：按分号拆成条目，避免结论糊成一坨。 */
    function splitLooseSegments(line) {
      const text = typeof line === 'string' ? line.trim() : ''
      if (text.length < 60) return []
      const marks = (text.match(/[；;]/g) || []).length
      if (marks < 2) return []
      const parts = text
        .split(/[；;]/)
        .map((part) => part.trim())
        .filter((part) => part !== '')
      return parts.length >= 2 ? parts : []
    }

    /** 轻量 Markdown 解析：标题 / 列表 / 代码块 / 引用 / 分隔线 / 表格 / 段落（含密集文本兜底拆分）。 */
    function parseRichText(text) {
      const source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
      if (source.trim() === '') return []
      const lines = source.split('\n')
      const blocks = []
      let paragraph = []
      let list = null
      let code = null

      const flushParagraph = () => {
        if (paragraph.length === 0) return
        if (paragraph.length === 1) {
          const segments = splitLooseSegments(paragraph[0])
          if (segments.length >= 2) {
            blocks.push({ type: 'list', ordered: false, items: segments })
            paragraph = []
            return
          }
        }
        blocks.push({ type: 'p', lines: paragraph.slice() })
        paragraph = []
      }
      const flushList = () => {
        if (!list) return
        blocks.push({ type: 'list', ordered: list.ordered, items: list.items.slice() })
        list = null
      }
      const flushCode = () => {
        if (!code) return
        blocks.push({ type: 'code', lang: code.lang, lines: code.lines.slice() })
        code = null
      }
      const flushAll = () => {
        flushParagraph()
        flushList()
        flushCode()
      }
      const splitRow = (line) =>
        line
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim())
      const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line || '')

      let i = 0
      while (i < lines.length) {
        const rawLine = lines[i]
        const line = rawLine.replace(/\s+$/, '')
        if (code) {
          if (/^\x60\x60\x60/.test(line.trim())) flushCode()
          else code.lines.push(rawLine)
          i += 1
          continue
        }
        const fence = line.trim().match(/^\x60\x60\x60(.*)$/)
        if (fence) {
          flushParagraph()
          flushList()
          code = { lang: (fence[1] || '').trim(), lines: [] }
          i += 1
          continue
        }
        if (line.trim() === '') {
          flushParagraph()
          flushList()
          i += 1
          continue
        }
        // 表格：首行 | a | b |，次行是 |---|:--:| 分隔
        if (isTableRow(line) && i + 1 < lines.length && /-/.test(lines[i + 1]) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
          flushParagraph()
          flushList()
          const header = splitRow(line)
          const aligns = splitRow(lines[i + 1]).map((cell) => {
            const left = cell.startsWith(':')
            const right = cell.endsWith(':')
            return left && right ? 'center' : right ? 'right' : 'left'
          })
          i += 2
          const rows = []
          while (i < lines.length && isTableRow(lines[i])) {
            rows.push(splitRow(lines[i]))
            i += 1
          }
          blocks.push({ type: 'table', header, aligns, rows })
          continue
        }
        const heading = line.match(/^(#{1,4})\s+(.*)$/)
        if (heading) {
          flushParagraph()
          flushList()
          blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
          i += 1
          continue
        }
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          flushParagraph()
          flushList()
          blocks.push({ type: 'hr' })
          i += 1
          continue
        }
        const quote = line.match(/^\s*>\s?(.*)$/)
        if (quote) {
          flushParagraph()
          flushList()
          blocks.push({ type: 'quote', text: quote[1] })
          i += 1
          continue
        }
        const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
        const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
        if (bullet || numbered) {
          flushParagraph()
          const ordered = Boolean(numbered)
          if (!list || list.ordered !== ordered) {
            flushList()
            list = { ordered, items: [] }
          }
          list.items.push((bullet || numbered)[1])
          i += 1
          continue
        }
        flushList()
        paragraph.push(line)
        i += 1
      }
      flushAll()
      return blocks
    }

    /** 把解析结果渲染成 React 节点（两块看板的详情浮层共用）。 */
    function renderRichText(text) {
      const blocks = parseRichText(text)
      return blocks.map((block, index) => {
        const key = 'b' + index
        if (block.type === 'heading') {
          return h(
            'h4',
            { key, className: 'tb-rich-h', 'data-level': String(block.level) },
            renderInline(block.text, key + '_'),
          )
        }
        if (block.type === 'hr') return h('hr', { key, className: 'tb-rich-hr' })
        if (block.type === 'quote') {
          return h('blockquote', { key, className: 'tb-rich-quote' }, renderInline(block.text, key + '_'))
        }
        if (block.type === 'code') {
          return h('pre', { key, className: 'tb-rich-code' }, h('code', null, block.lines.join('\n')))
        }
        if (block.type === 'list') {
          return h(
            block.ordered ? 'ol' : 'ul',
            { key, className: 'tb-rich-list' },
            block.items.map((item, itemIndex) => h('li', { key: key + '_' + itemIndex }, renderInline(item, key + '_' + itemIndex + '_'))),
          )
        }
        if (block.type === 'table') {
          return h(
            'div',
            { key, className: 'tb-rich-tablewrap' },
            h(
              'table',
              { className: 'tb-rich-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  block.header.map((cell, cellIndex) =>
                    h(
                      'th',
                      { key: key + 'h' + cellIndex, style: { textAlign: block.aligns[cellIndex] || 'left' } },
                      renderInline(cell, key + 'h' + cellIndex + '_'),
                    ),
                  ),
                ),
              ),
              h(
                'tbody',
                null,
                block.rows.map((row, rowIndex) =>
                  h(
                    'tr',
                    { key: key + 'r' + rowIndex },
                    row.map((cell, cellIndex) =>
                      h('td', { key: key + 'c' + cellIndex }, renderInline(cell, key + 'r' + rowIndex + 'c' + cellIndex + '_')),
                    ),
                  ),
                ),
              ),
            ),
          )
        }
        // 段落：多行之间用 <br>，保留原有换行
        const children = []
        block.lines.forEach((lineText, lineIndex) => {
          if (lineIndex > 0) children.push(h('br', { key: key + 'br' + lineIndex }))
          if (lineText.trim() !== '') children.push(h('span', { key: key + 'l' + lineIndex }, renderInline(lineText, key + 'l' + lineIndex + '_')))
        })
        return h('p', { key }, children)
      })
    }

    /** 紧凑时间：MM-DD HH:mm（详情时间线用，完整时间放 title）。 */
    function fmtShortWhen(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const ms = Date.parse(value)
      if (!Number.isFinite(ms)) return value
      const date = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function groupTasks(tasks) {
      const groups = { todo: [], doing: [], done: [], archived: [] }
      for (const task of Array.isArray(tasks) ? tasks : []) {
        if (!groups[task.status]) continue
        groups[task.status].push(task)
      }
      return groups
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

      /* ── 右侧栏入口 ─────────────────────────────────────────── */

      // 由 ctx.inject(['sidebarRight']) 在服务就绪后赋值；缺失时按钮安静降级。
      let sidebarRightService = null
      // 客户端导航服务：用于「跳到对应对话」。
      let uiWorkspaceService = null

      /** 在看板里直接跳到某个会话（发起对话 / 执行对话）。 */
      function openSessionById(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (!uiWorkspaceService || typeof uiWorkspaceService.openSession !== 'function') {
          console.warn('[dsh-taskboard] uiWorkspace 不可用，无法跳转会话：' + sessionId)
          return
        }
        try {
          uiWorkspaceService.openSession(sessionId)
        } catch (error) {
          console.warn('[dsh-taskboard] 跳转会话失败：' + describeErr(error))
        }
      }

      function openBoard(retry = 0) {
        if (!sidebarRightService) {
          console.warn('[dsh-taskboard] 打开右侧看板失败：右侧栏服务不可用（需要部署里的 ui-sidebar-right）')
          return
        }
        try {
          sidebarRightService.openTab(TAB_KIND)
        } catch (error) {
          // 会话刚切过来时右栏 store 可能还没 adopt，openTab 会抛；隔一拍重试一次再认输。
          if (retry < 1 && typeof setTimeout === 'function') {
            setTimeout(() => openBoard(retry + 1), 180)
            return
          }
          console.warn('[dsh-taskboard] 打开右侧看板失败：' + (error && error.message ? error.message : error))
        }
      }

      /* ── 图标 ───────────────────────────────────────────────── */

      /** 看板 glyph：会话 header 按钮、右栏 tab chip、引导页入口共用。 */
      function BoardGlyph(props) {
        const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' },
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
        )
      }

      /* ── 会话 header 里的入口按钮（任务看板就在右侧栏里） ───── */

      function HeaderBoardAction(props) {
        const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
        const [pending, setPending] = useState(-1)
        // 按钮打开的是「本工作区看板」，角标也按本工作区数；拿不到工作区（冷会话）时退回全平台数。
        const cwdRef = useRef('')

        useEffect(() => {
          if (sessionId === '') return undefined
          let alive = true
          callRpc('session-info', { sessionId })
            .then((res) => {
              if (!alive || !res.ok || !res.value) return
              if (typeof res.value.cwd === 'string' && res.value.cwd !== '') cwdRef.current = res.value.cwd
            })
            .catch(() => {})
          return () => {
            alive = false
          }
        }, [sessionId])

        useEffect(() => {
          let alive = true
          const read = () => {
            if (!isDocVisible()) return
            callRpc('snapshot', {}).then((res) => {
              if (!alive) return
              if (!res.ok || !res.value || !Array.isArray(res.value.tasks)) return
              const workspace = cwdRef.current
              let count = 0
              for (const task of res.value.tasks) {
                if (task.status !== 'todo') continue
                if (workspace !== '' && !samePath(task.cwd, workspace)) continue
                count += 1
              }
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
        const tip = t('panel.label') + (pending > 0 ? ' · ' + t('badge.label', { n: pending }) : '')

        return h(
          'button',
          {
            type: 'button',
            className: 'tb-headbtn',
            title: tip,
            'aria-label': t('action.openBoard'),
            onClick: openBoard,
          },
          h(BoardGlyph, { size: 16 }),
          badge === null ? null : h('span', { className: 'tb-badge', 'aria-hidden': 'true' }, badge),
        )
      }

      /** 右栏 tab 的 chip：图标 + 当前标题。 */
      function BoardTabTitle(props) {
        const useTabInfo = props ? props.useTabInfo : undefined
        let title = t('panel.label')
        if (typeof useTabInfo === 'function') {
          try {
            const info = useTabInfo()
            if (info && info.tab && typeof info.tab.title === 'string' && info.tab.title !== '') title = info.tab.title
          } catch (error) {
            /* 取不到就退回本地文案 */
          }
        }
        return h('span', { className: 'tb-tabtitle' }, h(BoardGlyph, { size: 14 }), h('span', null, title))
      }

      /**
       * 生成一块看板共用的子组件（Banner / 四列 + 卡片 + 编辑态）。
       * 左侧平台看板与右栏「本工作区看板」只在数据与动作上不同，列头与卡片完全复用。
       */
      function createBoardPieces(bind) {
        // bind 是**稳定的可变对象**：看板每次渲染只改它的字段，组件在每次渲染时读当前值。
        // 组件身份因此保持不变，2s 轮询刷新不会卸载重建它们（否则详情浮层会闪、滚动位置/编辑态会丢）。

        /**
         * 任务关联的会话：优先「执行对话」，其次「发起对话」；
         * 老版本 Host 派发的进行中任务没记 dispatchedSessionId，用 snapshot.poll 的最近派发兜底
         * （仅当同时只有一条 doing 任务时，避免张冠李戴）。
         */
        function sessionOf(task) {
          if (!task) return ''
          if (task.dispatchedSessionId) return task.dispatchedSessionId
          if (task.sessionId) return task.sessionId
          const fallback = typeof bind.fallbackDispatchSessionId === 'string' ? bind.fallbackDispatchSessionId : ''
          if (task.status === 'doing' && fallback !== '') {
            const lastDispatchTaskId = typeof bind.lastDispatchTaskId === 'string' ? bind.lastDispatchTaskId : ''
            if (lastDispatchTaskId === '' || lastDispatchTaskId === task.id) return fallback
          }
          return ''
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
          const t = bind.t
          const busy = bind.busy
          const actions = bind.actions
          const status = props.status
          const list = props.tasks
          const compact = props.compact === true
          return h(
            'section',
            {
              className: 'tb-col',
              'data-status': status,
              'data-compact': compact ? 'true' : 'false',
              'aria-label': t('column.' + status),
            },
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
                          if (next) actions.dispatchNow(next)
                        },
                      },
                      t('column.dispatchAll'),
                    )
                  : null,
                status === 'done' && list.length > 0
                  ? h(
                      'button',
                      { type: 'button', className: 'tb-btn tb-btn-sm tb-btn-ghost', disabled: busy !== '', onClick: actions.archiveDone },
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
          const t = bind.t
          const busy = bind.busy
          const editing = bind.editing
          const now = bind.now
          const actions = bind.actions
          const task = props.task
          const status = task.status
          const isEditing = editing !== null && editing.id === task.id
          const busyKey = 'update:' + task.id
          // 行内二次确认：不用 window.confirm（浏览器可能已勾选「阻止此页面的其它对话框」，那样确认永远为 false，
          // 表现就是「点了删除没反应」）。状态放在看板组件里，Card 保持纯展示。
          const confirmingDelete = typeof actions.isConfirmingDelete === 'function' && actions.isConfirmingDelete(task.id)

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
                  onChange: (event) => actions.setEditing(Object.assign({}, editing, { title: event.target.value })),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      actions.saveEdit()
                    } else if (event.key === 'Escape') {
                      actions.setEditing(null)
                    }
                  },
                }),
                h('textarea', {
                  className: 'tb-textarea',
                  value: editing.note,
                  placeholder: t('composer.note'),
                  onChange: (event) => actions.setEditing(Object.assign({}, editing, { note: event.target.value })),
                }),
                h(
                  'div',
                  { className: 'tb-edit-actions' },
                  h('button', { type: 'button', className: 'tb-btn tb-btn-sm', onClick: () => actions.setEditing(null) }, t('card.cancel')),
                  h('button', { type: 'button', className: 'tb-btn tb-btn-sm tb-btn-primary', disabled: busy !== '', onClick: saveEdit }, t('card.save')),
                ),
              ),
            )
          }

          const requestDelete = () => actions.requestDelete(task)

          // 注意：不能叫 actions —— 会遮蔽 bind.actions，按钮回调里的 actions.updateTask 全变成 undefined
          // （表现为「点归档/删除没反应」）。
          const cardActions = []
          if (status === 'todo') {
            cardActions.push(['start', () => actions.updateTask(task.id, { status: 'doing' }), true])
            cardActions.push(['dispatchNow', () => actions.dispatchNow(task), false])
            cardActions.push(['edit', () => actions.startEdit(task), false])
            cardActions.push([confirmingDelete ? 'deleteConfirmShort' : 'delete', requestDelete, false])
          } else if (status === 'doing') {
            cardActions.push(['complete', () => actions.updateTask(task.id, { status: 'done' }), true])
            cardActions.push(['reopen', () => actions.updateTask(task.id, { status: 'todo' }), false])
            cardActions.push(['edit', () => actions.startEdit(task), false])
          } else if (status === 'done') {
            cardActions.push(['archive', () => actions.updateTask(task.id, { status: 'archived' }), true])
            cardActions.push(['reopen', () => actions.updateTask(task.id, { status: 'doing' }), false])
            cardActions.push(['edit', () => actions.startEdit(task), false])
          } else {
            cardActions.push(['unarchive', () => actions.updateTask(task.id, { status: 'todo' }), true])
            cardActions.push([confirmingDelete ? 'deleteConfirmShort' : 'delete', requestDelete, false])
          }

          const metaBits = [h('span', { key: 'id', className: 'tb-card-tag' }, task.id)]
          if (task.source === 'agent') metaBits.push(h('span', { key: 'src', className: 'tb-card-tag' }, 'agent'))
          if (task.cwd) {
            metaBits.push(
              h(
                'span',
                { key: 'cwd', className: 'tb-card-tag', title: task.cwd },
                t('card.workspace', { name: baseName(task.cwd) }),
              ),
            )
          }
          metaBits.push(h('span', { key: 'time' }, fmtAgo(t, task.updatedAt, now)))
          if (task.notificationCount > 0 && status === 'todo') {
            metaBits.push(h('span', { key: 'notified' }, t('card.notified', { n: task.notificationCount })))
          }
          if (task.assignee) metaBits.push(h('span', { key: 'assignee' }, t('card.assignee') + ': ' + task.assignee))

          cardActions.unshift(['detail', () => actions.openDetail(task), false])
          const cardSessionId = sessionOf(task)
          if (cardSessionId !== '') {
            cardActions.push(['openChat', () => actions.openSession({ dispatchedSessionId: cardSessionId, sessionId: task.sessionId }), false])
          }

          return h(
            'article',
            { className: 'tb-card', style: { '--tb-accent': STATUS_ACCENT[status] } },
            h(
              'div',
              {
                className: 'tb-card-title tb-card-titlebtn',
                role: 'button',
                tabIndex: 0,
                title: t('card.detail'),
                onClick: () => actions.openDetail(task),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    actions.openDetail(task)
                  }
                },
              },
              task.title,
            ),
            task.note
              ? h('div', { className: 'tb-card-note', title: task.note }, task.note)
              : null,
            task.result ? h('div', { className: 'tb-card-result', title: task.result }, t('card.result') + ': ' + task.result) : null,
            task.lastError ? h('div', { className: 'tb-card-error' }, task.lastError) : null,
            h('div', { className: 'tb-card-meta' }, metaBits),
            h(
              'div',
              { className: 'tb-card-actions' },
              cardActions.map((entry) =>
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


        /** 任务详情浮层：看板上一次看不全的字段（完整结论/备注/时间线/派给谁）都在这里。 */
        function Detail(props) {
          const t = bind.t
          const task = props.task
          if (!task) return null
          const metaRows = [
            [t('detail.workspace'), task.cwd || '—'],
            [t('detail.assignee'), task.assignee || t('detail.assigneeAuto')],
            [t('detail.source'), task.source === 'agent' ? t('detail.sourceAgent') : t('detail.sourceUser')],
            [t('detail.notify'), String(task.notificationCount || 0)],
            [t('detail.id'), task.id],
          ]
          const timeRows = [
            [t('detail.created'), fmtShortWhen(task.createdAt), fmtWhen(task.createdAt)],
            [t('detail.updated'), fmtShortWhen(task.updatedAt), fmtWhen(task.updatedAt)],
            [t('detail.started'), fmtShortWhen(task.startedAt), fmtWhen(task.startedAt)],
            [t('detail.finished'), fmtShortWhen(task.finishedAt), fmtWhen(task.finishedAt)],
            [t('detail.archived'), fmtShortWhen(task.archivedAt), fmtWhen(task.archivedAt)],
          ]
          const resultEmpty = task.status === 'done' && !task.result
          const quick =
            task.status === 'todo'
              ? ['doing', t('card.start')]
              : task.status === 'doing'
                ? ['done', t('card.complete')]
                : task.status === 'done'
                  ? ['archived', t('card.archive')]
                  : ['todo', t('card.unarchive')]
          return h(
            'div',
            {
              className: 'tb-detail-mask',
              role: 'dialog',
              'aria-modal': 'true',
              onClick: (event) => {
                if (event.target === event.currentTarget) props.onClose()
              },
            },
            h(
              'section',
              { className: 'tb-detail' },
              h(
                'header',
                { className: 'tb-detail-head' },
                h(
                  'div',
                  { className: 'tb-detail-headline' },
                  h(
                    'div',
                    { className: 'tb-detail-badges' },
                    h('span', { className: 'tb-statusbadge', 'data-status': task.status }, t('column.' + task.status)),
                    h('span', { className: 'tb-detail-chip' }, task.id),
                    h(
                      'span',
                      { className: 'tb-detail-chip' },
                      task.source === 'agent' ? t('detail.sourceAgent') : t('detail.sourceUser'),
                    ),
                    task.notificationCount > 0
                      ? h('span', { className: 'tb-detail-chip' }, t('detail.notify') + ' ' + String(task.notificationCount))
                      : null,
                  ),
                  h('h2', { className: 'tb-detail-title' }, task.title),
                ),
                h(
                  'button',
                  { type: 'button', className: 'tb-detail-close', onClick: props.onClose, 'aria-label': t('detail.close') },
                  '\u00d7',
                ),
              ),
              h(
                'div',
                { className: 'tb-detail-body' },
                h(
                  'section',
                  { className: 'tb-detail-section' },
                  h('h3', { className: 'tb-detail-sub' }, t('detail.result')),
                  h(
                    'div',
                    {
                      className:
                        'tb-detail-text tb-rich tb-detail-result' +
                        (resultEmpty ? ' tb-detail-muted' : '') +
                        (task.result ? ' tb-detail-result-filled' : ''),
                      'data-status': task.status,
                    },
                    task.result
                      ? renderRichText(task.result)
                      : task.status === 'done'
                        ? t('detail.emptyResult')
                        : t('detail.emptyResultPending'),
                  ),
                ),
                h(
                  'section',
                  { className: 'tb-detail-section' },
                  h('h3', { className: 'tb-detail-sub' }, t('detail.note')),
                  h(
                    'div',
                    { className: 'tb-detail-text tb-rich' + (task.note ? '' : ' tb-detail-muted') },
                    task.note ? renderRichText(task.note) : t('detail.emptyNote'),
                  ),
                ),
                h(
                  'section',
                  { className: 'tb-detail-section' },
                  h('h3', { className: 'tb-detail-sub' }, t('detail.basicInfo')),
                  h(
                    'dl',
                    { className: 'tb-detail-grid' },
                    metaRows.map((row) =>
                      h('div', { key: row[0], className: 'tb-detail-row' }, h('dt', null, row[0]), h('dd', null, row[1])),
                    ),
                  ),
                ),
                h(
                  'section',
                  { className: 'tb-detail-section' },
                  h('h3', { className: 'tb-detail-sub' }, t('detail.timeline')),
                  h(
                    'div',
                    { className: 'tb-timeline' },
                    timeRows.map((row) =>
                      h(
                        'div',
                        { key: row[0], className: 'tb-timeline-item' },
                        h('span', { className: 'tb-timeline-label' }, row[0]),
                        h('span', { className: 'tb-timeline-value', title: row[2] || '' }, row[1]),
                      ),
                    ),
                  ),
                ),
                h(
                  'section',
                  { className: 'tb-detail-section' },
                  h('h3', { className: 'tb-detail-sub' }, t('detail.sessions')),
                  h(
                    'div',
                    { className: 'tb-detail-sessions' },
                    task.sessionId
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'tb-btn tb-btn-sm',
                            title: task.sessionId,
                            onClick: () => props.openSession(task.sessionId),
                          },
                          t('detail.creatorSession') + ' · ' + shortSession(task.sessionId),
                        )
                      : null,
                    sessionOf(task) !== '' && sessionOf(task) !== task.sessionId
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'tb-btn tb-btn-sm',
                            title: sessionOf(task),
                            onClick: () => props.openSession(sessionOf(task)),
                          },
                          t('detail.runSession') + ' · ' + shortSession(sessionOf(task)),
                        )
                      : null,
                    sessionOf(task) === ''
                      ? h('span', { className: 'tb-detail-muted' }, t('detail.noSession'))
                      : null,
                  ),
                ),
                task.lastError
                  ? h(
                      'section',
                      { className: 'tb-detail-section' },
                      h('h3', { className: 'tb-detail-sub' }, t('detail.error')),
                      h('p', { className: 'tb-detail-text tb-detail-error' }, task.lastError),
                    )
                  : null,
              ),
              h(
                'footer',
                { className: 'tb-detail-actions' },
                h('button', { type: 'button', className: 'tb-btn tb-btn-sm', onClick: props.onClose }, t('detail.close')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tb-btn tb-btn-sm tb-btn-primary',
                    onClick: () => props.onStatus(quick[0]),
                  },
                  quick[1],
                ),
              ),
            ),
          )
        }

        return { Banner, Col, Detail }
      }

      /* ── 看板页 ─────────────────────────────────────────────── */

      /**
       * 右侧栏里的看板 tab。窄栏（普通右栏）用「按状态分组的纵向 lane」，
       * 宽栏（全屏 / 拖宽）用四列看板；宽度用 ResizeObserver 量，量不到就按窄栏渲染。
       */
      function BoardTab(props) {
        const useTabInfo = props ? props.useTabInfo : undefined
        // 右栏 tab 是 session scope，宿主会传当前会话 id：任务记下它，派发时回到这个对话。
        const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
        const tabInfo = (() => {
          if (typeof useTabInfo !== 'function') return null
          try {
            return useTabInfo()
          } catch (error) {
            return null
          }
        })()
        const [panelWidth, setPanelWidth] = useState(0)
        const rootRef = useRef(null)
        const [snap, setSnap] = useState(null)
        const [error, setError] = useState(null)
        const [failures, setFailures] = useState(0)
        const [busy, setBusy] = useState('')
        const [confirmDeleteId, setConfirmDeleteId] = useState(null)
        const [detailId, setDetailId] = useState(null)
        // createBoardPieces 的稳定 bind / 组件缓存（避免轮询刷新时组件重建导致浮层闪烁）
        const boardBindRef = useRef(null)
        const boardPiecesRef = useRef(null)
        const [notice, setNotice] = useState(null)
        const [now, setNow] = useState(Date.now())
        const [title, setTitle] = useState('')
        const [note, setNote] = useState('')
        const [showNote, setShowNote] = useState(false)
        const [editing, setEditing] = useState(null)
        const aliveRef = useRef(true)

        // 量右栏宽度：ResizeObserver 不可用（测试/老浏览器）时保持窄栏布局。
        useEffect(() => {
          const node = rootRef.current
          if (!node || typeof ResizeObserver === 'undefined') return undefined
          let alive = true
          const observer = new ResizeObserver((entries) => {
            if (!alive) return
            const entry = entries && entries[0]
            const width = entry && entry.contentRect ? entry.contentRect.width : node.clientWidth
            if (typeof width === 'number' && width > 0) setPanelWidth(Math.round(width))
          })
          observer.observe(node)
          if (typeof node.clientWidth === 'number' && node.clientWidth > 0) setPanelWidth(Math.round(node.clientWidth))
          return () => {
            alive = false
            try {
              observer.disconnect()
            } catch (error) {
              /* ignore */
            }
          }
        }, [])

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
        const allTasks = (snap && snap.tasks) || []
        const poll = (snap && snap.poll) || {}
        const agents = (snap && snap.agents) || []
        const workspaces = (snap && snap.workspaces) || []
        const currentAgent = sessionId === '' ? null : agents.find((agent) => agent && agent.sessionId === sessionId) || null
        // 冷会话（历史会话）不在 agents 里：挂载后问宿主要一次它的工作区，提示才有「工作区：xxx」。
        const [sessionCwd, setSessionCwd] = useState('')
        const askedCwd = useRef(false)
        useEffect(() => {
          if (askedCwd.current || sessionId === '') return
          askedCwd.current = true
          callRpc('session-info', { sessionId })
            .then((res) => {
              const info = res && res.ok === true ? res.value : null
              if (info && typeof info.cwd === 'string' && info.cwd !== '') setSessionCwd(info.cwd)
            })
            .catch(() => {})
        }, [sessionId])
        const cwdForHint = (currentAgent && currentAgent.cwd) || sessionCwd
        const currentWorkspace = cwdForHint ? baseName(cwdForHint) : ''
        // 右栏 = 本工作区看板：只显示 cwd 与当前工作区相同（归一化比较）的任务；
        // 工作区未知（历史会话 / 缺 cwd）时给说明条并显示空看板。
        const workspaceTitle = cwdForHint ? workspaceTitleOf(workspaces, cwdForHint) : ''
        const tasks = tasksForWorkspace(allTasks, cwdForHint, sessionId)
        // 有些旧任务/别的会话建的任务没有 cwd，本面板按设计不显示；给个去处，避免「任务凭空消失」。
        const detailTask = detailId ? allTasks.find((task) => task && task.id === detailId) || null : null
        const doingAll = allTasks.filter((task) => task && task.status === 'doing')
        const fallbackDispatchSessionId =
          poll && poll.lastDispatchSessionId && (poll.lastDispatchTaskId || doingAll.length === 1) ? poll.lastDispatchSessionId : ''
        const unboundElsewhere = allTasks.filter(
          (task) => task && !task.cwd && task.status !== 'archived' && task.sessionId !== sessionId,
        ).length
        const groups = groupTasks(tasks)
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
          if (sessionId !== '') payload.sessionId = sessionId
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
          // 二次确认由卡片上的按钮承担（见 Card 的 confirmingDelete），这里不再弹原生 confirm。
          setConfirmDeleteId(null)
          run('delete:' + task.id, () => callRpc('delete-task', { id: task.id }))
        }

        /** 第一次点「删除」只把按钮变成「确认删除」，再点一次才真删。 */
        function requestDelete(task) {
          if (confirmDeleteId === task.id) {
            removeTask(task)
            return
          }
          setConfirmDeleteId(task.id)
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

        /* ── 子组件（与平台看板共用）──────────────────────────── */
        // 组件身份保持稳定：bind 存在 ref 里，每次渲染只更新字段；pieces 只创建一次。
        // 否则轮询每 2s 刷新都会换掉组件类型 → React 卸载重建 → 详情浮层闪一下、滚动位置丢。
        const boardActions = {
            updateTask,
            dispatchNow,
            removeTask,
            requestDelete,
            isConfirmingDelete: (id) => confirmDeleteId === id,
            openDetail: (task) => setDetailId(task.id),
            openSession: (task) => openSessionById(task && (task.dispatchedSessionId || task.sessionId)),
            startEdit,
            saveEdit,
            setEditing,
            archiveDone,
        }
        if (boardBindRef.current === null) {
          boardBindRef.current = {
            t,
            busy: '',
            editing: null,
            now: 0,
            actions: boardActions,
            fallbackDispatchSessionId: '',
            lastDispatchTaskId: '',
          }
        }
        boardBindRef.current.t = t
        boardBindRef.current.busy = busy
        boardBindRef.current.editing = editing
        boardBindRef.current.now = now
        boardBindRef.current.actions = boardActions
        boardBindRef.current.fallbackDispatchSessionId = fallbackDispatchSessionId
        boardBindRef.current.lastDispatchTaskId = (poll && poll.lastDispatchTaskId) || ''
        if (boardPiecesRef.current === null) boardPiecesRef.current = createBoardPieces(boardBindRef.current)
        const Banner = boardPiecesRef.current.Banner
        const Col = boardPiecesRef.current.Col
        const Detail = boardPiecesRef.current.Detail

        /* ── 顶部状态文案 ─────────────────────────────────────── */

        const intervalText = fmtInterval(config.pollIntervalMs)
        const busyNow = busy !== ''
        const skipReason = poll.lastSkipReason || ''
        const skipKey = 'poll.skip.' + skipReason
        const skipText = skipReason === '' ? '' : t(skipKey) === skipKey ? skipReason : t(skipKey)

        // 三档布局：窄栏纵向 lane / 中等宽度两列 / 宽敞（全屏或拖宽）四列。
        const fullscreen = !!(tabInfo && tabInfo.sidebar && tabInfo.sidebar.fullscreen)
        const layout = fullscreen ? 'wide' : panelWidth >= 900 ? 'wide' : panelWidth >= 560 ? 'medium' : 'narrow'
        const wide = layout !== 'narrow'

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
          {
            className: 'tb-page',
            'data-layout': layout,
            'data-narrow': wide ? 'false' : 'true',
            ref: rootRef,
          },
          h(
            'header',
            { className: 'tb-head' },
            h(
              'div',
              { className: 'tb-head-main' },
              h('h1', { className: 'tb-title' }, t('page.title')),
              h('p', { className: 'tb-sub' },
                h('span', { className: 'tb-dot', 'data-on': config.pollEnabled ? 'true' : 'false', 'aria-hidden': 'true' }),
                workspaceTitle
                  ? h('span', { className: 'tb-wsname' }, t('board.workspaceSuffix', { name: workspaceTitle }))
                  : null,
                h('span', null, config.pollEnabled ? t('poll.on', { interval: intervalText }) : t('poll.off')),
                h('span', null, '·'),
                h('span', null, poll.lastRunAt ? t('poll.lastRun', { time: fmtClock(poll.lastRunAt, lang()) }) : t('poll.never')),
                poll.lastDispatchAt
                  ? h('span', { className: 'tb-optional' }, '· ' + t('poll.lastDispatch', {
                      time: fmtClock(poll.lastDispatchAt, lang()),
                      session: poll.lastDispatchSessionTitle || shortSession(poll.lastDispatchSessionId),
                    }))
                  : null,
                skipText ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '· ' + skipText) : null,
              ),
              unboundElsewhere > 0
                ? h('p', { className: 'tb-sub tb-unbound' }, t('board.unboundHint', { n: unboundElsewhere }))
                : null,
            ),
            h(
              'div',
              { className: 'tb-head-side' },
              h(
                'label',
                { className: 'tb-composer-meta', style: { gap: '5px' } },
                h('span', { className: 'tb-optional' }, t('poll.interval')),
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
                'label',
                { className: 'tb-composer-meta', style: { gap: '5px' } },
                h('span', { className: 'tb-optional' }, t('dispatch.mode')),
                h(
                  'select',
                  {
                    className: 'tb-select',
                    value: config.dispatchMode || 'new',
                    disabled: busyNow,
                    title: t('dispatch.modeHint'),
                    'aria-label': t('dispatch.mode'),
                    onChange: (event) => setConfig({ dispatchMode: event.target.value }),
                  },
                  ['new', 'creator', 'auto'].map((mode) => h('option', { key: mode, value: mode }, t('dispatch.mode.' + mode))),
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
          cwdForHint === ''
            ? h('div', { className: 'tb-notice', role: 'status' }, t('board.workspaceUnknown'))
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
              h(
                'span',
                { className: 'tb-hint' },
                currentWorkspace === ''
                  ? t('composer.autoHint')
                  : t('composer.autoHintWorkspace', { name: currentWorkspace }),
              ),
            ),
          ),

          wide
            ? h(
                'div',
                { className: 'tb-board', 'data-layout': layout },
                STATUS_ORDER.map((status) => h(Col, { key: status, status, tasks: groups[status], compact: false })),
              )
            : h(
                'div',
                { className: 'tb-lanes' },
                STATUS_ORDER.map((status) => h(Col, { key: status, status, tasks: groups[status], compact: true })),
              ),

          h(
            'footer',
            { className: 'tb-foot' },
            wide ? h('span', null, t('footer.path') + ':') : null,
            wide ? h('code', null, (snap && snap.boardPath) || '') : null,
            wide ? h('span', null, '·') : null,
            wide ? h('span', null, t('footer.tip')) : null,
            h('span', { style: { marginLeft: 'auto' } }, t('footer.version', { version: (snap && snap.pluginVersion) || PLUGIN_VERSION })),
          ),
          detailTask
            ? h(Detail, {
                task: detailTask,
                onClose: () => setDetailId(null),
                onStatus: (status) => {
                  setDetailId(null)
                  updateTask(detailTask.id, { status })
                },
                openSession: (sessionId) => openSessionById(sessionId),
              })
            : null,
        )
      }

      /* ── 平台看板（左侧栏：全部工作区）────────────────────────── */

      /** 左侧栏入口图标：整平台未完成（todo+doing）任务数角标。 */
      function PlatformPanelIcon(props) {
        const size = props && typeof props.size === 'number' && props.size > 0 ? props.size : 18
        const [openCount, setOpenCount] = useState(-1)

        useEffect(() => {
          let alive = true
          const read = () => {
            if (!isDocVisible()) return
            callRpc('snapshot', {}).then((res) => {
              if (!alive) return
              if (!res.ok || !res.value || !Array.isArray(res.value.tasks)) return
              let count = 0
              for (const task of res.value.tasks) {
                if (task.status === 'todo' || task.status === 'doing') count += 1
              }
              setOpenCount(count)
            })
          }
          read()
          const stop = every(read, ICON_POLL_MS)
          return () => {
            alive = false
            stop()
          }
        }, [])

        const badge = openCount > 0 ? (openCount > 99 ? '99+' : String(openCount)) : null
        const tip = t('platform.label') + (openCount > 0 ? ' · ' + t('badge.open', { n: openCount }) : '')
        return h(
          'span',
          { className: 'tb-icon', title: tip },
          h(BoardGlyph, { size }),
          badge === null ? null : h('span', { className: 'tb-badge', 'aria-hidden': 'true' }, badge),
        )
      }

      /** 平台看板：左侧栏独立页面，显示全部工作区的任务（可按工作区过滤）。 */
      function PlatformBoard() {
        const [snap, setSnap] = useState(null)
        const [error, setError] = useState(null)
        const [failures, setFailures] = useState(0)
        const [busy, setBusy] = useState('')
        const [confirmDeleteId, setConfirmDeleteId] = useState(null)
        const [detailId, setDetailId] = useState(null)
        // createBoardPieces 的稳定 bind / 组件缓存（避免轮询刷新时组件重建导致浮层闪烁）
        const boardBindRef = useRef(null)
        const boardPiecesRef = useRef(null)
        const [notice, setNotice] = useState(null)
        const [now, setNow] = useState(Date.now())
        const [title, setTitle] = useState('')
        const [note, setNote] = useState('')
        const [showNote, setShowNote] = useState(false)
        const [editing, setEditing] = useState(null)
        const [filterPath, setFilterPath] = useState('')
        const [workspaceCwd, setWorkspaceCwd] = useState('')
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

        // 轮询：可见时 2s，隐藏跳过（与右栏一致）。
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
        const allTasks = (snap && snap.tasks) || []
        const workspaces = (snap && snap.workspaces) || []
        const poll = (snap && snap.poll) || {}
        const preset = (snap && snap.preset) || null

        // 工作区选项：同一路径只列一次（保持注册顺序）。
        const workspaceOptions = []
        for (const item of Array.isArray(workspaces) ? workspaces : []) {
          if (!item || typeof item.path !== 'string' || item.path === '') continue
          if (workspaceOptions.some((option) => samePath(option.path, item.path))) continue
          workspaceOptions.push({
            path: item.path,
            title: typeof item.title === 'string' && item.title !== '' ? item.title : baseName(item.path),
          })
        }

        const visibleTasks = tasksForFilter(allTasks, filterPath)
        const groups = groupTasks(visibleTasks)
        const doingAll = allTasks.filter((task) => task && task.status === 'doing')
        const fallbackDispatchSessionId =
          poll && poll.lastDispatchSessionId && (poll.lastDispatchTaskId || doingAll.length === 1) ? poll.lastDispatchSessionId : ''
        const detailTask = detailId ? allTasks.find((task) => task && task.id === detailId) || null : null

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
          if (workspaceCwd === '') {
            setNotice({ tone: 'warn', text: t('platform.workspaceRequired') })
            return
          }
          // 平台看板不绑会话：任务归属由所选工作区决定（cwd），派发由宿主自动挑会话。
          const payload = { title: trimmedTitle, cwd: workspaceCwd }
          if (note.trim() !== '') payload.note = note.trim()
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
          // 二次确认由卡片上的按钮承担（见 Card 的 confirmingDelete），这里不再弹原生 confirm。
          setConfirmDeleteId(null)
          run('delete:' + task.id, () => callRpc('delete-task', { id: task.id }))
        }

        /** 第一次点「删除」只把按钮变成「确认删除」，再点一次才真删。 */
        function requestDelete(task) {
          if (confirmDeleteId === task.id) {
            removeTask(task)
            return
          }
          setConfirmDeleteId(task.id)
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

        // 组件身份保持稳定（同右栏看板）：bind 存 ref、只改字段，pieces 只创建一次。
        const boardActions = {
            updateTask,
            dispatchNow,
            removeTask,
            requestDelete,
            isConfirmingDelete: (id) => confirmDeleteId === id,
            openDetail: (task) => setDetailId(task.id),
            openSession: (task) => openSessionById(task && (task.dispatchedSessionId || task.sessionId)),
            startEdit,
            saveEdit,
            setEditing,
            archiveDone,
        }
        if (boardBindRef.current === null) {
          boardBindRef.current = {
            t,
            busy: '',
            editing: null,
            now: 0,
            actions: boardActions,
            fallbackDispatchSessionId: '',
            lastDispatchTaskId: '',
          }
        }
        boardBindRef.current.t = t
        boardBindRef.current.busy = busy
        boardBindRef.current.editing = editing
        boardBindRef.current.now = now
        boardBindRef.current.actions = boardActions
        boardBindRef.current.fallbackDispatchSessionId = fallbackDispatchSessionId
        boardBindRef.current.lastDispatchTaskId = (poll && poll.lastDispatchTaskId) || ''
        if (boardPiecesRef.current === null) boardPiecesRef.current = createBoardPieces(boardBindRef.current)
        const Banner = boardPiecesRef.current.Banner
        const Col = boardPiecesRef.current.Col
        const Detail = boardPiecesRef.current.Detail

        const intervalText = fmtInterval(config.pollIntervalMs)
        const busyNow = busy !== ''
        const skipReason = poll.lastSkipReason || ''
        const skipKey = 'poll.skip.' + skipReason
        const skipText = skipReason === '' ? '' : t(skipKey) === skipKey ? skipReason : t(skipKey)
        const workspaceRequired = workspaceCwd === ''

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
          { className: 'tb-page tb-platform', 'data-layout': 'wide', 'data-narrow': 'false' },
          h(
            'header',
            { className: 'tb-head' },
            h(
              'div',
              { className: 'tb-head-main' },
              h('h1', { className: 'tb-title' }, t('platform.title')),
              h('p', { className: 'tb-sub' },
                h('span', { className: 'tb-dot', 'data-on': config.pollEnabled ? 'true' : 'false', 'aria-hidden': 'true' }),
                h('span', null, t('platform.total', { n: allTasks.length })),
                h('span', null, '·'),
                h('span', null, config.pollEnabled ? t('poll.on', { interval: intervalText }) : t('poll.off')),
                h('span', null, '·'),
                h('span', null, poll.lastRunAt ? t('poll.lastRun', { time: fmtClock(poll.lastRunAt, lang()) }) : t('poll.never')),
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
                'label',
                { className: 'tb-composer-meta', style: { gap: '5px' } },
                h('span', { className: 'tb-optional' }, t('dispatch.mode')),
                h(
                  'select',
                  {
                    className: 'tb-select',
                    value: config.dispatchMode || 'new',
                    disabled: busyNow,
                    title: t('dispatch.modeHint'),
                    'aria-label': t('dispatch.mode'),
                    onChange: (event) => setConfig({ dispatchMode: event.target.value }),
                  },
                  ['new', 'creator', 'auto'].map((mode) => h('option', { key: mode, value: mode }, t('dispatch.mode.' + mode))),
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
                busy === 'refresh' ? t('page.refreshing') : t('platform.refresh'),
              ),
              h(
                'button',
                { type: 'button', className: 'tb-btn', disabled: busyNow || busy === 'archiveDone', onClick: archiveDone },
                t('platform.archiveDone'),
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
                'select',
                {
                  className: 'tb-select tb-workspace-select',
                  'aria-label': t('platform.workspace'),
                  title: t('platform.workspaceRequired'),
                  value: workspaceCwd,
                  onChange: (event) => setWorkspaceCwd(event.target.value),
                },
                h('option', { value: '' }, t('platform.workspacePlaceholder')),
                workspaceOptions.map((option) => h('option', { key: option.path, value: option.path }, option.title)),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tb-btn tb-btn-primary',
                  disabled: busyNow || title.trim() === '' || workspaceRequired,
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
              workspaceRequired ? h('span', { className: 'tb-hint' }, t('platform.workspaceRequired')) : null,
            ),
          ),

          h(
            'div',
            { className: 'tb-toolbar' },
            h(
              'label',
              { className: 'tb-toolbar-filter' },
              h('span', null, t('platform.filter')),
              h(
                'select',
                {
                  className: 'tb-select',
                  'aria-label': t('platform.filter'),
                  value: filterPath,
                  onChange: (event) => setFilterPath(event.target.value),
                },
                h('option', { value: '' }, t('platform.filterAll')),
                workspaceOptions.map((option) => h('option', { key: option.path, value: option.path }, option.title)),
              ),
            ),
            h('span', { className: 'tb-toolbar-count' }, t('platform.total', { n: visibleTasks.length })),
          ),

          allTasks.length === 0
            ? h('div', { className: 'tb-empty tb-platform-empty' }, t('platform.empty'))
            : null,

          h(
            'div',
            { className: 'tb-board', 'data-layout': 'wide' },
            STATUS_ORDER.map((status) => h(Col, { key: status, status, tasks: groups[status], compact: false })),
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
          detailTask
            ? h(Detail, {
                task: detailTask,
                onClose: () => setDetailId(null),
                onStatus: (status) => {
                  setDetailId(null)
                  updateTask(detailTask.id, { status })
                },
                openSession: (sessionId) => openSessionById(sessionId),
              })
            : null,
        )
      }

      /* ── 槽位与右栏 tab 注册 ────────────────────────────────── */

      const describeErr = (error) => (error && error.message ? error.message : String(error))

      // 1) 右栏 tab 类型：任务看板是一个「页类型」（无资源地址，按 kind 打开）。
      //    引导页也会出现一个入口卡片，方便第一次发现。
      try {
        ctx.inject(['sidebarRightTabs'], (scope) => {
          scope.effect(
            () =>
              scope.sidebarRightTabs.register({
                id: TAB_TYPE_ID,
                kind: TAB_KIND,
                priority: 'extension',
                title: () => t('panel.label'),
                guide: [
                  {
                    id: 'taskboard',
                    order: 20,
                    title: () => t('panel.label'),
                    description: () => t('guide.description'),
                    icon: BoardGlyph,
                  },
                ],
              }),
            'dsh-taskboard: sidebar-right tab type',
          )
        })
      } catch (error) {
        console.warn('[dsh-taskboard] 右栏 tab 类型注册失败：' + describeErr(error))
      }

      // 2) 会话导航：看板里「对话 / 发起对话 / 执行对话」用它跳到对应会话。
      try {
        ctx.inject(['uiWorkspace'], (scope) => {
          uiWorkspaceService = scope.uiWorkspace
        })
      } catch (error) {
        console.warn('[dsh-taskboard] 会话导航服务注入失败：' + describeErr(error))
      }

      // 2b) 右栏导航：header 按钮用它 openTab。
      try {
        ctx.inject(['sidebarRight'], (scope) => {
          sidebarRightService = scope.sidebarRight
          scope.effect(
            () => () => {
              sidebarRightService = null
            },
            'dsh-taskboard: sidebarRight handle',
          )
        })
      } catch (error) {
        console.warn('[dsh-taskboard] 右栏服务注入失败：' + describeErr(error))
      }

      // 3) tab 正文与 chip。key = 类型定义里的 id。
      slots.inject('sidebar.right.pane.tab', () =>
        slots.register({ name: 'sidebar.right.pane.tab', key: TAB_TYPE_ID }, BoardTab),
      )
      slots.inject('sidebar.right.pane.tab.title', () =>
        slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_TYPE_ID }, BoardTabTitle),
      )

      // 4) 会话 header 里的入口按钮（带待开始数量角标）。看板本体在右侧栏，不占左侧菜单。
      slots.inject('conversation.session.header.actions', () =>
        slots.register(
          {
            name: 'conversation.session.header.actions',
            id: 'taskboard',
            order: 40,
            label: () => t('panel.label'),
          },
          HeaderBoardAction,
        ),
      )

      // 5) 左侧栏：任务看板（全部工作区，独立页面 + 待处理数量角标）。
      slots.inject('sidebar.panellist', () =>
        slots.register(
          {
            name: 'sidebar.panellist',
            id: 'taskboard-platform',
            order: 25,
            label: () => t('platform.label'),
            locale: 'taskboard',
          },
          PlatformPanelIcon,
        ),
      )
      slots.inject('main', () =>
        slots.register(
          { name: 'main', key: 'taskboard-platform', label: () => t('platform.label'), locale: 'taskboard' },
          PlatformBoard,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'connection', 'timer', 'locale']

    /** 纯函数测试口（test/client.test.mjs 用 node:vm 加载后断言）。 */
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
      baseName,
      normalizePath,
      samePath,
      workspaceTitleOf,
      tasksForWorkspace,
      tasksForFilter,
      parseRichText,
      splitLooseSegments,
      renderInline,
    }

    return module.exports
  },
})
