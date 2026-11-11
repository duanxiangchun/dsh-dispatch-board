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
  const created = await rpc('add-task', { title: 'JUMP2 验证：带会话', note: '验证跳转按钮', sessionId: 'session-11111111-2222-3333-4444-555566667777' });
  const id = created.value.task.id;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const events = [];
  page.on('console', m => { if (m.type() !== 'log') events.push({ type: m.type(), text: m.text().slice(0, 200) }); });
  page.on('pageerror', e => events.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 200) }));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  const report = {};
  const card = page.locator('.tb-card', { hasText: 'JUMP2 验证' }).first();
  report.cardButtons = await card.locator('button').allInnerTexts();
  await card.locator('.tb-card-title').click();
  await page.waitForTimeout(700);
  report.detailSessionButtons = await page.locator('.tb-detail-sessions button').allInnerTexts();
  await page.screenshot({ path: OUT + '/shots/jump-02-session.png' });
  // 点卡片上的「对话」（先关浮层）
  await page.locator('.tb-detail-actions button').first().click();
  await page.waitForTimeout(500);
  await card.getByRole('button', { name: '对话', exact: true }).click();
  await page.waitForTimeout(1500);
  report.afterClick = { bodyHasConversation: await page.locator('.tb-page').count(), title: await page.title() };
  console.log('REPORT ' + JSON.stringify(report, null, 1));
  console.log('CONSOLE ' + JSON.stringify(events.slice(0, 8)));
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
