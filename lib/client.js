/**
 * dsh-dispatch-board —— 浏览器端 bundle（经 window.__ModuleLoader__ 加载）。
 *
 * 两块看板：
 *  1. 右侧栏「本工作区看板」—— sidebarRightTabs 注册 kind=taskboard 的页类型，
 *     sidebar.right.pane.tab / .title 提供正文与 chip，conversation.session.header.actions
 *     提供会话 header 入口按钮；只显示 cwd 与当前会话工作区相同的任务（窄栏 lane / 宽栏四列）。
 *  2. 左侧栏「平台任务看板」—— sidebar.panellist 入口图标（todo+doing 角标）+ main
 *     (key: taskboard-platform) 页面；显示全部工作区的任务（卡片只显示标题 + 操作按钮，
 *     工作区 / 备注 / 结论等信息都在详情浮层），
 *     新建任务必须选工作区（add-task 传 cwd，不传 sessionId）。
 *
 * 数据通道：Host 在 webServer 注册的 /taskboard 前缀路由，经 Connection RPC 信封调用
 * （snapshot / session-info / add-task / update-task / delete-task / dispatch-now /
 *   set-config / archive-done / install-preset）。
 * v0.2.0 新增：bind-main-session / clear-main-session / ensure-workspace-lead，
 * 以及两块看板共用的「组长条」（snapshot.leads：主会话绑定状态 + 各工作区常驻组长）。
 * v0.2.0 粘贴图片：新建备注 textarea 监听 paste → upload-attachment → note 只写短引用
 * `![image](attachment://<uuid>)`；详情浮层按 id 调 attachment 渲染 <img>（不把 base64 写进 note）。
 * snapshot 带 tasks / agents / workspaces / leads；leads 是运行时视图（组长启停 / 忙闲变化
 * 不 bump revision），所以不能只比 revision 跳过重渲染。契约见 docs/architecture.md。
 *
 * 呈现层：手写 <style> 幂等注入，颜色 / 字体 / 圆角 / 焦点环全部来自官方 --dsw-* 主题变量，
 * 亮暗主题自动成立。唯一硬编码色是四列状态强调色（可视化用途）。
 *
 * 约束：只 require('react')；禁止 require 任何 @deepseek-ai/* 包（会崩槽位）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dispatch-board',
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

    const BUNDLE_ID = 'dsh-dispatch-board'
    const RPC_CHANNEL = '/taskboard'
    const CSS_TAG_ID = BUNDLE_ID + '/client.css'
    const PLUGIN_VERSION = '0.2.0' // 兜底值：正常走 snapshot.pluginVersion（宿主读 package.json）
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
      // v0.2.2：「待你处理」不是 status，只作为第五列的强调色（红）。
      needsUser: '#e5484d',
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
      '.tb-attach-strip{display:flex;flex-wrap:wrap;gap:8px}',
      '.tb-attach-item{position:relative;width:64px;height:64px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);overflow:hidden;background:var(--dsw-alias-bg-base)}',
      '.tb-attach-thumb{display:block;width:100%;height:100%;object-fit:cover}',
      '.tb-attach-remove{position:absolute;top:2px;right:2px;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:50%;background:rgba(0,0,0,.58);color:#fff;font-size:12px;line-height:1;cursor:pointer}',
      '.tb-attach-remove:hover{background:rgba(0,0,0,.75)}',
      '.tb-select{height:28px;max-width:290px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:0 6px;font:var(--dsw-font-xxxs-11);outline:none}',
      '.tb-select:focus-visible{border-color:var(--dsw-alias-state-business-primary)}',
      '.tb-linkbtn{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:var(--dsw-alias-link);cursor:pointer;padding:0;font:inherit}',
      '.tb-linkbtn:hover{text-decoration:underline}',

      // ── 看板 ───────────────────────────────────────────────────
      '.tb-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:stretch;min-width:0;flex:1 0 auto;min-height:240px}',
      '.tb-col{display:flex;flex-direction:column;gap:8px;min-width:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:9px 9px 11px;min-height:220px;height:100%}',
      '.tb-col[data-status=archived]{opacity:.92}',
      '.tb-colhead{display:flex;align-items:center;gap:7px;padding:1px 1px 5px;border-bottom:1px solid var(--dsw-alias-border-l1);height:31px;box-sizing:border-box}',
      // 列头高度固定：只有「已完成」列带「全部归档」按钮（24px 高），其它列只有文字（14px 行高）。
      // 不固定时 flex 行高被按钮撑大 ~10px，导致「已完成」标题和整列卡片都比别的列低一截。
      '.tb-page[data-narrow=true] .tb-colhead{height:29px}',
      '.tb-coldot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--tb-accent)}',
      '.tb-colname{font:var(--dsw-font-xxs-strong-12);font-weight:600;letter-spacing:.01em}',
      '.tb-colcount{min-width:18px;height:18px;padding:0 5px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:color-mix(in srgb,var(--tb-accent) 16%,transparent);color:var(--tb-accent);font:var(--dsw-font-xxxs-strong-11);font-variant-numeric:tabular-nums}',
      '.tb-colhead-actions{margin-left:auto;display:flex;align-items:center;gap:4px}',
      '.tb-cards{display:flex;flex-direction:column;gap:8px;min-height:0}',
      '.tb-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:14px 10px;text-align:center;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11);line-height:1.6}',

      // ── 卡片 ───────────────────────────────────────────────────
      // 卡片正文只有标题 + 操作按钮：note / result / lastError / meta 全部收进详情浮层，
      // 看板上只靠标题辨认任务（完整信息点标题看详情）。
      '.tb-card{display:flex;flex-direction:column;gap:6px;padding:9px 10px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--tb-accent);border-radius:var(--dsw-radius-sm);min-width:0;box-sizing:border-box}',
      '.tb-card-title{font:var(--dsw-font-xxs-strong-12);font-weight:600;line-height:1.45;word-break:break-word}',
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
      // 右栏 tab 的关闭按钮由宿主 dockkit chrome 渲染（本插件只提供正文与 chip）：宿主 CSS 会在
      // tab active / focus-within 时强制显示关闭按钮。这里只收紧带本插件标题(.tb-tabtitle)的 tab——
      // 非悬停且非键盘聚焦时隐藏，悬停/聚焦时仍由宿主规则显示；:has 不被支持时整条规则被忽略，退回宿主行为。
      '[data-dockkit-tab]:has(.tb-tabtitle):not(:hover):not(:focus-within) [data-dockkit-tab-close]{opacity:0!important;pointer-events:none!important}',
      // 宿主在 hover / active 时用「标题右侧 30px 渐隐遮罩」给关闭按钮让位，而本插件 tab
      // 只有内容宽（图标 + 任务看板 ≈ 71px）——遮罩从标题 41px 处开始，会把「板」吃掉。
      // 比拉宽 tab 更省空间的做法：给 tab 右侧留出关闭按钮的 26px，并关掉这个遮罩；
      // tab 只比原宽 +7px（≈100→107），标题完整、× 落在右侧留白里。
      // 同时把宿主给 tab 的 min-width:80 放开（content-box 下它会让 tab 至少 80+padding 宽）。
      '[data-dockkit-tab]:has(.tb-tabtitle){min-width:0;padding-right:24px}',
      '[data-dockkit-tab]:has(.tb-tabtitle) [data-dockkit-tab-title]{mask-image:none!important}',

      // ── 右栏窄面板：lane 纵向堆叠 ──────────────────────────────
      '.tb-lanes{display:flex;flex-direction:column;gap:10px;min-height:0;flex:1 0 auto}',
      '.tb-page{position:relative}',
      // 页面是唯一滚动容器：flex 子项默认 flex-shrink:1 会把看板压到 min-height，
      // 内容从里面溢出、盖住页脚；这里统一禁止收缩，让 .tb-page 的 overflow-y:auto 生效。
      '.tb-page > *{flex-shrink:0}',
      '.tb-card-titlebtn{cursor:pointer}',
      '.tb-card-titlebtn:hover{text-decoration:underline}',
      // ── 任务详情浮层 ─────────────────────────────────────────
      '.tb-detail-mask{position:fixed;inset:0;z-index:9000;background:rgba(8,12,20,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto;animation:tb-fade-in .12s ease-out}',
      '@keyframes tb-fade-in{from{opacity:0}to{opacity:1}}',
      '.tb-detail{width:100%;max-width:900px;max-height:calc(100vh - 48px);display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 28px 72px rgba(0,0,0,.42);animation:tb-pop-in .14s ease-out}',
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
      '.tb-detail-row-wide{grid-column:1 / -1;align-items:center}',
      '.tb-detail-row-wide .tb-detail-sessions{margin:0}',
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
      '.tb-rich .tb-rich-img{display:block;max-width:100%;height:auto;margin:6px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base)}',
      '.tb-rich .tb-rich-attachment{display:inline-block;padding:1px 7px;border:1px dashed var(--dsw-alias-border-l2);border-radius:4px;color:var(--dsw-alias-label-secondary,#68707d);font:var(--dsw-font-xxxs-11)}',
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
      // 中/宽布局的空列占位在剩余高度里垂直居中（窄栏 lane 保持紧凑，不加高）。
      '.tb-page[data-narrow=false] .tb-col > .tb-empty{flex:1 1 auto;display:flex;align-items:center;justify-content:center}',
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

      // ── 组长条（主会话 / 工作区组长，v0.2.0）────────────────────
      '.tb-leads{display:flex;align-items:center;gap:2px 10px;flex-wrap:wrap;padding:7px 10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);font:var(--dsw-font-xxxs-11);min-width:0}',
      '.tb-lead{display:inline-flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap}',
      '.tb-lead + .tb-lead{padding-left:10px;border-left:1px solid var(--dsw-alias-border-l1)}',
      '.tb-lead-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-success-primary)}',
      '.tb-lead-dot[data-status=busy]{background:var(--dsw-alias-state-warn-primary)}',
      '.tb-lead-dot[data-status=offline],.tb-lead-dot[data-status=missing],.tb-lead-dot[data-status=archived]{background:var(--dsw-alias-label-tertiary)}',
      '.tb-lead-label{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px}',
      '.tb-lead-state{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.tb-lead-hint{flex-basis:100%;color:var(--dsw-alias-label-tertiary);line-height:1.45}',
      '.tb-lead-btn{height:22px;padding:0 8px}',
      '.tb-page[data-narrow=true] .tb-leads{padding:5px 8px;gap:2px 8px}',
      '.tb-page[data-narrow=true] .tb-lead-label{max-width:160px}',


      // ── 待你处理（v0.2.2，§1.9）────────────────────────────────
      // 右栏顶部条：只在有 flagged 任务时渲染；这些任务不重复出现在下面的 lane / 四列。
      '.tb-needs{position:sticky;top:0;z-index:3;display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,transparent);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,var(--dsw-alias-bg-base))}',
      '.tb-needs-head{display:flex;align-items:center;gap:6px}',
      '.tb-needs-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary);flex:0 0 auto}',
      '.tb-needs-name{font:var(--dsw-font-xxs-strong-12);font-weight:600}',
      '.tb-needs-count{min-width:18px;height:18px;padding:0 5px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground);font:var(--dsw-font-xxxs-strong-11);font-variant-numeric:tabular-nums}',
      '.tb-needs-list{display:flex;flex-direction:column;gap:4px}',
      '.tb-needs-item{display:flex;flex-direction:column;gap:1px;width:100%;padding:5px 7px;text-align:left;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit}',
      '.tb-needs-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tb-needs-item:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.tb-needs-title{font:var(--dsw-font-xxs-strong-12);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tb-needs-q{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // 平台看板第五列（放在「待开始」之前；没有 flagged 任务时整列不渲染，仍是四列）。
      '.tb-board[data-needs=true]{grid-template-columns:repeat(5,minmax(0,1fr))}',
      '.tb-col[data-status=needsUser]{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);border-radius:var(--dsw-radius-md);padding:9px 9px 11px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,var(--dsw-alias-bg-layer-1))}',
      '.tb-needs-card-q{margin:4px 0 0;font:var(--dsw-font-xxxs-11);line-height:1.5;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.tb-needs-card .tb-card-actions{margin-top:6px}',
      // 详情浮层的「需要你处理」区（问题 / 选项 / 自由输入 / 回复并继续 / 最近回答）。
      '.tb-detail-needs{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);border-radius:var(--dsw-radius-md);padding:9px 11px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent);gap:7px}',
      '.tb-needs-question{margin:0;font:var(--dsw-font-xs-12);line-height:1.6;white-space:pre-wrap;word-break:break-word}',
      '.tb-needs-options{display:flex;flex-wrap:wrap;gap:6px}',
      '.tb-answer{min-height:60px;height:auto}',
      '.tb-detail-needs-actions{display:flex;justify-content:flex-end;gap:8px}',
      '.tb-needs-error{margin:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-error-primary)}',
      '.tb-needs-hint{margin:0;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}',
      '.tb-detail-lastanswer{margin:0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-skeleton);font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}',
      // 独立红色角标：与 todo 角标同一形状，放在按钮 / 图标的另一角，不抢 todo 数字。
      '.tb-badge-needs{top:auto;bottom:-3px;right:-5px;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}',
      '.tb-page[data-layout=narrow] .tb-needs{padding:7px 8px}',
      '.tb-page[data-layout=narrow] .tb-needs-item{padding:4px 5px}',

      // ── Apple 风格皮肤（最后追加，覆盖上面的基础样式）──────────
      // 设计参照 macOS / iOS：灰色画布 + 白色卡片、发丝分隔线、胶囊按钮、系统字体、柔和阴影。
      // 颜色全部走宿主主题 token，深色模式自动跟随。
      // 令牌挂在 body 上：宿主主题的 --dsw-alias-* 就定义在 body 作用域（:root 上取不到）。
      'body{--tb-surface:var(--dsw-alias-bg-base);--tb-canvas:color-mix(in srgb,var(--dsw-alias-bg-base) 94%,#000);--tb-tint:color-mix(in srgb,var(--dsw-alias-bg-base) 90%,#000);--tb-hairline:var(--dsw-alias-border-l2);--tb-hairline-soft:var(--dsw-alias-border-l1);--tb-text:var(--dsw-alias-label-primary);--tb-text-2:var(--dsw-alias-label-secondary);--tb-text-3:var(--dsw-alias-label-tertiary);--tb-accent:var(--dsw-alias-state-business-primary,#0071e3);--tb-danger:var(--dsw-alias-state-error-primary,#ec1313);--tb-pill:980px;--tb-shadow-1:0 1px 2px rgba(15,17,21,.05),0 8px 22px rgba(15,17,21,.06);--tb-shadow-2:0 14px 40px rgba(15,17,21,.14)}',
      // 页面
      // 灰色底座四边留白：宽度/高度都让出 2 倍边距，避免出现多余滚动条
      '.tb-page{gap:12px;background:var(--tb-canvas);border-radius:16px;padding:14px;width:calc(100% - 24px);height:calc(100% - 24px);margin:12px}',
      '.tb-page[data-narrow=true]{width:calc(100% - 14px);height:calc(100% - 14px);margin:7px;padding:10px;border-radius:14px}',
      // 主区看板：窗口变窄时自动降列（平台页不经过面板宽度测量）
      '@media (max-width:1180px){.tb-platform .tb-board{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (max-width:820px){.tb-platform .tb-optional{display:none}.tb-platform .tb-head{flex-direction:column;align-items:stretch}.tb-platform .tb-head-side{justify-content:flex-start}}',
      '@media (max-width:620px){.tb-platform .tb-board{grid-template-columns:minmax(0,1fr)}}',
      '.tb-title{font:600 17px/1.3 var(--dsh-font-family-text-default,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);color:var(--tb-text);letter-spacing:-.01em}',
      '.tb-sub{color:var(--tb-text-2);font-size:11.5px}',
      '.tb-head{gap:8px}',
      '.tb-head-side{gap:6px}',
      // 输入 / 下拉
      '.tb-input,.tb-select{height:28px;border-radius:8px;border:1px solid var(--tb-hairline);background:var(--tb-surface);color:var(--tb-text);font-size:11.5px;padding:0 9px;box-shadow:none;transition:border-color .15s ease,box-shadow .15s ease}',
      '.tb-input:focus,.tb-select:focus{outline:0;border-color:var(--tb-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--tb-accent) 22%,transparent)}',
      '.tb-input::placeholder{color:var(--tb-text-3)}',
      // 胶囊按钮
      '.tb-btn{height:27px;padding:0 12px;border:1px solid transparent;border-radius:var(--tb-pill);background:var(--dsw-alias-bg-skeleton);color:var(--tb-text);font:500 11.5px/1 var(--dsh-font-family-text-default,-apple-system,sans-serif);letter-spacing:0;box-shadow:none;transition:background .15s ease,color .15s ease,opacity .15s ease,transform .1s ease}',
      '.tb-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--tb-text)}',
      '.tb-btn:active{transform:scale(.98)}',
      '.tb-btn:disabled{opacity:.4;cursor:not-allowed}',
      '.tb-btn-sm{height:24px;padding:0 10px;font-size:11px}',
      '.tb-btn-primary{background:var(--tb-accent);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}',
      '.tb-btn-primary:hover{background:var(--tb-accent);filter:brightness(.94);color:#fff}',
      '.tb-btn-ghost{background:transparent;color:var(--tb-text-2)}',
      '.tb-btn-ghost:hover{background:var(--dsw-alias-bg-skeleton);color:var(--tb-text)}',
      '.tb-btn-danger{background:transparent;color:var(--tb-danger)}',
      '.tb-btn-danger:hover{background:color-mix(in srgb,var(--tb-danger) 12%,transparent);color:var(--tb-danger)}',
      // 提示条
      '.tb-banner{border:1px solid var(--tb-hairline-soft);border-radius:11px;background:var(--tb-surface);box-shadow:var(--tb-shadow-1);font-size:11.5px;color:var(--tb-text-2);padding:8px 10px}',
      '.tb-notice{border:1px dashed var(--tb-hairline);border-radius:11px;background:var(--tb-surface);color:var(--tb-text-2)}',
      // 看板：灰画布上的列 + 白色卡片
      '.tb-board{gap:12px;min-height:0}',
      '.tb-col{background:transparent;border:0;border-radius:0;padding:0 1px;gap:8px;box-shadow:none}',
      '.tb-colhead{gap:6px;padding:2px 2px 0}',
      '.tb-coldot{width:7px;height:7px;border-radius:50%;box-shadow:none}',
      '.tb-colname{font:600 12px/1.3 var(--dsh-font-family-text-default,-apple-system,sans-serif);color:var(--tb-text-2);letter-spacing:0}',
      '.tb-colcount{background:var(--dsw-alias-bg-skeleton);color:var(--tb-text-3);border-radius:999px;padding:0 6px;font:500 10px/16px var(--dsh-font-family-text-default,-apple-system,sans-serif);height:16px;min-width:16px;text-align:center}',
      '.tb-cards{gap:8px}',
      '.tb-card{background:var(--tb-surface);border:1px solid var(--tb-hairline-soft);border-left:1px solid var(--tb-hairline-soft);border-radius:var(--dsw-radius-md,12px);padding:10px 11px;box-shadow:var(--tb-shadow-1);transition:box-shadow .18s ease,transform .18s ease,border-color .18s ease}',
      '.tb-card:hover{box-shadow:var(--tb-shadow-2);border-color:var(--tb-hairline);transform:translateY(-1px)}',
      '.tb-card-title{font:600 12.5px/1.45 var(--dsh-font-family-text-default,-apple-system,sans-serif);color:var(--tb-text);letter-spacing:0}',
      '.tb-empty{color:var(--tb-text-3);font-size:11px;padding:12px 6px;text-align:center;border:0;background:transparent}',
      '.tb-foot{color:var(--tb-text-3);font-size:10px;padding-top:2px;border-top:1px solid var(--tb-hairline-soft)}',
      '.tb-foot code{background:var(--dsw-alias-bg-skeleton);border-radius:5px;padding:1px 5px;font-size:9.5px}',
      '.tb-wsname{color:var(--tb-text-2);font-size:10.5px}',
      '.tb-toolbar-filter,.tb-toolbar-count{color:var(--tb-text-3);font-size:10.5px}',
      // 组长条：与卡片同一套表面（颜色全部走官方 --dsw-* 主题变量）
      '.tb-leads{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:7px 10px;box-shadow:var(--tb-shadow-1)}',
      '.tb-lead + .tb-lead{border-left-color:var(--dsw-alias-border-l1)}',
      '.tb-lead-label{color:var(--dsw-alias-label-secondary)}',
      '.tb-lead-state,.tb-lead-hint{color:var(--dsw-alias-label-tertiary)}',
      // 组长条按钮与同行文字统一字体/字号/行高/字重：按钮默认 500 字重 + 另一套
      // 字体族 + line-height:1，会让「打开」「把当前对话设为主会话」比「组长 · xxx」
      // 低约 1px（上下不齐）。这里改成完全继承组长条正文排版。
      '.tb-leads .tb-lead-btn{font-family:inherit;font-size:inherit;font-weight:400;line-height:inherit}',
      // 详情浮层：灰色画布 + 白色分组卡片
      '.tb-detail-mask{background:rgba(15,17,21,.28);backdrop-filter:blur(12px) saturate(140%);padding:20px}',
      '.tb-detail{background:var(--tb-surface);border:1px solid var(--tb-hairline);border-radius:18px;box-shadow:0 30px 90px rgba(15,17,21,.28)}',
      '.tb-detail-head{padding:16px 18px 12px;border-bottom:1px solid var(--tb-hairline-soft);background:var(--tb-surface)}',
      '.tb-detail-title{font:600 15px/1.35 var(--dsh-font-family-text-default,-apple-system,sans-serif);color:var(--tb-text)}',
      '.tb-detail-close{border-radius:50%;color:var(--tb-text-2);background:var(--dsw-alias-bg-skeleton)}',
      '.tb-detail-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--tb-text)}',
      '.tb-detail-body{background:var(--tb-canvas);padding:12px;gap:10px}',
      '.tb-detail-section{background:var(--tb-surface);border:1px solid var(--tb-hairline-soft);border-radius:var(--dsw-radius-md,12px);padding:10px 12px;gap:6px}',
      '.tb-detail-sub{font:600 10.5px/1.4 var(--dsh-font-family-text-default,-apple-system,sans-serif);color:var(--tb-text-3);letter-spacing:.03em;text-transform:none}',
      '.tb-detail-grid dt{color:var(--tb-text-3)}',
      '.tb-detail-grid dd{color:var(--tb-text)}',
      '.tb-detail-text{background:transparent;padding:0;border-radius:0;color:var(--tb-text);font-size:12px;line-height:1.65;max-height:none;overflow:visible}',
      '.tb-detail-result{max-height:none;overflow:visible;border-left:0;background:transparent;padding:0}',
      '.tb-detail-result-filled{border-left:0}',
      '.tb-detail-result[data-status=doing]{border-left:0}',
      '.tb-detail-muted{color:var(--tb-text-3)}',
      '.tb-detail-error{color:var(--tb-danger);background:transparent;padding:0}',
      '.tb-detail-sessions .tb-btn{border-radius:var(--tb-pill)}',
      '.tb-detail-chip{background:var(--dsw-alias-bg-skeleton);border-radius:6px;color:var(--tb-text-2);font-size:10px;padding:2px 7px}',
      '.tb-statusbadge{border-radius:var(--tb-pill);font-size:10px;font-weight:600;padding:2px 9px 2px 7px;background:var(--dsw-alias-bg-skeleton);color:var(--tb-text-2)}',
      '.tb-statusbadge[data-status=todo]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}',
      '.tb-statusbadge[data-status=doing]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.tb-statusbadge[data-status=done]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 15%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.tb-statusbadge[data-status=archived]{background:var(--dsw-alias-bg-skeleton);color:var(--tb-text-3)}',
      '.tb-timeline{background:transparent;padding:2px 0 0;border-radius:0}',
      '.tb-timeline-label{color:var(--tb-text-3);font-size:10px}',
      '.tb-timeline-value{color:var(--tb-text);font-size:12px}',
      '.tb-timeline-item{border-left:1px solid var(--tb-hairline-soft)}',
      '.tb-timeline-item:first-child{border-left:0}',
      '.tb-detail-actions{background:var(--tb-surface);border-top:1px solid var(--tb-hairline-soft);padding:10px 16px}',
      // 富文本：Apple 风格的表格 / 代码
      '.tb-rich .tb-rich-tablewrap{border:1px solid var(--tb-hairline-soft);border-radius:10px;background:var(--tb-surface);max-height:none}',
      '.tb-rich .tb-rich-table th{background:var(--tb-tint);color:var(--tb-text-2);border-bottom:1px solid var(--tb-hairline);font-weight:600}',
      '.tb-rich .tb-rich-table td{border-bottom:1px solid var(--tb-hairline-soft)}',
      '.tb-rich code{background:var(--tb-tint);border:0;border-radius:5px;color:var(--tb-text);padding:1px 5px}',
      '.tb-rich .tb-rich-code{background:var(--tb-tint);border:1px solid var(--tb-hairline-soft);border-radius:10px;color:var(--tb-text)}',
      '.tb-rich .tb-rich-code code{background:transparent;padding:0}',
      '.tb-rich .tb-rich-h{color:var(--tb-text);font-weight:600}',
      '.tb-rich .tb-rich-quote{border-left:3px solid var(--tb-hairline);color:var(--tb-text-2);background:transparent;padding:2px 10px}',
      '.tb-rich .tb-rich-hr{border-top:1px solid var(--tb-hairline-soft)}',
      '.tb-rich a{color:var(--dsw-alias-link,var(--tb-accent));text-decoration:none}',
      '.tb-rich a:hover{text-decoration:underline}',

      // ── 卡片精简 + 等高（t-33 / t-42）────────────────────────────
      // 卡片正文只剩标题，高度由内容决定（t-42 去掉了整卡 min-height:108px + 操作行
      // margin-top:auto——那两条会把 2 行标题的卡片撑高，多余高度全变成标题与按钮之间的空行）。
      // 等高改用「标题固定 2 行高度」：1 行标题与 2 行标题的标题块都是 2.8em（12.5px × 1.4 × 2
      // = 35px），标题与操作行之间只留 .tb-card-fixed 的 gap:5px，不再有整块空行。
      // 窄栏按钮换 2 行时卡片会变高（不裁按钮的取舍）；标题 2 行截断（line-clamp），
      // 全文放 title 属性；行内编辑态不带 .tb-card-fixed，高度自适应。
      '.tb-card-fixed{gap:5px;padding:9px 10px 8px}',
      '.tb-card-fixed .tb-card-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.8em;line-height:1.4;word-break:break-word}',
      '.tb-card-fixed .tb-card-actions{gap:3px 4px;padding-top:0}',
      '.tb-card-fixed .tb-card-actions .tb-btn{height:22px;padding:0 7px;font-size:10.5px}',
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
      'dispatch.mode.workspace-lead': '工作区组长（推荐）',
      'dispatch.mode.new': '新对话',
      'dispatch.mode.creator': '回发起对话',
      'dispatch.mode.auto': '空闲会话',
      'dispatch.modeHint': '工作区组长：任务交给所属工作区的常驻组长执行（推荐）；新对话：每个任务在它自己的工作区新开一个对话执行；回发起对话：派回创建它的那个对话；空闲会话：自动挑一个空闲会话。',
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
      'composer.uploading': '图片上传中…',
      'composer.removeImage': '移除图片',
      'composer.imageTooMany': '一次最多粘贴 {n} 张图片，请分次粘贴',
      'composer.imageTooLarge': '单张图片不能超过 {mb} MB，已跳过 {n} 张',
      'composer.attachmentTooMany': '一条任务最多 {max} 个图片附件（当前 {n} 个）',
      'composer.imageFailed': '读取剪贴板图片失败',
      'composer.autoHint': '加进「待开始」后由主 Agent 自动接手，你只管加任务和看结论。',
      'composer.autoHintWorkspace': '加进「待开始」后由主 Agent 自动接手；任务会回到本对话执行（工作区：{name}）。',
      'composer.empty': '先写任务标题',
      'detail.imageLoading': '图片加载中…',
      'detail.imageFailed': '图片不可用',
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
      'card.deleteConfirmShort': '确认删除',
      'card.detail': '详情',
      'card.openChat': '对话',
      'detail.sessions': '关联对话',
      'detail.creatorSession': '发起对话',
      'detail.runSession': '执行对话',
      'detail.leadSession': '组长对话',
      'detail.noSession': '（这条任务还没有关联对话）',
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
      'detail.id': '任务 id',
      'detail.note': '备注 / 验收标准',
      'detail.result': '完成结论',
      'detail.error': '最近错误',
      'detail.emptyNote': '（没有备注）',
      'detail.emptyResult': '任务已完成，但主 Agent 还没有写结论。',
      'detail.emptyResultPending': '任务还没完成，完成后主 Agent 会把结论写在这里。',
      'detail.close': '关闭',
      'card.ago.now': '刚刚',
      'card.ago.min': '{n} 分钟前',
      'card.ago.hour': '{n} 小时前',
      'card.ago.day': '{n} 天前',
      'banner.presetMissing': '没有找到「任务看板 · 工作区组长（自动）」：{reason}',
      'banner.presetBroken': '任务看板 · 工作区组长（自动）加载失败：{reason}',
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
      // v0.2.0 workspace-lead 路由的跳过原因（poll.lastSkipReason）
      'poll.skip.lead-busy': '工作区组长正在运行，等它空下来再派',
      'poll.skip.lead-unavailable': '工作区组长不可用：稍后重试，或在看板点「创建组长」',
      'poll.skip.lead-no-workspace': '无法解析任务的工作区：请从目标工作区的会话里重新加这条任务',

      // v0.2.0 组长条 / 主会话绑定
      'lead.barLabel': '组长条',
      'lead.mainLabel': '主会话 · {title}',
      'lead.mainFallback': '主会话',
      'lead.unbound': '未绑定主会话',
      'lead.bind': '把当前对话设为主会话',
      'lead.rebind': '换绑',
      'lead.clear': '解除绑定',
      'lead.open': '打开',
      'lead.wsLabel': '组长 · {label}',
      'lead.wsFallback': '工作区',
      'lead.create': '创建组长',
      'lead.status.online': '在线',
      'lead.status.busy': '忙',
      'lead.status.offline': '离线',
      'lead.status.missing': '未创建',
      'lead.status.archived': '已归档',
      'lead.noCurrentSession': '拿不到当前会话 id：先在这个对话里打开右侧栏看板，再绑定主会话',
      'lead.bindOk': '已把当前对话设为主会话',
      'lead.clearOk': '已解除主会话绑定',
      'lead.ensureOk': '已创建工作区组长',
      'detail.lead': '组长',
      'detail.noLead': '（还没有组长）',

      // v0.2.2「待你处理」（§1.9）：组长提问 → 看板提示 → 用户回答 → 任务继续
      'column.needsUser': '待你处理',
      'needsUser.title': '需要你处理',
      'needsUser.question': '需要你回答的问题',
      'needsUser.answerPlaceholder': '输入你的回答（≤{max} 字）…',
      'needsUser.submit': '回复并继续',
      'needsUser.badge': '{n} 条待你处理',
      'needsUser.open': '处理',
      'needsUser.lastAnswer': '最近回答',
      'needsUser.answerOk': '已回复，任务继续处理',
      'needsUser.answerFailed': '回复发送失败：{message}',
      'needsUser.answerEmpty': '先写回答再提交',
      'needsUser.answerTooLong': '回答不能超过 {max} 字',
      'needsUser.pickOption': '点上面的选项可以填入输入框，也可以自己写。',
    }

    const DICT_EN = {
      'panel.label': 'Task board',
      'guide.description': 'The board lives in this right sidebar: todo / in progress / done / archived, and the main agent dispatches todo tasks for you.',
      'action.openBoard': 'Open task board (right sidebar)',
      'page.title': 'Task board',
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
      'dispatch.mode.workspace-lead': 'Workspace lead (recommended)',
      'dispatch.mode.new': 'New chat',
      'dispatch.mode.creator': 'Creator chat',
      'dispatch.mode.auto': 'Idle chat',
      'dispatch.modeHint': 'Workspace lead: hand the task to the resident lead of its workspace (recommended); New chat: start a fresh conversation in the task workspace; Creator chat: reuse the conversation that created it; Idle chat: pick any idle conversation.',
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
      'composer.uploading': 'Uploading image…',
      'composer.removeImage': 'Remove image',
      'composer.imageTooMany': 'At most {n} images per paste; paste them in smaller batches',
      'composer.imageTooLarge': 'Each image must be {mb} MB or smaller; skipped {n}',
      'composer.attachmentTooMany': 'At most {max} image attachments per task (currently {n})',
      'composer.imageFailed': 'Could not read the clipboard image',
      'composer.autoHint': 'The main agent picks up new todo tasks automatically — just add tasks and read the results.',
      'composer.autoHintWorkspace': 'The main agent picks this up automatically and runs it back in this conversation (workspace: {name}).',
      'composer.empty': 'Title is required',
      'detail.imageLoading': 'Loading image…',
      'detail.imageFailed': 'Image unavailable',
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
      'card.deleteConfirmShort': 'Confirm delete',
      'card.detail': 'Details',
      'card.openChat': 'Chat',
      'detail.sessions': 'Linked conversations',
      'detail.creatorSession': 'Created in',
      'detail.runSession': 'Dispatched to',
      'detail.leadSession': 'Lead conversation',
      'detail.noSession': '(this task has no linked conversation yet)',
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
      'detail.id': 'Task id',
      'detail.note': 'Note / acceptance',
      'detail.result': 'Result',
      'detail.error': 'Last error',
      'detail.emptyNote': '(no note)',
      'detail.emptyResult': 'Task is done but the main agent has not written a result yet.',
      'detail.emptyResultPending': 'Not finished yet; the main agent writes the result here when done.',
      'detail.close': 'Close',
      'card.ago.now': 'just now',
      'card.ago.min': '{n} min ago',
      'card.ago.hour': '{n} h ago',
      'card.ago.day': '{n} d ago',
      'banner.presetMissing': 'Task-board workspace-lead mode not found: {reason}',
      'banner.presetBroken': 'Task-board workspace-lead mode failed to load: {reason}',
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
      // v0.2.0 workspace-lead routing skip reasons (poll.lastSkipReason)
      'poll.skip.lead-busy': 'The workspace lead is running; it will retry once it is idle',
      'poll.skip.lead-unavailable': 'The workspace lead is unavailable: retry later, or click Create lead on the board',
      'poll.skip.lead-no-workspace': 'Cannot resolve the task workspace: re-add this task from a conversation inside the target workspace',

      // v0.2.0 lead bar / main-session binding
      'lead.barLabel': 'Team leads',
      'lead.mainLabel': 'Main · {title}',
      'lead.mainFallback': 'Main',
      'lead.unbound': 'Main session not bound',
      'lead.bind': 'Set this chat as main session',
      'lead.rebind': 'Rebind',
      'lead.clear': 'Unbind',
      'lead.open': 'Open',
      'lead.wsLabel': 'Lead · {label}',
      'lead.wsFallback': 'workspace',
      'lead.create': 'Create lead',
      'lead.status.online': 'online',
      'lead.status.busy': 'busy',
      'lead.status.offline': 'offline',
      'lead.status.missing': 'not created',
      'lead.status.archived': 'archived',
      'lead.noCurrentSession': 'Current session id is unavailable: open this board from a conversation first, then bind the main session',
      'lead.bindOk': 'This conversation is now the main session',
      'lead.clearOk': 'Main session unbound',
      'lead.ensureOk': 'Workspace lead created',
      'detail.lead': 'Lead',
      'detail.noLead': '(no lead yet)',

      // v0.2.2 needs-user loop (§1.9)
      'column.needsUser': 'Needs you',
      'needsUser.title': 'Needs your answer',
      'needsUser.question': 'Question for you',
      'needsUser.answerPlaceholder': 'Type your answer (≤{max} chars)…',
      'needsUser.submit': 'Reply and continue',
      'needsUser.badge': '{n} waiting for you',
      'needsUser.open': 'Answer',
      'needsUser.lastAnswer': 'Last answer',
      'needsUser.answerOk': 'Answer sent; the task continues',
      'needsUser.answerFailed': 'Could not send the answer: {message}',
      'needsUser.answerEmpty': 'Write an answer first',
      'needsUser.answerTooLong': 'The answer must be at most {max} chars',
      'needsUser.pickOption': 'Click an option to fill the box, or write your own answer.',
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

    /**
     * 恢复平台看板的工作区选择（两处共用：顶部「工作区」过滤 = `config.workspaceFilter`，
     * 新建行「任务所属工作区」= `config.workspaceDraft`；各自独立持久化、互不串值）：
     *  - `stored` 为空 / 字段缺失 / 脏数据（非字符串）→ `''`（过滤 = 全部工作区、新建行 = 未选择，
     *    都是未持久化时的默认选择）；
     *  - `stored` 命中当前工作区列表（`samePath` 归一化比较）→ 返回注册表里的规范 path；
     *  - `stored` 非空但已不在列表里（工作区被删 / 改名）→ `''`（回退默认，不把无效值当选中项）；
     *  - 工作区列表为空（注册表还没就绪）→ `null`，调用方应等下一条 snapshot 再判定，
     *    别把「列表暂时为空」误判成「工作区已删除」而覆盖用户选择。
     */
    function resolveWorkspaceSelection(stored, workspaces) {
      const value = typeof stored === 'string' ? stored.trim() : ''
      if (value === '') return ''
      const list = (Array.isArray(workspaces) ? workspaces : []).filter(
        (item) => item && typeof item.path === 'string' && item.path !== '',
      )
      if (list.length === 0) return null
      const hit = list.find((item) => samePath(item.path, value))
      return hit ? hit.path : ''
    }

    // 会话 id 形如 session-xxxxxxxx…：取尾部更可区分（头部对每个会话都一样）。
    function shortSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return '–'
      return sessionId.length > 8 ? sessionId.slice(-8) : sessionId
    }

    // 会话 id 只认两种形态：`session-<id>`（宿主会话）与裸 UUID（宿主 `subagentId` 就是会话 UUID）。
    // 任务 `assignee` 是自由文本，组长也可能写 `worker-42` / `main` 这类普通标签，那些不是会话。
    const SESSION_ID_PATTERN = /^(?:session-[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    // 从自由文本里找会话 id token 用：不带锚点，但两侧边界不能是 `[A-Za-z0-9_-]`（见 extractSessionId）。
    const SESSION_TOKEN_PATTERN = /session-[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
    const SESSION_TOKEN_EDGE = /[A-Za-z0-9_-]/

    /** 整串就是会话 id（严格判定，不做提取）。 */
    function looksLikeSessionId(value) {
      return typeof value === 'string' && SESSION_ID_PATTERN.test(value.trim())
    }

    /**
     * 从 `assignee` 这类自由文本里提取第一个会话 id（t-39 增量）：
     * 组长常把 id 写成 `5a6b…（worker）` / `… (worker)` / `…@worker` / `worker: …`，
     * 整串严格匹配会漏掉 → 卡片回退组长会话。这里按 token 扫描，返回 id 本身（保留原始大小写）。
     * 边界：token 前后不能紧邻 `[A-Za-z0-9_-]`，所以 `worker-42` / `main` / 中文标签 /
     * `session-`（dash 后没有 id）/ 被别的词粘住的片段都不算会话，返回空串。
     */
    function extractSessionId(value) {
      if (typeof value !== 'string') return ''
      const text = value.trim()
      if (text === '') return ''
      if (looksLikeSessionId(text)) return text
      SESSION_TOKEN_PATTERN.lastIndex = 0
      let match = SESSION_TOKEN_PATTERN.exec(text)
      while (match !== null) {
        const end = match.index + match[0].length
        const before = match.index > 0 ? text.charAt(match.index - 1) : ''
        const after = end < text.length ? text.charAt(end) : ''
        if (!SESSION_TOKEN_EDGE.test(before) && !SESSION_TOKEN_EDGE.test(after)) return match[0]
        match = SESSION_TOKEN_PATTERN.exec(text)
      }
      return ''
    }

    /**
     * 任务真正的「执行对话」（worker 子会话）：组长直聊派活时把 worker 会话 id 写进 `task.assignee`（§1.8），
     * 但 `assignee` 也可能是普通标签 —— 只有文本里能提取到会话 id 时才返回，否则返回空串（不当会话打开）。
     */
    function workerSessionOf(task) {
      if (!task || typeof task !== 'object') return ''
      return extractSessionId(task.assignee)
    }

    /* ── v0.2.0 组长条（主会话 / 工作区组长）纯展示函数 ───────── */

    // 「派发到」的四个合法值：v0.2.0 起默认 workspace-lead（缺省 / 未知一律回退它，不要回退 new）。
    const DISPATCH_MODES = ['workspace-lead', 'new', 'creator', 'auto']

    function dispatchModeOf(config) {
      const mode = config && typeof config.dispatchMode === 'string' ? config.dispatchMode : ''
      return DISPATCH_MODES.indexOf(mode) >= 0 ? mode : 'workspace-lead'
    }

    /** 组长 / 主会话状态点：missing（没有会话/未创建）/ offline（离线）/ busy（忙）/ online（在线）。 */
    function leadStatusKey(lead) {
      if (!lead || typeof lead !== 'object') return 'missing'
      const sessionId = typeof lead.sessionId === 'string' ? lead.sessionId : ''
      if (sessionId === '') return 'missing'
      // 会话被归档：dsh 的归档门会拒绝它跑模型步进，任何调度都无效（v0.2.1）。
      if (lead.archived === true) return 'archived'
      // 没有 live 字段（旧 Host / 数据不完整）按离线处理，不误报绿点。
      if (lead.live !== true) return 'offline'
      if (lead.busy === true) return 'busy'
      return 'online'
    }

    /** 主会话 / 组长展示名：title 取尾部 8 个字符，空串用 fallback（主会话的回退文案是「主会话」）。 */
    function leadTitleTail(title, fallback) {
      const text = typeof title === 'string' ? title.trim() : ''
      const tail = text === '' ? '' : text.length > 8 ? text.slice(-8) : text
      if (tail !== '') return tail
      return typeof fallback === 'string' ? fallback : ''
    }

    /** 组长条的主会话一行：未绑定（leads.main 为 null）返回 null。 */
    function leadMainRow(leads) {
      const main = leads && typeof leads === 'object' ? leads.main : null
      if (!main || typeof main !== 'object') return null
      const sessionId = typeof main.sessionId === 'string' ? main.sessionId : ''
      if (sessionId === '') return null
      return {
        sessionId,
        title: typeof main.title === 'string' ? main.title : '',
        status: leadStatusKey(main),
      }
    }

    /** 任务卡片 / 详情的「组长」文案：优先 dispatchedSessionTitle，其次会话 id 尾 8；都没有返回空串。 */
    function taskLeadLabel(task) {
      if (!task || typeof task !== 'object') return ''
      const title = typeof task.dispatchedSessionTitle === 'string' ? task.dispatchedSessionTitle.trim() : ''
      if (title !== '') return title
      const sessionId = typeof task.dispatchedSessionId === 'string' ? task.dispatchedSessionId : ''
      return sessionId !== '' ? shortSession(sessionId) : ''
    }

    /** 看板可见任务涉及的工作区路径（去重；当前会话工作区排最前，保证没有任务也能「创建组长」）。 */
    function taskWorkspaceCwds(tasks, currentCwd) {
      const out = []
      const push = (cwd) => {
        if (typeof cwd !== 'string' || cwd === '') return
        if (out.some((item) => samePath(item, cwd))) return
        out.push(cwd)
      }
      push(currentCwd)
      for (const task of Array.isArray(tasks) ? tasks : []) {
        if (task) push(task.cwd)
      }
      return out
    }

    /**
     * 组长条的工作区行（数据来自 Snapshot.leads，运行时视图）：
     *  - all=true（完整看板）：列出 snapshot.leads.workspaces 全部条目；
     *  - all=false（右栏本工作区看板）：只列当前看板可见任务涉及的工作区
     *    （task.cwd 归一化 / 工作区 id 与组长条目的 cwd / key 比对，兼容两者），
     *    没有组长的补一行 missing，让用户能点「创建组长」（ensure-workspace-lead）。
     */
    function workspaceLeadRows(leads, cwds, options) {
      const all = !!(options && options.all)
      const list = leads && Array.isArray(leads.workspaces) ? leads.workspaces : []
      const wanted = (Array.isArray(cwds) ? cwds : []).filter((cwd) => typeof cwd === 'string' && cwd !== '')
      const rows = []
      const seen = []
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue
        const key = typeof entry.key === 'string' ? entry.key : ''
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
        if (!all) {
          const matches = wanted.some(
            (want) => samePath(want, cwd) || (key !== '' && samePath(want, key)),
          )
          if (!matches) continue
        }
        const status = leadStatusKey(entry)
        rows.push({
          key: key !== '' ? key : cwd,
          label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : baseName(cwd),
          cwd,
          sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
          title: typeof entry.title === 'string' ? entry.title : '',
          status,
          missing: status === 'missing',
        })
        if (cwd !== '') seen.push(cwd)
      }
      if (!all) {
        for (const cwd of wanted) {
          if (seen.some((item) => samePath(item, cwd))) continue
          rows.push({
            key: normalizePath(cwd),
            label: baseName(cwd),
            cwd,
            sessionId: '',
            title: '',
            status: 'missing',
            missing: true,
          })
          seen.push(cwd)
        }
      }
      return rows
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

    /* ── 粘贴图片附件（v0.2.0）纯函数 ─────────────────────────── */

    // note 里的短引用固定为 ![image](attachment://<uuid>)（契约见 docs/architecture.md §2.1）。
    const ATTACHMENT_ID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    const ATTACHMENT_REF_PATTERN = new RegExp('!\\[[^\\]]*\\]\\(attachment:\\/\\/(' + ATTACHMENT_ID_SOURCE + ')\\)', 'g')
    const MAX_PASTE_IMAGES = 4
    /** 详情浮层的附件 data URL 缓存上限（单任务最多 8 个引用；超出按插入顺序淘汰最旧的）。 */
    const MAX_ATTACHMENT_CACHE = 8
    /** 单张图片上限（与服务端 MAX_ATTACHMENT_BYTES 同值，§2.1）：粘贴前按 file.size 预检，超限不发请求。 */
    const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
    const MAX_ATTACHMENT_MB = MAX_ATTACHMENT_BYTES / (1024 * 1024)
    /** 单条任务 note 里最多几个不同附件引用（与服务端 MAX_TASK_ATTACHMENTS 同值，§2.1）。 */
    const MAX_NOTE_ATTACHMENTS = 8

    function attachmentRef(id) {
      return '![image](attachment://' + String(id) + ')'
    }

    /** 从若干段文本里按出现顺序取出去重的附件 id。 */
    function attachmentIdsIn() {
      const ids = []
      for (let i = 0; i < arguments.length; i += 1) {
        const text = arguments[i]
        if (typeof text !== 'string' || text === '') continue
        ATTACHMENT_REF_PATTERN.lastIndex = 0
        let match
        while ((match = ATTACHMENT_REF_PATTERN.exec(text)) !== null) {
          if (ids.indexOf(match[1]) === -1) ids.push(match[1])
        }
      }
      return ids
    }

    /** 在备注末尾追加短引用（不重复追加同一 id）。 */
    function insertAttachmentRef(note, id) {
      const text = typeof note === 'string' ? note : ''
      const ref = attachmentRef(id)
      if (text.indexOf(ref) !== -1) return text
      const head = text.replace(/\s+$/, '')
      return head === '' ? ref : head + '\n' + ref
    }

    /** 删除备注里的某个短引用（用于移除待提交图片）。 */
    function removeAttachmentRef(note, id) {
      const text = typeof note === 'string' ? note : ''
      const ref = attachmentRef(id)
      const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return text
        .replace(new RegExp(escaped, 'g'), '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }

    /**
     * 粘贴图片预算：先按单图大小上限（file.size 预检）剔除超限图片——超限的图不上传、不发请求，
     * 免得撞上 7 MB 请求体上限后只显示「网络错误」；再按一次粘贴最多 MAX_PASTE_IMAGES 张截断。
     * 返回 { accepted, tooLarge, skipped }。
     */
    function splitPasteImages(files) {
      const list = Array.isArray(files) ? files : []
      const withinSize = []
      let tooLarge = 0
      for (const file of list) {
        const size = file && typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : 0
        if (size > MAX_ATTACHMENT_BYTES) {
          tooLarge += 1
          continue
        }
        withinSize.push(file)
      }
      const accepted = withinSize.slice(0, MAX_PASTE_IMAGES)
      return { accepted, tooLarge, skipped: withinSize.length - accepted.length }
    }

    /** 上传计数 > 0：连续多次粘贴时只有全部结束才解除禁用（§5.2）。 */
    function isUploading(count) {
      return typeof count === 'number' && Number.isFinite(count) && count > 0
    }

    /** 提交闸门：Enter 与提交按钮共用（上传中 / 忙 / 标题空 / 平台看板未选工作区都不提交）。 */
    function submitBlocked(flags) {
      const value = flags || {}
      if (isUploading(value.uploading)) return true
      if (value.busy) return true
      if (typeof value.title !== 'string' || value.title.trim() === '') return true
      return value.workspaceRequired === true
    }

    /** note 里不同附件引用数超限时的具体提示（与服务端 bad-request 文案同源，§2.1）；未超限返回 ''。 */
    function noteAttachmentLimitText(t, note) {
      const count = attachmentIdsIn(note).length
      if (count <= MAX_NOTE_ATTACHMENTS) return ''
      return t('composer.attachmentTooMany', { max: MAX_NOTE_ATTACHMENTS, n: count })
    }

    /** 剪贴板事件里的图片文件（没有图片时返回空数组，调用方保持浏览器默认粘贴行为）。 */
    function clipboardImageFiles(event) {
      const clipboard = event && event.clipboardData
      const files = []
      const items = clipboard && clipboard.items
      if (items && typeof items.length === 'number') {
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i]
          if (!item || item.kind !== 'file' || !/^image\//i.test(typeof item.type === 'string' ? item.type : '')) continue
          const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
          if (file) files.push(file)
        }
      }
      // 部分浏览器只填 clipboardData.files（没有 items）：补一条兜底。
      if (files.length === 0 && clipboard && clipboard.files && typeof clipboard.files.length === 'number') {
        for (let i = 0; i < clipboard.files.length; i += 1) {
          const file = clipboard.files[i]
          if (file && /^image\//i.test(typeof file.type === 'string' ? file.type : '')) files.push(file)
        }
      }
      return files
    }

    /** File → data URL（优先 FileReader；测试 / 极简环境退回 arrayBuffer + btoa）。 */
    function fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        if (typeof FileReader === 'function') {
          try {
            const reader = new FileReader()
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
            reader.onerror = () => reject(reader.error || new Error('read failed'))
            reader.readAsDataURL(file)
          } catch (error) {
            reject(error)
          }
          return
        }
        if (file && typeof file.arrayBuffer === 'function' && typeof btoa === 'function') {
          Promise.resolve(file.arrayBuffer()).then((buffer) => {
            const bytes = new Uint8Array(buffer)
            let binary = ''
            const step = 0x8000
            for (let i = 0; i < bytes.length; i += step) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
            }
            resolve('data:' + (typeof file.type === 'string' && file.type !== '' ? file.type : 'image/png') + ';base64,' + btoa(binary))
          }, reject)
          return
        }
        reject(new Error('FileReader unavailable'))
      })
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

    /**
     * 行内格式：**粗体**、`代码`、[链接](url)、![图片](attachment://<id>)。
     * options.attachment(id) 返回 {status:'ready',src} / {status:'loading'|'failed'}；
     * 图片引用由详情浮层按需拉取，加载中 / 失败显示占位文本。
     */
    function renderInline(text, keyPrefix, options) {
      const nodes = []
      const pattern = /(!\[[^\]]*\]\(attachment:\/\/[0-9a-f-]{36}\)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/
      const parts = String(text).split(pattern)
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        if (part === '') continue
        if (part.startsWith('![') && part.includes('](') && part.endsWith(')')) {
          const close = part.indexOf('](')
          const alt = part.slice(2, close)
          const href = part.slice(close + 2, -1)
          const id = href.slice('attachment://'.length)
          const hit = options && typeof options.attachment === 'function' ? options.attachment(id) : null
          if (hit && typeof hit.src === 'string' && hit.src !== '') {
            nodes.push(h('img', { key: keyPrefix + 'i' + i, className: 'tb-rich-img', src: hit.src, alt: alt || '', loading: 'lazy' }))
          } else {
            const failed = hit && hit.status === 'failed'
            nodes.push(
              h(
                'span',
                { key: keyPrefix + 'i' + i, className: 'tb-rich-attachment' },
                (failed ? options && options.attachmentFailedText : options && options.attachmentLoadingText) || '',
              ),
            )
          }
        } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
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

    /** 把解析结果渲染成 React 节点（两块看板的详情浮层共用）。 */
    function renderRichText(text, options) {
      const blocks = parseRichText(text)
      return blocks.map((block, index) => {
        const key = 'b' + index
        if (block.type === 'heading') {
          return h(
            'h4',
            { key, className: 'tb-rich-h', 'data-level': String(block.level) },
            renderInline(block.text, key + '_', options),
          )
        }
        if (block.type === 'hr') return h('hr', { key, className: 'tb-rich-hr' })
        if (block.type === 'quote') {
          return h('blockquote', { key, className: 'tb-rich-quote' }, renderInline(block.text, key + '_', options))
        }
        if (block.type === 'code') {
          return h('pre', { key, className: 'tb-rich-code' }, h('code', null, block.lines.join('\n')))
        }
        if (block.type === 'list') {
          return h(
            block.ordered ? 'ol' : 'ul',
            { key, className: 'tb-rich-list' },
            block.items.map((item, itemIndex) => h('li', { key: key + '_' + itemIndex }, renderInline(item, key + '_' + itemIndex + '_', options))),
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
                      renderInline(cell, key + 'h' + cellIndex + '_', options),
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
                      h('td', { key: key + 'c' + cellIndex }, renderInline(cell, key + 'r' + rowIndex + 'c' + cellIndex + '_', options)),
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
          if (lineText.trim() !== '') children.push(h('span', { key: key + 'l' + lineIndex }, renderInline(lineText, key + 'l' + lineIndex + '_', options)))
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

    /**
     * v0.2.2（§1.9）：派生「待你处理」任务列表——`needsUser === true`、排除已归档，
     * 按 `askedAt` 升序（等得最久的排最前；缺 / 坏 `askedAt` 的排最后，再按 id）。
     */
    function needsUserTasks(tasks) {
      return (Array.isArray(tasks) ? tasks : [])
        .filter((task) => task && task.needsUser === true && task.status !== 'archived')
        .slice()
        .sort((a, b) => {
          const at = Date.parse(typeof a.askedAt === 'string' ? a.askedAt : '')
          const bt = Date.parse(typeof b.askedAt === 'string' ? b.askedAt : '')
          const aOk = Number.isFinite(at)
          const bOk = Number.isFinite(bt)
          if (aOk && bOk && at !== bt) return at - bt
          if (aOk !== bOk) return aOk ? -1 : 1
          return String(a.id).localeCompare(String(b.id))
        })
    }

    /**
     * v0.2.2：普通四列 / lane 用的任务——未归档的 flagged 任务只在「待你处理」区出现，不重复；
     * 已归档的 flagged 任务不在「待你处理」派生列表里（needsUserTasks 排除 archived），
     * 所以照常留在「已归档」列，避免任务凭空消失。
     */
    function withoutNeedsUser(tasks) {
      return (Array.isArray(tasks) ? tasks : []).filter(
        (task) => !task || task.needsUser !== true || task.status === 'archived',
      )
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

      /** 附件上传错误：bad-request 保留宿主的具体原因（MIME / 大小上限），其它走通用 i18n。 */
      function attachmentErrorText(t, error) {
        if (error && error.code === 'bad-request' && typeof error.message === 'string' && error.message !== '') return error.message
        return errorText(t, error)
      }

      /**
       * 备注 textarea 的 paste 处理：有图片就上传并把短引用插进备注；没有图片返回 false，
       * 调用方不 preventDefault，普通文本粘贴保持浏览器默认行为。
       * opts: { t, setNote, setPending, beginUpload, endUpload, setNotice }
       *
       * 三条边界（§5.2）：
       *  1. `file.size` 预检——单图 > 5 MB 直接提示、不发请求（避免撞 7 MB 请求体后只剩「网络错误」）；
       *  2. 上传用计数（beginUpload / endUpload）——连续多次粘贴时不会提前解除提交禁用；
       *  3. 逐项 catch——单个文件读取 / 上传失败不丢弃同批已成功的图片（否则会留孤儿附件 + 丢用户输入）。
       */
      function handleNotePaste(event, opts) {
        const files = clipboardImageFiles(event)
        if (files.length === 0) return false
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        const budget = splitPasteImages(files)
        if (budget.tooLarge > 0) {
          opts.setNotice({
            tone: 'warn',
            text: opts.t('composer.imageTooLarge', { mb: MAX_ATTACHMENT_MB, n: budget.tooLarge }),
          })
        }
        if (budget.accepted.length === 0) return true
        if (typeof opts.beginUpload === 'function') opts.beginUpload()
        const uploads = budget.accepted.map((file) =>
          fileToDataUrl(file).then(
            (dataUrl) =>
              callRpc('upload-attachment', {
                dataUrl,
                name: typeof file.name === 'string' ? file.name : '',
              }).then((res) => ({ res, dataUrl })),
            (error) => ({ res: null, error }),
          ),
        )
        Promise.all(uploads)
          .then(
            (pairs) => {
              const uploaded = []
              let firstError = null
              for (const pair of pairs) {
                if (pair.error) {
                  if (!firstError) firstError = { code: 'internal', message: String((pair.error && pair.error.message) || pair.error) }
                  continue
                }
                const res = pair.res
                if (res && res.ok === true && res.value && typeof res.value.id === 'string' && res.value.id !== '') {
                  uploaded.push(Object.assign({}, res.value, { preview: pair.dataUrl }))
                } else if (!firstError) {
                  firstError = (res && res.error) || { code: 'internal', message: 'malformed upload response' }
                }
              }
              if (uploaded.length > 0) {
                opts.setPending((prev) => prev.concat(uploaded))
                opts.setNote((prev) => uploaded.reduce((text, item) => insertAttachmentRef(text, item.id), prev))
              }
              if (firstError) opts.setNotice({ tone: 'error', text: attachmentErrorText(opts.t, firstError) })
              else if (budget.tooLarge === 0 && budget.skipped > 0) {
                opts.setNotice({ tone: 'warn', text: opts.t('composer.imageTooMany', { n: MAX_PASTE_IMAGES }) })
              }
            },
            (error) => {
              opts.setNotice({
                tone: 'error',
                text: opts.t('composer.imageFailed') + (error && error.message ? '：' + error.message : ''),
              })
            },
          )
          .then(() => {
            if (typeof opts.endUpload === 'function') opts.endUpload()
          })
        return true
      }

      /** 详情浮层按需拉取 note / result 里的附件（同一 id 只请求一次；失败下次打开再试）。 */
      function loadTaskAttachments(task, sourcesRef, setSources) {
        const ids = attachmentIdsIn(task && task.note, task && task.result)
        if (ids.length === 0) return
        const current = sourcesRef.current || {}
        const loading = []
        const next = Object.assign({}, current)
        for (const id of ids) {
          const existing = current[id]
          if (existing && existing.status !== 'failed') continue
          next[id] = { status: 'loading' }
          loading.push(id)
        }
        if (loading.length === 0) return
        sourcesRef.current = next
        setSources(next)
        for (const id of loading) {
          callRpc('attachment', { id }).then((res) => {
            const value = res && res.ok === true ? res.value : null
            const entry =
              value && typeof value.dataUrl === 'string' && value.dataUrl !== ''
                ? { status: 'ready', src: value.dataUrl }
                : { status: 'failed' }
            const updated = Object.assign({}, sourcesRef.current, { [id]: entry })
            // 上限淘汰（§5.2）：只淘汰已就绪的最旧条目——刚更新的这张不能挤掉自己，
            // 还在飞的 loading 占位也不能删（删了会重复发请求，且占位会闪成「加载中」）。
            let overflow = Object.keys(updated).length - MAX_ATTACHMENT_CACHE
            if (overflow > 0) {
              for (const key of Object.keys(updated)) {
                if (overflow <= 0) break
                const item = updated[key]
                if (key === id || !item || item.status === 'loading') continue
                delete updated[key]
                overflow -= 1
              }
            }
            sourcesRef.current = updated
            setSources(updated)
          })
        }
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
      // 最近一次渲染过的对话会话 id：根作用域的平台看板（main）拿不到 session 绑定，
      // 用会话 header / 右栏看板渲染时记下的值当「当前对话」；拿不到就禁用主会话绑定并提示。
      let lastConversationSessionId = ''

      /** 在看板里直接跳到某个会话（发起对话 / 执行对话）。 */
      function openSessionById(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (!uiWorkspaceService || typeof uiWorkspaceService.openSession !== 'function') {
          console.warn('[dsh-dispatch-board] uiWorkspace 不可用，无法跳转会话：' + sessionId)
          return
        }
        try {
          uiWorkspaceService.openSession(sessionId)
        } catch (error) {
          console.warn('[dsh-dispatch-board] 跳转会话失败：' + describeErr(error))
        }
      }

      function openBoard(retry = 0) {
        if (!sidebarRightService) {
          console.warn('[dsh-dispatch-board] 打开右侧看板失败：右侧栏服务不可用（需要部署里的 ui-sidebar-right）')
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
          console.warn('[dsh-dispatch-board] 打开右侧看板失败：' + (error && error.message ? error.message : error))
        }
      }

      /**
       * 「再点一次收起」的判定：右栏已展开、且当前活动 tab 就是本插件的看板页时，返回该 TabRecord
       * （用它的 id 调 hide），否则返回 null。
       *
       * 只看右栏公开 API（0.2.2-rc.1 的 `ISidebarRight`：`active()` / `isExpanded()` / `hide(tabId)`）；
       * 任一 API 缺失或抛错都当作「没开」，让点击继续走 openBoard —— 收起是锦上添花，
       * 绝不能把打开这条主路径挡掉。`TabRecord` 的形状实测为 `{ id, kind, title, contentId }`，
       * 本插件注册的页类型 kind 就是 TAB_KIND（见 §5.0）。
       */
      function expandedBoardTab() {
        if (!sidebarRightService) return null
        if (typeof sidebarRightService.active !== 'function') return null
        if (typeof sidebarRightService.isExpanded !== 'function') return null
        try {
          if (sidebarRightService.isExpanded() !== true) return null
        } catch (error) {
          return null
        }
        try {
          const tab = sidebarRightService.active()
          if (tab && typeof tab === 'object' && tab.kind === TAB_KIND && typeof tab.id === 'string') return tab
        } catch (error) {
          /* 读不到活动 tab 就按「没开」处理 */
        }
        return null
      }

      /**
       * header 图标：看板已展开且在眼前 → 收起（docked 折叠整列 / floating 关闭浮层，tab 本身保留，
       * 下次点开还在）；其它情况（没开 / 已收起 / 活动 tab 是别的）→ 照常 openTab 打开并聚焦。
       */
      function toggleBoard(retry = 0) {
        const tab = expandedBoardTab()
        if (tab && sidebarRightService && typeof sidebarRightService.hide === 'function') {
          try {
            sidebarRightService.hide(tab.id)
            return
          } catch (error) {
            // 收起失败不该变成「点了没反应」：下面照常打开。
            console.warn('[dsh-dispatch-board] 收起右侧看板失败：' + (error && error.message ? error.message : error))
          }
        }
        openBoard(retry)
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
        // 顺手记下当前对话 id（幂等赋值）：根作用域的平台看板靠它绑定主会话，拿不到就禁用按钮。
        if (sessionId !== '') lastConversationSessionId = sessionId
        const [pending, setPending] = useState(-1)
        // v0.2.2（§1.9）：待你处理数量单独一个红色角标（与 todo 角标并存、互不干扰）。
        const [needsCount, setNeedsCount] = useState(-1)
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
              // 与右栏看板（banner / 四列）用同一个过滤：cwd 属于本工作区，或任务创建于本对话。
              // 只按 cwd 过滤会让「banner 有、header 角标为 0」——旧任务 / 工具建的任务可能没有 cwd。
              // sessionId 缺失（理论上宿主不会这样渲染）时退回全量，与旧行为一致。
              const visible =
                sessionId === '' ? res.value.tasks : tasksForWorkspace(res.value.tasks, cwdRef.current, sessionId)
              let count = 0
              let needs = 0
              for (const task of visible) {
                // flagged 任务算「待你处理」，不算 todo 待办（两枚角标不重复计数）。
                if (task.needsUser === true && task.status !== 'archived') {
                  needs += 1
                  continue
                }
                if (task.status !== 'todo') continue
                count += 1
              }
              setPending(count)
              setNeedsCount(needs)
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
        const needsBadge = needsCount > 0 ? (needsCount > 99 ? '99+' : String(needsCount)) : null
        const tip =
          t('panel.label') +
          (pending > 0 ? ' · ' + t('badge.label', { n: pending }) : '') +
          (needsCount > 0 ? ' · ' + t('needsUser.badge', { n: needsCount }) : '')

        return h(
          'button',
          {
            type: 'button',
            className: 'tb-headbtn',
            title: tip,
            'aria-label': t('action.openBoard'),
            // 不用 openBoard 直连：onClick 会把事件对象当第一个参数传进去（retry 失效），
            // 而且这里要走「已展开就收起」的 toggle。
            onClick: () => toggleBoard(),
          },
          h(BoardGlyph, { size: 16 }),
          badge === null ? null : h('span', { className: 'tb-badge', 'aria-hidden': 'true' }, badge),
          needsBadge === null
            ? null
            : h('span', { className: 'tb-badge tb-badge-needs', 'aria-hidden': 'true' }, needsBadge),
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
         * 老版本 Host 派发的进行中任务没记 dispatchedSessionId，用 snapshot.poll 的最近派发兜底
         * （仅当同时只有一条 doing 任务时，避免张冠李戴）。兜底会话是「派发到哪个会话」，即组长会话。
         */
        function pollFallbackSessionOf(task) {
          if (!task) return ''
          const fallback = typeof bind.fallbackDispatchSessionId === 'string' ? bind.fallbackDispatchSessionId : ''
          if (fallback === '') return ''
          if (task.status !== 'doing') return ''
          const lastDispatchTaskId = typeof bind.lastDispatchTaskId === 'string' ? bind.lastDispatchTaskId : ''
          if (lastDispatchTaskId === '' || lastDispatchTaskId === task.id) return fallback
          return ''
        }

        /** 组长会话：`dispatchedSessionId`，其次老 Host 的 poll 兜底。 */
        function leadSessionOf(task) {
          if (!task) return ''
          const dispatched = typeof task.dispatchedSessionId === 'string' ? task.dispatchedSessionId : ''
          return dispatched !== '' ? dispatched : pollFallbackSessionOf(task)
        }

        /**
         * 任务关联的会话（卡片「对话」按钮的跳转目标），优先级：
         * worker 子会话（真正执行任务的对话）→ 组长会话（dispatchedSessionId）→ 发起对话（sessionId）
         * → 老 Host 的 poll 兜底（doing）。没有 worker 时组长会话不再冒充「执行对话」，但仍是卡片的首选跳转。
         */
        function sessionOf(task) {
          if (!task) return ''
          const worker = workerSessionOf(task)
          if (worker !== '') return worker
          if (typeof task.dispatchedSessionId === 'string' && task.dispatchedSessionId !== '') return task.dispatchedSessionId
          if (typeof task.sessionId === 'string' && task.sessionId !== '') return task.sessionId
          return pollFallbackSessionOf(task)
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

        /**
         * 右栏看板顶部的「待你处理」条（v0.2.2，§1.9）：只读 bind.needsUserTasks，
         * 空列表返回 null（整块不渲染，不是空态盒子）。点条目打开详情浮层的回答区。
         */
        function NeedsBanner() {
          const t = bind.t
          const list = Array.isArray(bind.needsUserTasks) ? bind.needsUserTasks : []
          if (list.length === 0) return null
          const actions = bind.actions
          return h(
            'section',
            { className: 'tb-needs', role: 'region', 'aria-label': t('column.needsUser') },
            h(
              'header',
              { className: 'tb-needs-head' },
              h('span', { className: 'tb-needs-dot', 'aria-hidden': 'true' }),
              h('span', { className: 'tb-needs-name' }, t('column.needsUser')),
              h('span', { className: 'tb-needs-count' }, String(list.length)),
            ),
            h(
              'div',
              { className: 'tb-needs-list' },
              list.map((task) =>
                h(
                  'button',
                  {
                    key: task.id,
                    type: 'button',
                    className: 'tb-needs-item',
                    title: (task.title || '') + '\n' + (task.question || ''),
                    onClick: () => actions.openDetail(task),
                  },
                  h('span', { className: 'tb-needs-title' }, task.title || ''),
                  h('span', { className: 'tb-needs-q' }, task.question || ''),
                ),
              ),
            ),
          )
        }

        /**
         * 平台看板的第五列「待你处理」（v0.2.2，§1.9）：放在「待开始」之前，仅非空时由调用方渲染。
         * 卡片显示标题 + 问题一行 + 「处理」按钮（需要用户阅读，是纯标题卡的例外）；
         * 点标题 / 「处理」都打开详情浮层的回答区。
         */
        function NeedsColumn(props) {
          const t = bind.t
          const list = props && Array.isArray(props.tasks) ? props.tasks : []
          const actions = bind.actions
          return h(
            'section',
            {
              className: 'tb-col tb-needs-col',
              'data-status': 'needsUser',
              'aria-label': t('column.needsUser'),
            },
            h(
              'header',
              { className: 'tb-colhead', style: { '--tb-accent': STATUS_ACCENT.needsUser } },
              h('span', { className: 'tb-coldot', 'aria-hidden': 'true' }),
              h('span', { className: 'tb-colname' }, t('column.needsUser')),
              h('span', { className: 'tb-colcount' }, String(list.length)),
            ),
            h(
              'div',
              { className: 'tb-cards' },
              list.map((task) =>
                h(
                  'article',
                  {
                    key: task.id,
                    className: 'tb-card tb-card-fixed tb-needs-card',
                    style: { '--tb-accent': STATUS_ACCENT.needsUser },
                  },
                  h(
                    'div',
                    {
                      className: 'tb-card-title tb-card-titlebtn',
                      role: 'button',
                      tabIndex: 0,
                      title: task.title,
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
                  h('div', { className: 'tb-needs-card-q', title: task.question || '' }, task.question || ''),
                  h(
                    'div',
                    { className: 'tb-card-actions' },
                    h(
                      'button',
                      { type: 'button', className: 'tb-btn tb-btn-sm tb-btn-primary', onClick: () => actions.openDetail(task) },
                      t('needsUser.open'),
                    ),
                  ),
                ),
              ),
            ),
          )
        }

        function Card(props) {
          const t = bind.t
          const busy = bind.busy
          const editing = bind.editing
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
                  h('button', { type: 'button', className: 'tb-btn tb-btn-sm tb-btn-primary', disabled: busy !== '', onClick: () => actions.saveEdit() }, t('card.save')),
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

          // 卡片只留标题 + 操作按钮：note / result / lastError / id / 工作区 / 时间 /
          // 执行者 / 组长这些背景信息都在详情浮层里看（点标题或「详情」）。
          // 少这一整段后卡片高度由内容决定（.tb-card-fixed 的标题固定 2 行高度 +
          // 标题/按钮之间只留 gap，不再用整卡 min-height + 操作行 margin-top:auto 撑空行）。

          cardActions.unshift(['detail', () => actions.openDetail(task), false])
          // 卡片「对话」优先 worker 子会话（真正干活的对话），其次组长 / 发起对话；title 用实际目标 id 便于辨认。
          const cardSessionId = sessionOf(task)
          if (cardSessionId !== '') {
            cardActions.push(['openChat', () => actions.openSession(cardSessionId), false, cardSessionId])
          }

          return h(
            'article',
            { className: 'tb-card tb-card-fixed', style: { '--tb-accent': STATUS_ACCENT[status] } },
            h(
              'div',
              {
                className: 'tb-card-title tb-card-titlebtn',
                role: 'button',
                tabIndex: 0,
                // 标题 2 行截断，title 属性兜住全文（鼠标悬停可看完整标题）
                title: task.title,
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
                    // 可选第 4 项：按钮 title（「对话」按钮用实际跳转的会话 id）。
                    title: entry[3],
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
          const richOptions = {
            attachment: (id) => (typeof bind.attachmentOf === 'function' ? bind.attachmentOf(id) : null),
            attachmentLoadingText: t('detail.imageLoading'),
            attachmentFailedText: t('detail.imageFailed'),
          }
          // v0.2.2「待你处理」：回答区读看板组件的草稿 / 错误 / 忙态（浮层不持有 state）。
          const needsOptions = task.needsUser === true && Array.isArray(task.questionOptions) ? task.questionOptions : []
          const answerDraft = typeof bind.answerDraft === 'string' ? bind.answerDraft : ''
          const answerError = typeof bind.answerError === 'string' ? bind.answerError : ''
          const answerBusyKey = 'answer:' + task.id
          const metaRows = [
            [t('detail.workspace'), task.cwd || '—'],
            [t('detail.lead'), taskLeadLabel(task) || t('detail.noLead')],
            [t('detail.assignee'), task.assignee || t('detail.assigneeAuto')],
            [t('detail.source'), task.source === 'agent' ? t('detail.sourceAgent') : t('detail.sourceUser')],
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
          // 「关联对话」：发起（sessionId）/ 执行（worker assignee）/ 组长（dispatchedSessionId / poll 兜底），
          // 各自可点；同一个会话只显示一次（worker 可能等于发起会话，组长会话也可能等于发起会话）。
          const creatorSession = typeof task.sessionId === 'string' ? task.sessionId : ''
          const workerSession = workerSessionOf(task)
          const leadSession = leadSessionOf(task)
          const detailSessions = []
          if (creatorSession !== '') {
            detailSessions.push({ key: 'creator', label: t('detail.creatorSession'), sessionId: creatorSession })
          }
          if (workerSession !== '' && workerSession !== creatorSession) {
            detailSessions.push({ key: 'worker', label: t('detail.runSession'), sessionId: workerSession })
          }
          if (leadSession !== '' && leadSession !== workerSession && leadSession !== creatorSession) {
            detailSessions.push({ key: 'lead', label: t('detail.leadSession'), sessionId: leadSession })
          }
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
                // v0.2.2「待你处理」：问题 / 选项 / 自由输入 / 回复并继续 / 最近回答（§1.9）。
                // 草稿与错误状态放在看板组件里（经 bind 传入），浮层本身不调 hooks。
                task.needsUser
                  ? h(
                      'section',
                      { className: 'tb-detail-section tb-detail-needs' },
                      h('h3', { className: 'tb-detail-sub' }, t('needsUser.title')),
                      h('p', { className: 'tb-needs-question', 'aria-label': t('needsUser.question') }, task.question || ''),
                      needsOptions.length > 0
                        ? h(
                            'div',
                            { className: 'tb-needs-options' },
                            needsOptions.map((option) =>
                              h(
                                'button',
                                {
                                  key: option,
                                  type: 'button',
                                  className: 'tb-btn tb-btn-sm',
                                  disabled: bind.busy === answerBusyKey,
                                  onClick: () => bind.actions.setAnswerDraft(option),
                                },
                                option,
                              ),
                            ),
                          )
                        : null,
                      h('textarea', {
                        className: 'tb-textarea tb-answer',
                        placeholder: t('needsUser.answerPlaceholder', { max: 1000 }),
                        'aria-label': t('needsUser.answerPlaceholder', { max: 1000 }),
                        value: answerDraft,
                        onChange: (event) => bind.actions.setAnswerDraft(event.target.value),
                      }),
                      answerError ? h('p', { className: 'tb-needs-error', role: 'alert' }, answerError) : null,
                      h('p', { className: 'tb-needs-hint' }, t('needsUser.pickOption')),
                      h(
                        'div',
                        { className: 'tb-detail-needs-actions' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'tb-btn tb-btn-sm tb-btn-primary',
                            disabled: bind.busy === answerBusyKey || answerDraft.trim() === '',
                            onClick: () => bind.actions.submitAnswer(task.id),
                          },
                          t('needsUser.submit'),
                        ),
                      ),
                    )
                  : null,
                // v0.2.2：回答留档不依赖当前是否 flagged——回答成功后 needsUser 已清，
                // 详情仍要能看到「最近回答」（组长 / 用户回看任务时的重要上下文）。
                task.lastAnswer
                  ? h(
                      'section',
                      { className: 'tb-detail-section tb-detail-answer' },
                      h('h3', { className: 'tb-detail-sub' }, t('needsUser.lastAnswer')),
                      h('p', { className: 'tb-detail-lastanswer' }, task.lastAnswer),
                    )
                  : null,
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
                      ? renderRichText(task.result, richOptions)
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
                    task.note ? renderRichText(task.note, richOptions) : t('detail.emptyNote'),
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
                    h(
                      'div',
                      { className: 'tb-detail-row' },
                      h('dt', null, t('detail.sessions')),
                      h(
                        'dd',
                        null,
                        h(
                          'div',
                          { className: 'tb-detail-sessions' },
                          detailSessions.length === 0
                            ? h('span', { className: 'tb-detail-muted' }, t('detail.noSession'))
                            : detailSessions.map((entry) =>
                                h(
                                  'button',
                                  {
                                    key: entry.key,
                                    type: 'button',
                                    className: 'tb-btn tb-btn-sm',
                                    title: entry.sessionId,
                                    onClick: () => props.openSession(entry.sessionId),
                                  },
                                  entry.label + ' · ' + shortSession(entry.sessionId),
                                ),
                              ),
                        ),
                      ),
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

        /**
         * 组长条（两块看板共用，v0.2.0）：主会话绑定状态 + 当前看板涉及的工作区组长。
         * 数据来自 snapshot.leads（运行时视图：组长启停 / 忙闲变化不 bump revision，所以每次渲染都读最新快照）；
         * 动作走 v0.2.0 RPC：bind-main-session / clear-main-session / ensure-workspace-lead。
         */
        function LeadBar() {
          const t = bind.t
          const busy = typeof bind.busy === 'string' ? bind.busy : ''
          const busyNow = busy !== ''
          const currentSessionId = typeof bind.currentSessionId === 'string' ? bind.currentSessionId : ''
          const leads = bind.leads && typeof bind.leads === 'object' ? bind.leads : null
          const main = leadMainRow(leads)
          const rows = Array.isArray(bind.leadRows) ? bind.leadRows : []
          const actions = bind.leadActions || {}
          const bindHint = currentSessionId === '' ? t('lead.noCurrentSession') : t('lead.bind')
          const dot = (status) =>
            h('span', { key: 'dot', className: 'tb-lead-dot', 'data-status': status, 'aria-hidden': 'true' })
          const stateText = (status) =>
            h('span', { key: 'state', className: 'tb-lead-state' }, t('lead.status.' + status))
          const bindButton = (labelKey, key) =>
            h(
              'button',
              {
                key,
                type: 'button',
                className: 'tb-btn tb-btn-sm tb-btn-ghost tb-lead-btn',
                disabled: busyNow || currentSessionId === '',
                title: bindHint,
                onClick: () => {
                  if (typeof actions.bindMain === 'function') actions.bindMain()
                },
              },
              t(labelKey),
            )

          const mainBits = []
          if (main) {
            mainBits.push(dot(main.status))
            mainBits.push(
              h(
                'span',
                { key: 'label', className: 'tb-lead-label', title: main.title || main.sessionId },
                t('lead.mainLabel', { title: leadTitleTail(main.title, t('lead.mainFallback')) }),
              ),
            )
            mainBits.push(stateText(main.status))
            mainBits.push(
              h(
                'button',
                {
                  key: 'open',
                  type: 'button',
                  className: 'tb-btn tb-btn-sm tb-btn-ghost tb-lead-btn',
                  title: main.sessionId,
                  onClick: () => {
                    if (typeof actions.openSession === 'function') actions.openSession(main.sessionId)
                  },
                },
                t('lead.open'),
              ),
            )
            mainBits.push(bindButton('lead.rebind', 'rebind'))
            mainBits.push(
              h(
                'button',
                {
                  key: 'clear',
                  type: 'button',
                  className: 'tb-btn tb-btn-sm tb-btn-ghost tb-lead-btn',
                  disabled: busyNow,
                  onClick: () => {
                    if (typeof actions.clearMain === 'function') actions.clearMain()
                  },
                },
                t('lead.clear'),
              ),
            )
          } else {
            mainBits.push(dot('missing'))
            mainBits.push(h('span', { key: 'label', className: 'tb-lead-label' }, t('lead.unbound')))
            mainBits.push(bindButton('lead.bind', 'bind'))
            if (currentSessionId === '') {
              mainBits.push(h('span', { key: 'hint', className: 'tb-lead-hint' }, t('lead.noCurrentSession')))
            }
          }

          const cells = [
            h(
              'div',
              {
                key: 'main',
                className: 'tb-lead tb-lead-main',
                'data-status': main ? main.status : 'missing',
                title: main ? main.title || main.sessionId : '',
              },
              mainBits,
            ),
          ]
          rows.forEach((row) => {
            const bits = [
              dot(row.status),
              h(
                'span',
                { key: 'label', className: 'tb-lead-label', title: row.cwd || row.sessionId || '' },
                t('lead.wsLabel', { label: row.label || t('lead.wsFallback') }),
              ),
              stateText(row.status),
            ]
            if (row.missing || row.status === 'archived') {
              bits.push(
                h(
                  'button',
                  {
                    key: 'create',
                    type: 'button',
                    className: 'tb-btn tb-btn-sm tb-btn-ghost tb-lead-btn',
                    disabled: busyNow || row.cwd === '',
                    title: row.cwd,
                    onClick: () => {
                      if (typeof actions.ensureLead === 'function') actions.ensureLead(row.cwd)
                    },
                  },
                  t('lead.create'),
                ),
              )
            } else {
              bits.push(
                h(
                  'button',
                  {
                    key: 'open',
                    type: 'button',
                    className: 'tb-btn tb-btn-sm tb-btn-ghost tb-lead-btn',
                    disabled: row.sessionId === '',
                    title: row.sessionId,
                    onClick: () => {
                      if (typeof actions.openSession === 'function') actions.openSession(row.sessionId)
                    },
                  },
                  t('lead.open'),
                ),
              )
            }
            cells.push(
              h('div', { key: 'ws:' + row.key, className: 'tb-lead tb-lead-ws', 'data-status': row.status }, bits),
            )
          })
          return h('div', { className: 'tb-leads', role: 'group', 'aria-label': t('lead.barLabel') }, cells)
        }

        return { Banner, Col, Detail, LeadBar, NeedsBanner, NeedsColumn }
      }

      /* ── 看板页 ─────────────────────────────────────────────── */

      /**
       * 右侧栏里的看板 tab。窄栏（普通右栏）用「按状态分组的纵向 lane」，
       * 宽栏（全屏 / 拖宽）用四列看板；宽度用 ResizeObserver 量，量不到就按窄栏渲染。
       */
      function BoardTab(props) {
        const useTabInfo = props ? props.useTabInfo : undefined
        // 右栏 tab 是 session scope，宿主会传当前会话 id：任务记下它，派发时回到这个对话。
        // 同一个 id 也是「把当前对话设为主会话」（bind-main-session）的入参。
        const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : ''
        if (sessionId !== '') lastConversationSessionId = sessionId
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
        // v0.2.2「待你处理」：回答草稿 / 行内错误（详情浮层只读，不持有 state）。
        const [answerDraft, setAnswerDraft] = useState('')
        const [answerError, setAnswerError] = useState('')
        // createBoardPieces 的稳定 bind / 组件缓存（避免轮询刷新时组件重建导致浮层闪烁）
        const boardBindRef = useRef(null)
        const boardPiecesRef = useRef(null)
        const [notice, setNotice] = useState(null)
        const [title, setTitle] = useState('')
        const [note, setNote] = useState('')
        const [showNote, setShowNote] = useState(false)
        // v0.2.0：待提交的粘贴图片（{id, preview, ...}）与详情浮层的附件 data URL 缓存。
        const [attachments, setAttachments] = useState([])
        // 上传中的请求计数（不是布尔）：连续多次粘贴时，只有全部结束才解除提交禁用。
        const [uploadingCount, setUploadingCount] = useState(0)
        const [attachmentSources, setAttachmentSources] = useState({})
        const attachmentSourcesRef = useRef({})
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
        // v0.2.2（§1.9）：flagged 任务只在顶部「待你处理」条显示，不进普通四列 / lane。
        // 条与四列都用本工作区可见任务（与看板范围一致）。
        const workspaceTasks = tasksForWorkspace(allTasks, cwdForHint, sessionId)
        const needsUser = needsUserTasks(workspaceTasks)
        const tasks = withoutNeedsUser(workspaceTasks)
        const plainTasks = withoutNeedsUser(allTasks)
        // 有些旧任务/别的会话建的任务没有 cwd，本面板按设计不显示；给个去处，避免「任务凭空消失」。
        const detailTask = detailId ? allTasks.find((task) => task && task.id === detailId) || null : null
        const doingAll = plainTasks.filter((task) => task && task.status === 'doing')
        const fallbackDispatchSessionId =
          poll && poll.lastDispatchSessionId && (poll.lastDispatchTaskId || doingAll.length === 1) ? poll.lastDispatchSessionId : ''
        const unboundElsewhere = plainTasks.filter(
          (task) => task && !task.cwd && task.status !== 'archived' && task.sessionId !== sessionId,
        ).length
        const groups = groupTasks(tasks)
        const preset = (snap && snap.preset) || null
        // v0.2.0 组长条：leads 是运行时视图（组长启停 / 忙闲不 bump revision），每次渲染都读最新值；
        // 右栏只列当前看板可见任务涉及的工作区，没组长的补「创建组长」入口。
        const leads = (snap && snap.leads) || null
        const leadRows = workspaceLeadRows(leads, taskWorkspaceCwds(tasks, cwdForHint), { all: false })

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
          // 上传中（计数 > 0）不提交：Enter 与按钮共用同一闸门，避免 note 里只有一半附件引用。
          if (isUploading(uploadingCount)) return
          const trimmedTitle = title.trim()
          if (trimmedTitle === '') {
            setNotice({ tone: 'warn', text: t('composer.empty') })
            return
          }
          // 客户端预检：note 里不同附件引用 > 8 时给具体提示（与服务端 bad-request 文案同源，§2.1）。
          const limitText = noteAttachmentLimitText(t, note)
          if (limitText !== '') {
            setNotice({ tone: 'error', text: limitText })
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
            setAttachments([])
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

        /**
         * v0.2.2（§1.9）：提交回答。不用 run()：错误要显示在详情浮层的回答区（而不是顶部条），
         * 失败时不关闭浮层、不丢输入；成功后关闭浮层、清草稿并刷新看板。
         */
        function submitAnswer(taskId) {
          const answer = String(answerDraft || '').trim()
          if (answer === '') {
            setAnswerError(t('needsUser.answerEmpty'))
            return
          }
          if (answer.length > 1000) {
            setAnswerError(t('needsUser.answerTooLong', { max: 1000 }))
            return
          }
          setAnswerError('')
          setBusy('answer:' + taskId)
          callRpc('answer-task', { id: taskId, answer }).then((res) => {
            if (!aliveRef.current) return
            setBusy('')
            if (!res.ok) {
              setAnswerError(t('needsUser.answerFailed', { message: errorText(t, res.error) }))
              return
            }
            setAnswerDraft('')
            setAnswerError('')
            setDetailId(null)
            setNotice({ tone: 'ok', text: t('needsUser.answerOk') })
            refresh()
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
          // 编辑备注同样受单任务 8 个附件引用的限制（文本里手写的引用也算）。
          const limitText = noteAttachmentLimitText(t, editing.note)
          if (limitText !== '') {
            setNotice({ tone: 'error', text: limitText })
            return
          }
          updateTask(editing.id, { title: trimmedTitle, note: String(editing.note || '').trim() })
          setEditing(null)
        }

        /** 备注粘贴：有图片就走上传 + 短引用；没有图片返回 false（保持默认文本粘贴）。 */
        function onNotePaste(event) {
          return handleNotePaste(event, {
            t,
            setNote,
            setPending: setAttachments,
            beginUpload: () => setUploadingCount((value) => value + 1),
            endUpload: () => setUploadingCount((value) => Math.max(0, value - 1)),
            setNotice,
          })
        }

        /** 移除一张待提交图片：缩略图与 note 里的引用一起删。 */
        function removePendingAttachment(id) {
          setAttachments((prev) => prev.filter((item) => item.id !== id))
          setNote((prev) => removeAttachmentRef(prev, id))
        }

        /* ── 组长条动作（v0.2.0）────────────────────────────────── */
        // 三个新 RPC：bind-main-session {sessionId} / clear-main-session {} / ensure-workspace-lead {cwd}。
        // 失败走 run() 的顶部错误条（errorText），不乐观更新、不崩。
        const leadActions = {
          bindMain: () => {
            if (sessionId === '') return
            run('lead:bind', () => callRpc('bind-main-session', { sessionId }), t('lead.bindOk'))
          },
          clearMain: () => run('lead:clear', () => callRpc('clear-main-session', {}), t('lead.clearOk')),
          ensureLead: (cwd) => {
            if (typeof cwd !== 'string' || cwd === '') return
            run('lead:ensure', () => callRpc('ensure-workspace-lead', { cwd }), t('lead.ensureOk'))
          },
          openSession: (sessionIdToOpen) => openSessionById(sessionIdToOpen),
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
            openDetail: (task) => {
              if (task) loadTaskAttachments(task, attachmentSourcesRef, setAttachmentSources)
              // v0.2.2：换一条任务就清掉上一条的回答草稿 / 错误，避免答案串台。
              setAnswerDraft('')
              setAnswerError('')
              setDetailId(task.id)
            },
            // 「对话」按钮传目标会话 id；仍兼容传任务对象的旧调用（取 dispatched → creator）。
            openSession: (target) => {
              if (typeof target === 'string') {
                openSessionById(target)
                return
              }
              openSessionById(target && (target.dispatchedSessionId || target.sessionId))
            },
            startEdit,
            saveEdit,
            setEditing,
            archiveDone,
            // v0.2.2「待你处理」：回答草稿由看板持有，浮层通过 bind.actions 读写。
            setAnswerDraft,
            submitAnswer,
        }
        if (boardBindRef.current === null) {
          boardBindRef.current = {
            t,
            busy: '',
            editing: null,
            actions: boardActions,
            fallbackDispatchSessionId: '',
            lastDispatchTaskId: '',
            leads: null,
            leadRows: [],
            currentSessionId: '',
            leadActions,
          }
        }
        boardBindRef.current.t = t
        boardBindRef.current.busy = busy
        boardBindRef.current.editing = editing
        boardBindRef.current.actions = boardActions
        boardBindRef.current.attachmentOf = (id) => attachmentSources[id] || null
        boardBindRef.current.fallbackDispatchSessionId = fallbackDispatchSessionId
        boardBindRef.current.lastDispatchTaskId = (poll && poll.lastDispatchTaskId) || ''
        // 组长条字段每次都刷新：leads 是运行时视图，revision 不变也会变。
        boardBindRef.current.leads = leads
        boardBindRef.current.leadRows = leadRows
        boardBindRef.current.currentSessionId = sessionId
        boardBindRef.current.leadActions = leadActions
        // v0.2.2「待你处理」：条 / 第五列的任务列表与回答草稿（每次渲染都刷新）。
        boardBindRef.current.needsUserTasks = needsUser
        boardBindRef.current.answerDraft = answerDraft
        boardBindRef.current.answerError = answerError
        if (boardPiecesRef.current === null) boardPiecesRef.current = createBoardPieces(boardBindRef.current)
        const Banner = boardPiecesRef.current.Banner
        const Col = boardPiecesRef.current.Col
        const Detail = boardPiecesRef.current.Detail
        const LeadBar = boardPiecesRef.current.LeadBar
        const NeedsBanner = boardPiecesRef.current.NeedsBanner
        const NeedsColumn = boardPiecesRef.current.NeedsColumn

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
                    value: dispatchModeOf(config),
                    disabled: busyNow,
                    title: t('dispatch.modeHint'),
                    'aria-label': t('dispatch.mode'),
                    onChange: (event) => setConfig({ dispatchMode: event.target.value }),
                  },
                  DISPATCH_MODES.map((mode) => h('option', { key: mode, value: mode }, t('dispatch.mode.' + mode))),
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

          h(LeadBar, { key: 'leads' }),
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
                  disabled: submitBlocked({ busy: busyNow, uploading: uploadingCount, title }),
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
                  onPaste: onNotePaste,
                })
              : null,
            attachments.length > 0
              ? h(
                  'div',
                  { className: 'tb-attach-strip' },
                  attachments.map((item) =>
                    h(
                      'div',
                      { key: item.id, className: 'tb-attach-item' },
                      h('img', {
                        className: 'tb-attach-thumb',
                        src: item.preview,
                        alt: typeof item.name === 'string' ? item.name : '',
                        title: t('composer.removeImage'),
                      }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'tb-attach-remove',
                          onClick: () => removePendingAttachment(item.id),
                          'aria-label': t('composer.removeImage'),
                          title: t('composer.removeImage'),
                        },
                        '\u00d7',
                      ),
                    ),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'tb-composer-meta' },
              h(
                'button',
                { type: 'button', className: 'tb-linkbtn', onClick: () => setShowNote(!showNote), 'aria-expanded': showNote ? 'true' : 'false' },
                showNote ? t('composer.hideNote') : t('composer.addNote'),
              ),
              isUploading(uploadingCount) ? h('span', { className: 'tb-hint' }, t('composer.uploading')) : null,
              h(
                'span',
                { className: 'tb-hint' },
                currentWorkspace === ''
                  ? t('composer.autoHint')
                  : t('composer.autoHintWorkspace', { name: currentWorkspace }),
              ),
            ),
          ),

          // v0.2.2（§1.9）：顶部「待你处理」条（仅非空时由组件自己返回 null）。
          h(NeedsBanner, { key: 'needs' }),

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
                onClose: () => {
                  setDetailId(null)
                  setAnswerDraft('')
                  setAnswerError('')
                },
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
        // v0.2.2（§1.9）：待你处理数量单独一个红色角标。
        const [needsCount, setNeedsCount] = useState(-1)

        useEffect(() => {
          let alive = true
          const read = () => {
            if (!isDocVisible()) return
            callRpc('snapshot', {}).then((res) => {
              if (!alive) return
              if (!res.ok || !res.value || !Array.isArray(res.value.tasks)) return
              let count = 0
              let needs = 0
              for (const task of res.value.tasks) {
                // flagged 任务算「待你处理」，不算未完成待办（两枚角标不重复计数）。
                if (task.needsUser === true && task.status !== 'archived') {
                  needs += 1
                  continue
                }
                if (task.status === 'todo' || task.status === 'doing') count += 1
              }
              setOpenCount(count)
              setNeedsCount(needs)
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
        const needsBadge = needsCount > 0 ? (needsCount > 99 ? '99+' : String(needsCount)) : null
        const tip =
          t('platform.label') +
          (openCount > 0 ? ' · ' + t('badge.open', { n: openCount }) : '') +
          (needsCount > 0 ? ' · ' + t('needsUser.badge', { n: needsCount }) : '')
        return h(
          'span',
          { className: 'tb-icon', title: tip },
          h(BoardGlyph, { size }),
          badge === null ? null : h('span', { className: 'tb-badge', 'aria-hidden': 'true' }, badge),
          needsBadge === null
            ? null
            : h('span', { className: 'tb-badge tb-badge-needs', 'aria-hidden': 'true' }, needsBadge),
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
        // v0.2.2「待你处理」：回答草稿 / 行内错误（详情浮层只读，不持有 state）。
        const [answerDraft, setAnswerDraft] = useState('')
        const [answerError, setAnswerError] = useState('')
        // createBoardPieces 的稳定 bind / 组件缓存（避免轮询刷新时组件重建导致浮层闪烁）
        const boardBindRef = useRef(null)
        const boardPiecesRef = useRef(null)
        const [notice, setNotice] = useState(null)
        const [title, setTitle] = useState('')
        const [note, setNote] = useState('')
        const [showNote, setShowNote] = useState(false)
        // v0.2.0：与右栏看板同一套粘贴图片 / 详情附件缓存。
        const [attachments, setAttachments] = useState([])
        // 上传中的请求计数（不是布尔）：连续多次粘贴时，只有全部结束才解除提交禁用。
        const [uploadingCount, setUploadingCount] = useState(0)
        const [attachmentSources, setAttachmentSources] = useState({})
        const attachmentSourcesRef = useRef({})
        const [editing, setEditing] = useState(null)
        const [filterPath, setFilterPath] = useState('')
        const [workspaceCwd, setWorkspaceCwd] = useState('')
        const aliveRef = useRef(true)
        // v0.2.3：工作区过滤选择的恢复只做一次；用户手动切换后不再被 snapshot 覆盖。
        const filterRestoredRef = useRef(false)
        const filterTouchedRef = useRef(false)
        // v0.2.3：新建行「任务所属工作区」选择同样只恢复一次、用户改过就不再被覆盖。
        const draftRestoredRef = useRef(false)
        const draftTouchedRef = useRef(false)

        const refresh = useCallback(() => {
          return callRpc('snapshot', {}).then((res) => {
            if (!aliveRef.current) return res
            if (res.ok && res.value) {
              // 恢复持久化的「工作区」过滤选择（config.workspaceFilter）：
              // resolveWorkspaceSelection 返回 null 表示工作区列表还没就绪，留到下一次 snapshot 再判定。
              if (!filterRestoredRef.current && !filterTouchedRef.current) {
                const value = res.value
                const stored = value.config ? value.config.workspaceFilter : ''
                const resolved = resolveWorkspaceSelection(stored, value.workspaces)
                if (resolved !== null) {
                  filterRestoredRef.current = true
                  if (resolved !== '') setFilterPath(resolved)
                }
              }
              // v0.2.3：恢复新建行「任务所属工作区」选择（config.workspaceDraft）。
              // 同样只在工作区列表就绪后判定一次；'' = 未选择（占位，提交保持禁用）。
              if (!draftRestoredRef.current && !draftTouchedRef.current) {
                const value = res.value
                const storedDraft = value.config ? value.config.workspaceDraft : ''
                const resolvedDraft = resolveWorkspaceSelection(storedDraft, value.workspaces)
                if (resolvedDraft !== null) {
                  draftRestoredRef.current = true
                  if (resolvedDraft !== '') setWorkspaceCwd(resolvedDraft)
                }
              }
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

        // v0.2.3：选中的工作区可能在页面打开期间被删 / 改名——不在当前列表里就不再当成选中项。
        const activeFilter = resolveWorkspaceSelection(filterPath, workspaces) || ''
        // v0.2.3：新建行的「任务所属工作区」同样按 snapshot.workspaces 校验——
        // 选中的工作区在页面打开期间被删 / 改名 → 回退占位（提交重新禁用），不拿失效路径建任务。
        const activeWorkspaceCwd = resolveWorkspaceSelection(workspaceCwd, workspaces) || ''
        const visibleAll = tasksForFilter(allTasks, activeFilter)
        // v0.2.2（§1.9）：flagged 任务只进最左第五列，不重复出现在普通四列。
        const needsUser = needsUserTasks(visibleAll)
        const visibleTasks = withoutNeedsUser(visibleAll)
        const groups = groupTasks(visibleTasks)
        const doingAll = withoutNeedsUser(allTasks).filter((task) => task && task.status === 'doing')
        const fallbackDispatchSessionId =
          poll && poll.lastDispatchSessionId && (poll.lastDispatchTaskId || doingAll.length === 1) ? poll.lastDispatchSessionId : ''
        const detailTask = detailId ? allTasks.find((task) => task && task.id === detailId) || null : null
        // v0.2.0 组长条：完整看板列出全部工作区组长（leads 是运行时视图，每次渲染都读最新值）。
        // 根作用域的 main 页拿不到 session 绑定：用最近渲染过的对话 id 当「当前对话」，没有就禁用绑定按钮。
        const leads = (snap && snap.leads) || null
        const leadRows = workspaceLeadRows(leads, [], { all: true })
        const currentSessionId = lastConversationSessionId

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
          // 上传中（计数 > 0）不提交：Enter 与按钮共用同一闸门，避免 note 里只有一半附件引用。
          if (isUploading(uploadingCount)) return
          const trimmedTitle = title.trim()
          if (trimmedTitle === '') {
            setNotice({ tone: 'warn', text: t('composer.empty') })
            return
          }
          if (activeWorkspaceCwd === '') {
            setNotice({ tone: 'warn', text: t('platform.workspaceRequired') })
            return
          }
          // 客户端预检：note 里不同附件引用 > 8 时给具体提示（与服务端 bad-request 文案同源，§2.1）。
          const limitText = noteAttachmentLimitText(t, note)
          if (limitText !== '') {
            setNotice({ tone: 'error', text: limitText })
            return
          }
          // 平台看板不绑会话：任务归属由所选工作区决定（cwd），派发由宿主自动挑会话。
          // 用校验后的 activeWorkspaceCwd：选中的工作区被删 / 改名时不会把失效路径写进任务。
          const payload = { title: trimmedTitle, cwd: activeWorkspaceCwd }
          if (note.trim() !== '') payload.note = note.trim()
          run('add', () => callRpc('add-task', payload)).then((value) => {
            if (!value) return
            setTitle('')
            setNote('')
            setShowNote(false)
            setAttachments([])
          })
        }

        function updateTask(id, patch, successText) {
          run('update:' + id, () => callRpc('update-task', Object.assign({ id }, patch)), successText)
        }

        /**
         * v0.2.3：切换「工作区」过滤 → **立即**持久化（不等到卸载，刷新页面 / 重启 Host 后仍是它）。
         * 写失败只 console.warn，不影响看板显示（set-workspace-filter 是 best-effort，§3.1）。
         */
        function changeWorkspaceFilter(next) {
          filterTouchedRef.current = true
          filterRestoredRef.current = true
          setFilterPath(next)
          callRpc('set-workspace-filter', { path: next }).then((res) => {
            if (!res || res.ok !== true) {
              const reason = res && res.error && res.error.message ? res.error.message : 'unknown'
              console.warn('[taskboard] 保存工作区选择失败：' + reason)
              return
            }
            if (res.value && res.value.saved === false) console.warn('[taskboard] 工作区选择未落盘（内存已更新）')
          })
        }

        /**
         * v0.2.3：切换新建行「任务所属工作区」→ **立即**持久化
         * （去别的会话再点回看板 / 刷新页面 / 重启 Host 后仍是它）。
         * 写失败只 console.warn，不影响看板显示（set-workspace-draft 是 best-effort，§3.1）。
         */
        function changeWorkspaceCwd(next) {
          draftTouchedRef.current = true
          draftRestoredRef.current = true
          setWorkspaceCwd(next)
          callRpc('set-workspace-draft', { path: next }).then((res) => {
            if (!res || res.ok !== true) {
              const reason = res && res.error && res.error.message ? res.error.message : 'unknown'
              console.warn('[taskboard] 保存任务所属工作区失败：' + reason)
              return
            }
            if (res.value && res.value.saved === false) console.warn('[taskboard] 任务所属工作区未落盘（内存已更新）')
          })
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

        /**
         * v0.2.2（§1.9）：提交回答。不用 run()：错误要显示在详情浮层的回答区（而不是顶部条），
         * 失败时不关闭浮层、不丢输入；成功后关闭浮层、清草稿并刷新看板。
         */
        function submitAnswer(taskId) {
          const answer = String(answerDraft || '').trim()
          if (answer === '') {
            setAnswerError(t('needsUser.answerEmpty'))
            return
          }
          if (answer.length > 1000) {
            setAnswerError(t('needsUser.answerTooLong', { max: 1000 }))
            return
          }
          setAnswerError('')
          setBusy('answer:' + taskId)
          callRpc('answer-task', { id: taskId, answer }).then((res) => {
            if (!aliveRef.current) return
            setBusy('')
            if (!res.ok) {
              setAnswerError(t('needsUser.answerFailed', { message: errorText(t, res.error) }))
              return
            }
            setAnswerDraft('')
            setAnswerError('')
            setDetailId(null)
            setNotice({ tone: 'ok', text: t('needsUser.answerOk') })
            refresh()
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
          // 编辑备注同样受单任务 8 个附件引用的限制（文本里手写的引用也算）。
          const limitText = noteAttachmentLimitText(t, editing.note)
          if (limitText !== '') {
            setNotice({ tone: 'error', text: limitText })
            return
          }
          updateTask(editing.id, { title: trimmedTitle, note: String(editing.note || '').trim() })
          setEditing(null)
        }

        /** 备注粘贴：有图片就走上传 + 短引用；没有图片返回 false（保持默认文本粘贴）。 */
        function onNotePaste(event) {
          return handleNotePaste(event, {
            t,
            setNote,
            setPending: setAttachments,
            beginUpload: () => setUploadingCount((value) => value + 1),
            endUpload: () => setUploadingCount((value) => Math.max(0, value - 1)),
            setNotice,
          })
        }

        /** 移除一张待提交图片：缩略图与 note 里的引用一起删。 */
        function removePendingAttachment(id) {
          setAttachments((prev) => prev.filter((item) => item.id !== id))
          setNote((prev) => removeAttachmentRef(prev, id))
        }

        /* ── 组长条动作（v0.2.0，与右栏看板同一套 RPC）──────────── */
        const leadActions = {
          bindMain: () => {
            if (currentSessionId === '') return
            run('lead:bind', () => callRpc('bind-main-session', { sessionId: currentSessionId }), t('lead.bindOk'))
          },
          clearMain: () => run('lead:clear', () => callRpc('clear-main-session', {}), t('lead.clearOk')),
          ensureLead: (cwd) => {
            if (typeof cwd !== 'string' || cwd === '') return
            run('lead:ensure', () => callRpc('ensure-workspace-lead', { cwd }), t('lead.ensureOk'))
          },
          openSession: (sessionIdToOpen) => openSessionById(sessionIdToOpen),
        }

        // 组件身份保持稳定（同右栏看板）：bind 存 ref、只改字段，pieces 只创建一次。
        const boardActions = {
            updateTask,
            dispatchNow,
            removeTask,
            requestDelete,
            isConfirmingDelete: (id) => confirmDeleteId === id,
            openDetail: (task) => {
              if (task) loadTaskAttachments(task, attachmentSourcesRef, setAttachmentSources)
              // v0.2.2：换一条任务就清掉上一条的回答草稿 / 错误，避免答案串台。
              setAnswerDraft('')
              setAnswerError('')
              setDetailId(task.id)
            },
            // 「对话」按钮传目标会话 id；仍兼容传任务对象的旧调用（取 dispatched → creator）。
            openSession: (target) => {
              if (typeof target === 'string') {
                openSessionById(target)
                return
              }
              openSessionById(target && (target.dispatchedSessionId || target.sessionId))
            },
            startEdit,
            saveEdit,
            setEditing,
            archiveDone,
            // v0.2.2「待你处理」：回答草稿由看板持有，浮层通过 bind.actions 读写。
            setAnswerDraft,
            submitAnswer,
        }
        if (boardBindRef.current === null) {
          boardBindRef.current = {
            t,
            busy: '',
            editing: null,
            actions: boardActions,
            fallbackDispatchSessionId: '',
            lastDispatchTaskId: '',
            leads: null,
            leadRows: [],
            currentSessionId: '',
            leadActions,
          }
        }
        boardBindRef.current.t = t
        boardBindRef.current.busy = busy
        boardBindRef.current.editing = editing
        boardBindRef.current.actions = boardActions
        boardBindRef.current.attachmentOf = (id) => attachmentSources[id] || null
        boardBindRef.current.fallbackDispatchSessionId = fallbackDispatchSessionId
        boardBindRef.current.lastDispatchTaskId = (poll && poll.lastDispatchTaskId) || ''
        // 组长条字段每次都刷新：leads 是运行时视图，revision 不变也会变。
        boardBindRef.current.leads = leads
        boardBindRef.current.leadRows = leadRows
        boardBindRef.current.currentSessionId = currentSessionId
        boardBindRef.current.leadActions = leadActions
        if (boardPiecesRef.current === null) boardPiecesRef.current = createBoardPieces(boardBindRef.current)
        const Banner = boardPiecesRef.current.Banner
        const Col = boardPiecesRef.current.Col
        const Detail = boardPiecesRef.current.Detail
        const LeadBar = boardPiecesRef.current.LeadBar
        const NeedsBanner = boardPiecesRef.current.NeedsBanner
        const NeedsColumn = boardPiecesRef.current.NeedsColumn

        const intervalText = fmtInterval(config.pollIntervalMs)
        const busyNow = busy !== ''
        const skipReason = poll.lastSkipReason || ''
        const skipKey = 'poll.skip.' + skipReason
        const skipText = skipReason === '' ? '' : t(skipKey) === skipKey ? skipReason : t(skipKey)
        const workspaceRequired = activeWorkspaceCwd === ''

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
                    value: dispatchModeOf(config),
                    disabled: busyNow,
                    title: t('dispatch.modeHint'),
                    'aria-label': t('dispatch.mode'),
                    onChange: (event) => setConfig({ dispatchMode: event.target.value }),
                  },
                  DISPATCH_MODES.map((mode) => h('option', { key: mode, value: mode }, t('dispatch.mode.' + mode))),
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

          h(LeadBar, { key: 'leads' }),
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
                  // v0.2.3：下拉值用校验后的 activeWorkspaceCwd——上次选的工作区被删 /
                  // 改名时回退占位，不把失效值当选中项（选择本身由 config.workspaceDraft 持久化）。
                  value: activeWorkspaceCwd,
                  onChange: (event) => changeWorkspaceCwd(event.target.value),
                },
                h('option', { value: '' }, t('platform.workspacePlaceholder')),
                workspaceOptions.map((option) => h('option', { key: option.path, value: option.path }, option.title)),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tb-btn tb-btn-primary',
                  disabled: submitBlocked({ busy: busyNow, uploading: uploadingCount, title, workspaceRequired }),
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
                  onPaste: onNotePaste,
                })
              : null,
            attachments.length > 0
              ? h(
                  'div',
                  { className: 'tb-attach-strip' },
                  attachments.map((item) =>
                    h(
                      'div',
                      { key: item.id, className: 'tb-attach-item' },
                      h('img', {
                        className: 'tb-attach-thumb',
                        src: item.preview,
                        alt: typeof item.name === 'string' ? item.name : '',
                        title: t('composer.removeImage'),
                      }),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'tb-attach-remove',
                          onClick: () => removePendingAttachment(item.id),
                          'aria-label': t('composer.removeImage'),
                          title: t('composer.removeImage'),
                        },
                        '\u00d7',
                      ),
                    ),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'tb-composer-meta' },
              h(
                'button',
                { type: 'button', className: 'tb-linkbtn', onClick: () => setShowNote(!showNote), 'aria-expanded': showNote ? 'true' : 'false' },
                showNote ? t('composer.hideNote') : t('composer.addNote'),
              ),
              isUploading(uploadingCount) ? h('span', { className: 'tb-hint' }, t('composer.uploading')) : null,
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
                  value: activeFilter,
                  onChange: (event) => changeWorkspaceFilter(event.target.value),
                },
                h('option', { value: '' }, t('platform.filterAll')),
                workspaceOptions.map((option) => h('option', { key: option.path, value: option.path }, option.title)),
              ),
            ),
            h('span', { className: 'tb-toolbar-count' }, t('platform.total', { n: visibleAll.length })),
          ),

          allTasks.length === 0
            ? h('div', { className: 'tb-empty tb-platform-empty' }, t('platform.empty'))
            : null,

          h(
            'div',
            { className: 'tb-board', 'data-layout': 'wide', 'data-needs': needsUser.length > 0 ? 'true' : 'false' },
            // 第五列「待你处理」放最左（在「待开始」之前），仅非空时渲染。
            needsUser.length > 0 ? h(NeedsColumn, { key: 'needsUser', tasks: needsUser }) : null,
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
                onClose: () => {
                  setDetailId(null)
                  setAnswerDraft('')
                  setAnswerError('')
                },
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
        console.warn('[dsh-dispatch-board] 右栏 tab 类型注册失败：' + describeErr(error))
      }

      // 2) 会话导航：看板里「对话 / 发起对话 / 执行对话」用它跳到对应会话。
      try {
        ctx.inject(['uiWorkspace'], (scope) => {
          uiWorkspaceService = scope.uiWorkspace
        })
      } catch (error) {
        console.warn('[dsh-dispatch-board] 会话导航服务注入失败：' + describeErr(error))
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
        console.warn('[dsh-dispatch-board] 右栏服务注入失败：' + describeErr(error))
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
      // v0.2.0 任务关联对话：worker 会话判定（assignee 只在能提取到会话 id 时算会话）
      workerSessionOf,
      extractSessionId,
      groupTasks,
      statusAccent: STATUS_ACCENT,
      statusOrder: STATUS_ORDER,
      baseName,
      normalizePath,
      samePath,
      workspaceTitleOf,
      tasksForWorkspace,
      tasksForFilter,
      // v0.2.3：看板「工作区」过滤选择的恢复 / 脏值回退
      resolveWorkspaceSelection,
      parseRichText,
      splitLooseSegments,
      renderInline,
      // v0.2.0 粘贴图片附件纯函数
      attachmentRef,
      attachmentIdsIn,
      insertAttachmentRef,
      removeAttachmentRef,
      clipboardImageFiles,
      splitPasteImages,
      isUploading,
      submitBlocked,
      noteAttachmentLimitText,
      maxPasteImages: MAX_PASTE_IMAGES,
      maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
      maxAttachmentMb: MAX_ATTACHMENT_MB,
      maxAttachmentCache: MAX_ATTACHMENT_CACHE,
      maxNoteAttachments: MAX_NOTE_ATTACHMENTS,
      // v0.2.0 组长条 / 派发模式纯展示函数
      dispatchModes: DISPATCH_MODES,
      dispatchModeOf,
      leadStatusKey,
      leadTitleTail,
      leadMainRow,
      taskLeadLabel,
      taskWorkspaceCwds,
      workspaceLeadRows,
      // v0.2.2「待你处理」（§1.9）派生列表
      needsUserTasks,
      withoutNeedsUser,
    }

    return module.exports
  },
})
