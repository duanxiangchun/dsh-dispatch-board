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
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 400) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 400) }));
  page.on('dialog', d => d.accept().catch(() => {}));
  const data = {};
  const headBadge = () => page.evaluate(() => { const b = document.querySelector('.tb-headbtn .tb-badge'); return b ? b.textContent.trim() : null; });

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(7000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  const row = page.getByText('派单模式自检', { exact: true }).first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(3000); }
  data.headBadgeBefore = await headBadge();
  await page.locator('.tb-headbtn').first().click();
  await page.waitForTimeout(2500);
  // pause poll, add temp task -> header badge appears
  const pause = page.getByRole('button', { name: '暂停轮询', exact: true });
  if (await pause.count()) { await pause.click(); await page.waitForTimeout(700); data.paused = true; }
  await page.locator('input.tb-input').fill('RS 验证：角标与引导页');
  await page.getByRole('button', { name: '添加到待开始', exact: true }).click();
  let badge = null;
  for (let i = 0; i < 10; i++) { await sleep(1000); badge = await headBadge(); if (badge) break; }
  data.headBadgeAfter = badge;
  console.log('HEAD BADGE:', data.headBadgeBefore, '->', badge);
  await page.screenshot({ path: OUT + '/shots/rb-01-header-entry.png' });
  // delete temp task
  const card = page.locator('.tb-card').filter({ hasText: 'RS 验证：角标与引导页' }).first();
  if (await card.count()) { await card.getByRole('button', { name: '删除' }).click(); await page.waitForTimeout(2000); }
  data.headBadgeAfterDelete = await headBadge();
  console.log('HEAD BADGE AFTER DELETE:', data.headBadgeAfterDelete);
  const resume = page.getByRole('button', { name: '恢复轮询', exact: true });
  if (await resume.count()) { await resume.click(); await page.waitForTimeout(700); }

  // close the only tab -> expect guide page (or collapsed sidebar)
  const closeBtn = page.getByRole('button', { name: '关闭', exact: true });
  data.closeCount = await closeBtn.count();
  if (await closeBtn.count()) { await closeBtn.first().click(); await page.waitForTimeout(2000); }
  data.tbPageAfterClose = await page.locator('.tb-page').count();
  // open right sidebar if collapsed
  const openBtn = page.getByRole('button', { name: '打开右侧边栏', exact: true });
  data.openBtnCount = await openBtn.count();
  if (await openBtn.count() && data.tbPageAfterClose === 0) { await openBtn.first().click(); await page.waitForTimeout(2000); }
  data.rightPaneText = await page.evaluate(() => {
    const surfaces = Array.from(document.querySelectorAll('[data-dockkit-surface], [class*="sidebarRight"], [class*="rightPane"]'));
    const el = surfaces.length ? surfaces[surfaces.length - 1] : document.body;
    return el.innerText.slice(0, 1500);
  });
  console.log('RIGHT PANE TEXT AFTER CLOSE:', JSON.stringify(data.rightPaneText).slice(0, 1500));
  await page.screenshot({ path: OUT + '/shots/rb-08-guide.png' });
  // find and click guide entry card (contains 任务看板 + guide description)
  data.guideCandidates = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, [role=button], [class*="guide"], [class*="Guide"], [class*="empty"], [class*="card"], [class*="Card"]'))
      .filter(e => { const t = (e.innerText || '').trim(); return t.includes('任务看板'); })
      .map(e => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 90), text: (e.innerText || '').trim().slice(0, 120) })).slice(0, 10);
  });
  console.log('GUIDE CANDIDATES:', JSON.stringify(data.guideCandidates));
  let clicked = false;
  const cand = page.locator('button, [role=button]').filter({ hasText: '任务看板' }).last();
  if (await cand.count()) { await cand.click().catch(e => console.log('click err', e.message)); clicked = true; await page.waitForTimeout(2500); }
  data.afterGuideClick = { clicked, tbPage: await page.locator('.tb-page').count(), layout: await page.evaluate(() => { const p = document.querySelector('.tb-page'); return p ? p.getAttribute('data-layout') : null; }) };
  console.log('AFTER GUIDE CLICK:', JSON.stringify(data.afterGuideClick));
  await page.screenshot({ path: OUT + '/shots/rb-09-guide-open-board.png' });

  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/rb-guide-data.json', JSON.stringify(data, null, 1));
  fs.writeFileSync(OUT + '/shots/rb-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-150) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
