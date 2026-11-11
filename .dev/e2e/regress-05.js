const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'rg2-' + Math.random().toString(36).slice(2);
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }) });
  const j = await r.json();
  return j.result;
}
async function snap() { const res = await rpc('snapshot'); return res.value; }
(async () => {
  const consoleEvents = [];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 500) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 500) }));
  page.on('dialog', d => d.accept().catch(() => {}));
  const data = {};
  const badgeText = () => page.evaluate(() => { const b = document.querySelector('[aria-label="任务看板"] .tb-badge'); return b ? (b.textContent || '').trim() : null; });
  const boardText = () => page.evaluate(() => document.body.innerText);
  const headerLine = t => (t.split('\n').find(l => l.includes('上次派发')) || '').trim();

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(7000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: OUT + '/shots/regress-board.png' });
  data.layout = await page.evaluate(() => {
    const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
    return { vh: window.innerHeight, scrollH: document.documentElement.scrollHeight, board: r(document.querySelector('.tb-board')), cols: Array.from(document.querySelectorAll('.tb-col')).map(c => ({ s: c.getAttribute('data-status'), ...r(c) })), badge: (document.querySelector('[aria-label="任务看板"] .tb-badge') || {}).textContent || null };
  });
  console.log('LAYOUT:', JSON.stringify(data.layout));

  // --- header: wait for the leftover regression task t-8 to be dispatched
  data.dispatch = null;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const s = await snap();
    if (s.poll.lastDispatchAt) { data.dispatch = s.poll; break; }
  }
  console.log('DISPATCH:', JSON.stringify(data.dispatch));
  await page.waitForTimeout(1000);
  const txt1 = await boardText();
  data.headerLine = headerLine(txt1);
  console.log('HEADER LINE:', data.headerLine);
  await page.screenshot({ path: OUT + '/shots/regress-board-header.png' });

  // --- badge test (pause poll to keep the created task from being dispatched)
  await page.getByRole('button', { name: '暂停轮询', exact: true }).click();
  await page.waitForTimeout(1000);
  data.badge = { before: await badgeText() };
  await page.locator('input.tb-input').fill('回归角标测试任务');
  await page.getByRole('button', { name: '添加到待开始' }).click();
  let appeared = null;
  for (let i = 0; i < 10; i++) { await sleep(1000); appeared = await badgeText(); if (appeared) break; }
  data.badge.appeared = appeared;
  await page.screenshot({ path: OUT + '/shots/regress-badge.png' });
  const card = page.locator('.tb-card').filter({ hasText: '回归角标测试任务' }).first();
  await card.getByRole('button', { name: '删除' }).click();
  await page.waitForTimeout(1200);
  let gone = null;
  for (let i = 0; i < 12; i++) { gone = await badgeText(); if (!gone) break; await sleep(1000); }
  data.badge.gone = gone;
  await page.screenshot({ path: OUT + '/shots/regress-badge-after.png' });
  console.log('BADGE:', JSON.stringify(data.badge));
  await page.getByRole('button', { name: '恢复轮询', exact: true }).click();
  await page.waitForTimeout(800);

  // --- dropdown labels: open existing 「派单模式自检」 session (make it live), then board
  const row = page.getByText('派单模式自检', { exact: true }).first();
  console.log('派单模式自检 row count:', await row.count());
  if (await row.count()) { await row.click(); await page.waitForTimeout(3000); }
  data.sessionOpened = (await boardText()).includes('派单模式自检');
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(2500);
  const opts = await page.evaluate(() => {
    const sel = document.querySelector('select.tb-select[aria-label="派发给"]');
    return sel ? Array.from(sel.options).map(o => ({ value: o.value, text: o.textContent })) : null;
  });
  data.targetOptions = opts;
  data.agents = (await snap()).agents;
  console.log('TARGET OPTIONS:', JSON.stringify(opts));
  console.log('AGENTS:', JSON.stringify(data.agents));
  await page.screenshot({ path: OUT + '/shots/regress-target-select.png' });
  // pick a titled/dispatch option for visual
  if (opts) {
    const pick = opts.find(o => o.text.includes('派单看板模式')) || opts[1];
    if (pick) { await page.selectOption('select.tb-select[aria-label="派发给"]', pick.value); await page.waitForTimeout(600); }
  }
  await page.screenshot({ path: OUT + '/shots/regress-target-select-value.png' });

  // --- wait for leftover task t-8 to finish, then archive+delete it (cleanup)
  let finalStatus = 'unknown';
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const s = await snap();
    const t = s.tasks.find(x => x.title === '回归：头部派发对象标签检查');
    finalStatus = t ? t.status : 'missing';
    if (!t || t.status === 'done' || t.status === 'archived') break;
  }
  data.leftoverTaskStatus = finalStatus;
  console.log('LEFTOVER TASK STATUS:', finalStatus);
  try {
    const s = await snap();
    const t = s.tasks.find(x => x.title === '回归：头部派发对象标签检查');
    if (t) {
      if (t.status === 'done') await rpc('update-task', { id: t.id, status: 'archived' });
      else if (t.status === 'doing') { await rpc('update-task', { id: t.id, status: 'todo' }); await rpc('update-task', { id: t.id, status: 'archived' }); }
      await rpc('delete-task', { id: t.id });
      console.log('cleanup: deleted', t.id);
    }
  } catch (e) { console.log('cleanup failed', e.message); }
  await page.screenshot({ path: OUT + '/shots/regress-board-final.png' });

  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/regress-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-120) }, null, 1));
  fs.writeFileSync(OUT + '/shots/regress-data.json', JSON.stringify(data, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)));
  console.log('DATA_JSON_WRITTEN');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });