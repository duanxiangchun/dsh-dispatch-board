const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
async function rpc(method, payload = {}) {
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'd', method, payload }) });
  return (await r.json()).result;
}
(async () => {
  const events = [];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') events.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => events.push('pageerror: ' + (e.message || String(e)).slice(0, 300)));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('平台任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  const report = {};

  const card = page.locator('.tb-card', { hasText: 'DETAIL 验证' }).first();
  report.cardVisible = await card.count();
  report.cardResultVisible = await card.locator('.tb-card-result').count();
  await card.locator('.tb-card-title').click();
  await page.waitForTimeout(800);
  const detail = page.locator('.tb-detail');
  report.detailVisible = await detail.count();
  report.detailText = (await detail.innerText()).replace(/\n+/g, ' | ').slice(0, 900);
  report.hasFullResult = (await detail.innerText()).includes('结论：详情浮层应完整展示这段长文本而不被截断');
  report.hasNote = (await detail.innerText()).includes('这一行是为了让备注足够长');
  report.hasAssignee = (await detail.innerText()).includes('subagent:abcd1234');
  await page.screenshot({ path: OUT + '/shots/detail-01-overlay.png' });

  // 浮层里直接归档
  await detail.getByRole('button', { name: '归档', exact: true }).click();
  await page.waitForTimeout(2000);
  report.afterArchive = (await rpc('snapshot')).value.tasks.find(t => t.title.startsWith('DETAIL')).status;
  report.detailClosed = (await page.locator('.tb-detail').count()) === 0;
  await page.screenshot({ path: OUT + '/shots/detail-02-archived.png' });

  // 窄栏（右栏）里也试一次：需要会话，跳过，记录说明
  report.console = events;
  console.log('REPORT ' + JSON.stringify(report, null, 1));
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
