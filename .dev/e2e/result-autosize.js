const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
async function rpc(method, payload = {}) {
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'd', method, payload }) });
  return (await r.json()).result;
}
const LONG = ['## 结论', '**通过**（独立验证，非仅看汇报）。', '', '### 执行', '| 轮次 | 子 Agent | 内容 |', '| --- | --- | --- |', '| 1 | 71b1206e | 只读取证目录 / 按 AGENTS.md 记忆约定改 MEMORY.md |', '| 2 | 3e9421b9 | 把新条目与原 L157 的同主题记录合并为一条 |', '', '### 改动产物', '- 仅 MEMORY.md 一个文件被改，其余文件与目录未动', '- 最终：163 行 / 46665 字节，UTF-8 无 BOM，全 LF', '- 合并后 L157 单条记录同时覆盖：dispatchedSessionId 字段、additionalProperties: false 报错、只发生在输出 schema 校验/序列化', '', '### 关键结论', '1. 派发链路（看板 → doing → 子 Agent 后台执行 → 回报 → Lead 取证审核）跑通；', '2. 两轮派发均已实测复核通过；', '3. 结论里表格、列表、行内代码都能正常渲染。', '', '> Lead 取证：非仅看汇报。', '', '---', '执行者：subagent:71b1206e / 3e9421b9'].join('\n');
(async () => {
  await rpc('set-config', { pollEnabled: false });
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  const add = await rpc('add-task', { title: '自适应高度验收', note: '结论高度不再限制，跟随内容自适应。', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答', sessionId: 'session-aaaa1111-2222-3333-4444-555566667777' });
  const id = add.value.task.id;
  await rpc('update-task', { id, status: 'doing' });
  await rpc('update-task', { id, status: 'done', result: LONG, assignee: 'subagent:71b1206e' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2200);
  await page.locator('.tb-card', { hasText: '自适应高度验收' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => {
    const res = document.querySelector('.tb-detail-result');
    const body = document.querySelector('.tb-detail-body');
    const dlg = document.querySelector('.tb-detail');
    const cs = res ? getComputedStyle(res) : null;
    return {
      resultHeight: res ? Math.round(res.getBoundingClientRect().height) : null,
      resultScrollHeight: res ? res.scrollHeight : null,
      resultMaxHeight: cs ? cs.maxHeight : null,
      resultOverflow: cs ? cs.overflowY : null,
      bodyScrollable: body ? body.scrollHeight > body.clientHeight : null,
      dialogHeight: dlg ? Math.round(dlg.getBoundingClientRect().height) : null,
    };
  });
  console.log('INFO ' + JSON.stringify(info));
  await page.screenshot({ path: OUT + '/shots/result-autosize.png' });
  await page.locator('.tb-detail-body').evaluate(el => { el.scrollTop = 99999; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '/shots/result-autosize-bottom.png' });
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
