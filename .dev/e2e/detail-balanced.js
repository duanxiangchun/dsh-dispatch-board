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
  await rpc('add-task', { title: '布局平衡验收', note: '基本信息左右两列要一样多。', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答', sessionId: 'session-aaaa1111-2222-3333-4444-555566667777' });
  const snap0 = await rpc('snapshot');
  const id = snap0.value.tasks[0].id;
  await rpc('update-task', { id, status: 'done', result: '## 结论\n**通过**。\n\n| 轮次 | 子 Agent |\n| --- | --- |\n| 1 | 71b1206e |\n| 2 | 3e9421b9 |', assignee: 'subagent:71b1206e / 3e9421b9' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('.tb-card', { hasText: '布局平衡验收' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.tb-detail-grid .tb-detail-row'));
    const byRow = {};
    for (const row of rows) {
      const top = Math.round(row.getBoundingClientRect().top);
      (byRow[top] = byRow[top] || []).push(row.querySelector('dt').textContent + '=' + Math.round(row.getBoundingClientRect().left));
    }
    const left = rows.filter(r => Math.round(r.getBoundingClientRect().left) < 700).length;
    const right = rows.length - left;
    return { rows: rows.length, left, right, byRow };
  });
  console.log('INFO ' + JSON.stringify(info));
  await page.screenshot({ path: OUT + '/shots/detail-balanced.png' });
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });