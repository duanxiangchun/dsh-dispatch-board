const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
async function snap() {
  const id = 'rg3-' + Math.random().toString(36).slice(2);
  const r = await fetch(BASE + '/taskboard/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method: 'snapshot', payload: {} }) });
  return (await r.json()).result.value;
}
(async () => {
  const consoleEvents = [];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 300) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: e.message }));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(7000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  // open 派单模式自检 session so its agent is live
  const row = page.getByText('派单模式自检', { exact: true }).first();
  console.log('派单模式自检 row count:', await row.count());
  if (await row.count()) { await row.click(); await page.waitForTimeout(3000); }
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(3000);
  const options = await page.evaluate(() => {
    const sel = document.querySelector('select.tb-select[aria-label="派发给"]');
    return sel ? Array.from(sel.options).map(o => o.textContent) : null;
  });
  console.log('OPTIONS:', JSON.stringify(options));
  // select the dispatch-mode option so the closed select shows "<id> · 派单看板模式"
  const idx = await page.evaluate(() => {
    const sel = document.querySelector('select.tb-select[aria-label="派发给"]');
    if (!sel) return -1;
    for (let i = 0; i < sel.options.length; i++) if (sel.options[i].textContent.includes('派单看板模式')) return i;
    return -1;
  });
  if (idx >= 0) {
    await page.selectOption('select.tb-select[aria-label="派发给"]', { index: idx });
    await page.waitForTimeout(800);
  }
  await page.screenshot({ path: OUT + '/shots/regress-target-select.png' });
  const shown = await page.evaluate(() => { const s = document.querySelector('select.tb-select[aria-label="派发给"]'); return s && s.selectedOptions[0] ? s.selectedOptions[0].textContent : ''; });
  const agents = (await snap()).agents;
  console.log('SELECTED SHOWN:', shown);
  console.log('AGENTS:', JSON.stringify(agents));
  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  fs.writeFileSync(OUT + '/shots/regress-select-data.json', JSON.stringify({ options, shown, agents, console: { total: consoleEvents.length, errors } }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
