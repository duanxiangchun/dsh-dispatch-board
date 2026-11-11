const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'btn', method, payload }) });
  return (await r.json()).result;
}
(async () => {
  const events = [];
  const reqs = [];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => events.push({ type: m.type(), text: m.text().slice(0, 300) }));
  page.on('pageerror', e => events.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 300) }));
  page.on('request', r => { if (r.url().includes('/taskboard/')) reqs.push(r.method() + ' ' + r.url().replace(BASE, '') + ' ' + (r.postData() || '').slice(0, 160)); });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('平台任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await rpc('add-task', { title: 'BTN 调试删除' });
  await page.waitForTimeout(2500);
  const card = page.locator('.tb-card', { hasText: 'BTN 调试删除' }).first();
  await card.getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForTimeout(500);
  console.log('AFTER1 buttons=' + JSON.stringify(await card.locator('button').allInnerTexts()));
  await card.getByRole('button', { name: /确认删除/ }).first().click();
  await page.waitForTimeout(1200);
  console.log('AFTER2 buttons=' + JSON.stringify(await card.locator('button').allInnerTexts().catch(() => [])));
  console.log('NOTICE=' + JSON.stringify(await page.locator('.tb-notice').allInnerTexts()));
  console.log('REQS=' + JSON.stringify(reqs.slice(-6), null, 1));
  console.log('STATUS=' + JSON.stringify((await rpc('snapshot')).value.tasks.map(t => t.id + ':' + t.status + ':' + t.title)));
  console.log('CONSOLE=' + JSON.stringify(events.slice(-8)));
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
