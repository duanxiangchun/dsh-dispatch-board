const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const consoleEvents = [];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 500) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 500) }));
  page.on('dialog', d => d.accept().catch(() => {}));
  const badgeText = () => page.evaluate(() => { const b = document.querySelector('[aria-label="任务看板"] .tb-badge'); return b ? (b.textContent || '').trim() : null; });
  const boardText = () => page.evaluate(() => document.body.innerText);

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(7000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(3500);
  await page.screenshot({ path: OUT + '/shots/regress-board.png' });
  const layout = await page.evaluate(() => {
    const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
    return { vh: window.innerHeight, scrollH: document.documentElement.scrollHeight, board: r(document.querySelector('.tb-board')), cols: Array.from(document.querySelectorAll('.tb-col')).map(c => ({ s: c.getAttribute('data-status'), ...r(c) })) };
  });
  const body = await boardText();
  const headerLine = (body.split('\n').find(l => l.includes('上次派发')) || '').trim();
  const todoCountText = (body.match(/待开始\n(\d+)/) || [])[1];
  console.log('LAYOUT:', JSON.stringify(layout));
  console.log('HEADER:', headerLine);
  console.log('TODO COUNT:', todoCountText);
  const before = await badgeText();
  console.log('BADGE BEFORE:', before);

  // pause polling so the temp task can't be dispatched before deletion
  await page.getByRole('button', { name: '暂停轮询', exact: true }).click();
  await page.waitForTimeout(800);
  await page.locator('input.tb-input').fill('回归角标测试任务');
  await page.getByRole('button', { name: '添加到待开始' }).click();
  let appeared = null;
  for (let i = 0; i < 10; i++) { await sleep(1000); appeared = await badgeText(); if (appeared) break; }
  console.log('BADGE AFTER CREATE:', appeared);
  await page.screenshot({ path: OUT + '/shots/regress-badge.png' });
  const card = page.locator('.tb-card').filter({ hasText: '回归角标测试任务' }).first();
  console.log('card count:', await card.count());
  await card.getByRole('button', { name: '删除' }).click();
  await page.waitForTimeout(1200);
  let gone = null;
  const trail = [];
  for (let i = 0; i < 12; i++) { gone = await badgeText(); trail.push(gone); if (!gone) break; await sleep(1000); }
  console.log('BADGE AFTER DELETE:', gone, 'trail:', JSON.stringify(trail));
  await page.screenshot({ path: OUT + '/shots/regress-badge-after.png' });
  await page.getByRole('button', { name: '恢复轮询', exact: true }).click();
  await page.waitForTimeout(1000);
  const bodyAfter = await boardText();
  console.log('TODO COUNT AFTER:', (bodyAfter.match(/待开始\n(\d+)/) || [])[1]);
  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  fs.writeFileSync(OUT + '/shots/regress-badge-data.json', JSON.stringify({ layout, headerLine, before, appeared, gone, trail, console: { total: consoleEvents.length, errors } }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
