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
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') events.push({ type: m.type(), text: m.text().slice(0, 300) }); });
  page.on('pageerror', e => events.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 300) }));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('平台任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  const report = {};

  // 再造一条用于删除的任务，保证一定在页面上
  await rpc('add-task', { title: 'BTN 验证：点击删除' });
  await page.waitForTimeout(2500);
  const delCard = page.locator('.tb-card', { hasText: 'BTN 验证：点击删除' }).first();
  report.deleteCardVisible = await delCard.count();
  report.buttonsBefore = await delCard.locator('button').allInnerTexts();
  await delCard.getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForTimeout(600);
  report.buttonsAfterFirstClick = await delCard.locator('button').allInnerTexts();
  await page.screenshot({ path: OUT + '/shots/btn-01-confirm.png' });
  const confirmBtn = delCard.getByRole('button', { name: /确认删除/ });
  if (await confirmBtn.count()) { await confirmBtn.first().click(); }
  await page.waitForTimeout(2500);
  report.cardGoneAfterConfirm = (await page.locator('.tb-card', { hasText: 'BTN 验证：点击删除' }).count()) === 0;
  report.statusesAfterDelete = (await rpc('snapshot')).value.tasks.map(t => t.id + ':' + t.status + ':' + t.title);

  await rpc('add-task', { title: 'BTN 验证：开始完成归档' });
  await page.waitForTimeout(2500);
  const card = page.locator('.tb-card', { hasText: 'BTN 验证：开始完成归档' }).first();
  const statusOf = async () => (await rpc('snapshot')).value.tasks.find(t => t.title === 'BTN 验证：开始完成归档').status;
  const clickInCard = async (name) => { await card.getByRole('button', { name, exact: true }).click(); await page.waitForTimeout(1800); };
  await clickInCard('开始');
  report.afterStart = await statusOf();
  await clickInCard('完成');
  report.afterComplete = await statusOf();
  await page.screenshot({ path: OUT + '/shots/btn-02-done.png' });
  await clickInCard('归档');
  const archived = (await rpc('snapshot')).value.tasks.find(t => t.title === 'BTN 验证：开始完成归档');
  report.afterArchive = archived.status;
  report.archivedAt = archived.archivedAt;
  await page.screenshot({ path: OUT + '/shots/btn-03-archived.png' });

  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  report.finalTasks = (await rpc('snapshot')).value.tasks.length;
  report.console = { total: events.length, events: events.slice(0, 10) };
  console.log('REPORT ' + JSON.stringify(report, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
