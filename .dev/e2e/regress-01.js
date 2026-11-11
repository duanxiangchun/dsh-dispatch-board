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
  page.on('console', m => { consoleEvents.push({ type: m.type(), text: m.text().slice(0, 500) }); });
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 500) }));
  page.on('dialog', d => { console.log('[dialog]', d.message()); d.accept().catch(() => {}); });

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }

  // ---------- 1) board layout + header ----------
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: OUT + '/shots/regress-board.png' });
  const layout = await page.evaluate(() => {
    const rect = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) }; };
    const board = document.querySelector('.tb-board');
    const cols = Array.from(document.querySelectorAll('.tb-col'));
    const foot = document.querySelector('.tb-foot');
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      docScrollHeight: document.documentElement.scrollHeight,
      board: rect(board),
      columns: cols.map(c => ({ status: c.getAttribute('data-status'), ...rect(c) })),
      footer: rect(foot),
    };
  });
  console.log('LAYOUT:', JSON.stringify(layout, null, 1));
  const boardBody = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync(OUT + '/shots/regress-board-body.txt', boardBody);
  const headerLine = boardBody.split('\n').find(l => l.includes('上次派发') || l.includes('轮询')) || '';
  console.log('HEADER LINE:', headerLine);
  const footerLine = boardBody.split('\n').find(l => l.includes('数据文件')) || '';
  console.log('FOOTER:', footerLine);

  // ---------- 2) target select with mode names ----------
  const sessionRow = page.getByText('派单模式自检', { exact: true }).first();
  console.log('session row count:', await sessionRow.count());
  if (await sessionRow.count()) { await sessionRow.click(); await page.waitForTimeout(3500); console.log('session opened (live agent should exist)'); }
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(3000);
  const targetOpts = await page.evaluate(() => {
    const sel = document.querySelector('select.tb-select[aria-label="派发给"]');
    if (!sel) return { found: false };
    return { found: true, value: sel.value, options: Array.from(sel.options).map(o => ({ value: o.value, text: o.textContent })) };
  });
  console.log('TARGET SELECT:', JSON.stringify(targetOpts, null, 1));
  // pick the dispatch-mode session option if present, else first non-auto
  if (targetOpts.found) {
    const pick = targetOpts.options.find(o => o.text.includes('派单模式自检')) || targetOpts.options[1];
    if (pick) {
      await page.selectOption('select.tb-select[aria-label="派发给"]', pick.value);
      await page.waitForTimeout(800);
      const shown = await page.evaluate(() => document.querySelector('select.tb-select[aria-label="派发给"]').selectedOptions[0]?.textContent || '');
      console.log('SELECTED SHOWN:', shown);
    }
  }
  await page.screenshot({ path: OUT + '/shots/regress-target-select.png' });

  // reset target to auto before badge test
  try { await page.selectOption('select.tb-select[aria-label="派发给"]', ''); } catch (e) {}

  // ---------- 3) sidebar badge appears then disappears ----------
  const badgeState = async () => page.evaluate(() => {
    const btn = document.querySelector('[aria-label="任务看板"]');
    if (!btn) return { found: false };
    const badge = btn.querySelector('.tb-badge');
    return { found: true, text: (btn.innerText || '').trim(), html: btn.innerHTML.slice(0, 400), badge: badge ? (badge.textContent || '').trim() : null };
  });
  const before = await badgeState();
  console.log('BADGE BEFORE:', JSON.stringify(before));
  // create task
  await page.locator('input.tb-input').fill('回归角标测试任务');
  await page.getByRole('button', { name: '添加到待开始' }).click();
  await page.waitForTimeout(2500);
  const during = await badgeState();
  console.log('BADGE DURING:', JSON.stringify(during));
  await page.screenshot({ path: OUT + '/shots/regress-badge.png' });
  // delete the created card
  const card = page.locator('.tb-card').filter({ hasText: '回归角标测试任务' }).first();
  console.log('badge-test card count:', await card.count());
  if (await card.count()) {
    await card.getByRole('button', { name: '删除' }).click();
    await page.waitForTimeout(2500);
  }
  const after = await badgeState();
  console.log('BADGE AFTER:', JSON.stringify(after));
  await page.screenshot({ path: OUT + '/shots/regress-badge-after.png' });

  // ---------- 4) console ----------
  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  fs.writeFileSync(OUT + '/shots/regress-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-80) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10), null, 1));
  console.log('REGRESS_RESULT=' + JSON.stringify({
    colHeights: layout.columns.map(c => c.height),
    colBottom: layout.columns.map(c => c.bottom),
    headerLine, targetOptions: (targetOpts.options || []).map(o => o.text),
    badgeBefore: before.badge, badgeDuring: during.badge, badgeAfter: after.badge,
    consoleErrors: errors.length,
  }));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
