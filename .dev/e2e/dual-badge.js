const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
async function snap() {
  const r = await fetch(BASE + '/taskboard/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'b' + Math.random(), method: 'snapshot', payload: {} }) });
  return (await r.json()).result.value;
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(7000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  const read = async () => {
    const badge = await page.evaluate(() => { const b = document.querySelector('[aria-label="平台任务看板"] .tb-badge'); return b ? b.textContent.trim() : null; });
    const s = await snap();
    const counts = { todo: s.tasks.filter(t => t.status === 'todo').length, doing: s.tasks.filter(t => t.status === 'doing').length };
    return { badge, counts, expected: counts.todo + counts.doing };
  };
  const first = await read();
  console.log('BADGE1:', JSON.stringify(first));
  await page.screenshot({ path: OUT + '/shots/dual-08-platform-badge.png' });
  await page.waitForTimeout(20000);
  const second = await read();
  console.log('BADGE2:', JSON.stringify(second));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
