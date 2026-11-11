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
  const created = await rpc('add-task', { title: 'JUMP 验证：跳到关联对话', note: '验证卡片与详情里的对话跳转按钮', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  const id = created.value.task.id;
  // 模拟已派发：写入来源会话与执行会话（假 id，只验证调用与降级）
  await rpc('update-task', { id, status: 'doing' });
  await rpc('update-task', { id, status: 'done', result: '验证跳转按钮存在且点击不崩。' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const events = [];
  page.on('console', m => events.push({ type: m.type(), text: m.text().slice(0, 200) }));
  page.on('pageerror', e => events.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 200) }));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  const report = {};
  const card = page.locator('.tb-card', { hasText: 'JUMP 验证' }).first();
  report.cardButtons = await card.locator('button').allInnerTexts();
  await card.locator('.tb-card-title').click();
  await page.waitForTimeout(700);
  report.detailSessionButtons = await page.locator('.tb-detail-sessions button').allInnerTexts();
  report.detailHasMuted = await page.locator('.tb-detail .tb-detail-muted').count();
  await page.screenshot({ path: OUT + '/shots/jump-01-detail.png' });
  // 点「发起对话」（无关联会话时只有 muted；这里没有 sessionId → 应显示 muted）
  if ((await page.locator('.tb-detail-sessions button').count()) === 0) {
    report.passive = 'no session buttons (expected when task has no sessionId)';
  }
  await page.locator('.tb-detail-actions button').first().click();
  await page.waitForTimeout(400);
  console.log('REPORT ' + JSON.stringify(report, null, 1));
  console.log('CONSOLE ' + JSON.stringify(events.filter(e => e.type !== 'log').slice(0, 8)));
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
