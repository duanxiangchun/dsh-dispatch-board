const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
async function rpc(method, payload = {}) {
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'd', method, payload }) });
  return (await r.json()).result;
}
(async () => {
  await rpc('set-config', { pollEnabled: false });
  const c = await rpc('add-task', { title: '关联对话行验收', note: '关联对话要作为基本信息里的一整行。', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答', sessionId: 'session-aaaa1111-2222-3333-4444-555566667777' });
  const id = c.value.task.id;
  await rpc('update-task', { id, status: 'doing' });
  await rpc('update-task', { id, status: 'done', result: '## 结论\n**通过**。', assignee: 'subagent:26e6ae29' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('.tb-card', { hasText: '关联对话行验收' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('.tb-detail-sub')).map(n => n.textContent);
    const wide = document.querySelector('.tb-detail-row-wide');
    const grid = document.querySelector('.tb-detail-grid');
    return {
      sections,
      hasWideRow: Boolean(wide),
      wideInsideGrid: Boolean(wide && grid && grid.contains(wide)),
      wideLabel: wide ? wide.querySelector('dt').textContent : null,
      wideButtons: wide ? Array.from(wide.querySelectorAll('button')).map(b => b.textContent) : [],
      wideSpan: wide ? getComputedStyle(wide).gridColumn : null,
    };
  });
  console.log('INFO ' + JSON.stringify(info));
  await page.screenshot({ path: OUT + '/shots/detail-sessions-row.png' });
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });