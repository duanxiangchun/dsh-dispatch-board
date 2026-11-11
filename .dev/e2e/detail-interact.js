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
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  const c1 = await rpc('add-task', { title: 'ACT 验证', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  const id = c1.value.task.id;
  await rpc('update-task', { id, status: 'doing' });
  await rpc('update-task', { id, status: 'done', result: '已完成，等待归档。' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 200)));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('.tb-card', { hasText: 'ACT 验证' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(600);
  const before = (await rpc('snapshot')).value.tasks.find(t => t.id === id);
  const buttons = await page.locator('.tb-detail-actions button').allInnerTexts();
  await page.locator('.tb-detail-actions').getByRole('button', { name: '归档', exact: true }).click();
  await page.waitForTimeout(1800);
  const after = (await rpc('snapshot')).value.tasks.find(t => t.id === id);
  const dialogGone = (await page.locator('.tb-detail').count()) === 0;
  console.log('RESULT ' + JSON.stringify({ before: before && before.status, buttons, after: after && after.status, dialogGone, errors }));
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
