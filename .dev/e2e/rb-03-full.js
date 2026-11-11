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
  page.on('dialog', d => { console.log('[dialog]', d.message()); d.accept().catch(() => {}); });
  const data = {};
  const measure = () => page.evaluate(() => {
    const p = document.querySelector('.tb-page');
    const board = document.querySelector('.tb-board');
    const lanes = document.querySelector('.tb-lanes');
    const cs = board ? getComputedStyle(board) : null;
    const rect = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
    return {
      layout: p ? p.getAttribute('data-layout') : null,
      narrow: p ? p.getAttribute('data-narrow') : null,
      pageRect: rect(p),
      board: !!board, lanes: !!lanes,
      boardCols: document.querySelectorAll('.tb-board .tb-col').length,
      laneCols: lanes ? lanes.querySelectorAll('.tb-col').length : 0,
      gridTemplateColumns: cs ? cs.gridTemplateColumns : null,
      laneTitles: lanes ? Array.from(lanes.querySelectorAll('.tb-colname')).map(e => e.innerText.trim()) : [],
      tabTitles: Array.from(document.querySelectorAll('.tb-tabtitle')).map(e => e.innerText.trim()),
    };
  });
  const leftMenu = () => page.evaluate(() => Array.from(document.querySelectorAll('[class*="panelRow"]')).map(b => (b.innerText || '').trim().slice(0, 30)));
  const pauseBtn = () => page.getByRole('button', { name: '暂停轮询', exact: true });
  const resumeBtn = () => page.getByRole('button', { name: '恢复轮询', exact: true });

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(7000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  const row = page.getByText('派单模式自检', { exact: true }).first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(3000); }

  // (5) left menu must not have board entry
  data.leftMenu = await leftMenu();
  // (1) header entry button
  data.headBtn = await page.evaluate(() => {
    const b = document.querySelector('.tb-headbtn');
    return b ? { aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), badge: (b.querySelector('.tb-badge') || {}).textContent || null } : null;
  });
  console.log('LEFT MENU:', JSON.stringify(data.leftMenu));
  console.log('HEAD BTN:', JSON.stringify(data.headBtn));
  await page.screenshot({ path: OUT + '/shots/rb-01-header-entry.png' });

  // open right sidebar board tab
  await page.locator('.tb-headbtn').first().click();
  await page.waitForTimeout(3000);
  data.medium = await measure();
  console.log('LAYOUT DEFAULT:', JSON.stringify(data.medium));
  await page.screenshot({ path: OUT + '/shots/rb-02-panel-default.png' });

  // (2) pause poll, add task, verify card, delete
  if (await pauseBtn().count()) { await pauseBtn().click(); await page.waitForTimeout(800); data.paused = true; }
  else data.paused = false;
  await page.locator('input.tb-input').fill('RS 验证：面板内新增任务');
  await page.getByRole('button', { name: '添加到待开始', exact: true }).click();
  await page.waitForTimeout(2500);
  const cardInfo = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.tb-card')).map(c => ({ text: c.innerText.replace(/\n/g, ' | ').slice(0, 120) }));
    return cards;
  });
  data.cardsAfterAdd = cardInfo;
  console.log('CARDS AFTER ADD:', JSON.stringify(cardInfo));
  await page.screenshot({ path: OUT + '/shots/rb-03-task-added.png' });
  const card = page.locator('.tb-card').filter({ hasText: 'RS 验证：面板内新增任务' }).first();
  data.cardFound = await card.count() > 0;
  if (await card.count()) {
    await card.getByRole('button', { name: '删除' }).click();
    await page.waitForTimeout(2000);
  }
  data.cardsAfterDelete = await page.evaluate(() => Array.from(document.querySelectorAll('.tb-card')).map(c => c.innerText.replace(/\n/g, ' | ').slice(0, 80)));
  console.log('CARDS AFTER DELETE:', JSON.stringify(data.cardsAfterDelete));
  await page.screenshot({ path: OUT + '/shots/rb-04-task-deleted.png' });
  if (data.paused && await resumeBtn().count()) { await resumeBtn().click(); await page.waitForTimeout(800); }

  // (3a) fullscreen -> four columns
  const fsBtn = page.getByRole('button', { name: '全屏', exact: true });
  data.fullscreenBtnCount = await fsBtn.count();
  if (await fsBtn.count()) { await fsBtn.first().click(); await page.waitForTimeout(2500); }
  data.fullscreen = await measure();
  console.log('FULLSCREEN:', JSON.stringify(data.fullscreen));
  await page.screenshot({ path: OUT + '/shots/rb-05-fullscreen.png' });
  // exit fullscreen (button may now be 退出全屏 / same 全屏)
  const exitBtn = page.getByRole('button', { name: /全屏|退出全屏/ }).first();
  const exitLabel = await exitBtn.count() ? await exitBtn.getAttribute('aria-label') : null;
  data.exitLabel = exitLabel;
  if (await exitBtn.count()) { await exitBtn.click(); await page.waitForTimeout(2500); }
  data.afterFullscreen = await measure();
  console.log('AFTER FULLSCREEN:', JSON.stringify(data.afterFullscreen));
  await page.screenshot({ path: OUT + '/shots/rb-06-after-fullscreen.png' });

  // (3b) try dragging pane narrow to <560
  const before = await page.evaluate(() => { const p = document.querySelector('.tb-page'); const r = p.getBoundingClientRect(); return { left: Math.round(r.left), w: Math.round(r.width) }; });
  data.paneBeforeDrag = before;
  let dragged = null;
  for (const target of [1200, 1300, 1400]) {
    try {
      await page.mouse.move(before.left - 2, 500);
      await page.mouse.down();
      await page.mouse.move(target, 500, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(1200);
      const now = await page.evaluate(() => { const p = document.querySelector('.tb-page'); const r = p.getBoundingClientRect(); return { left: Math.round(r.left), w: Math.round(r.width), layout: p.getAttribute('data-layout') }; });
      console.log('DRAG ->', JSON.stringify(now));
      dragged = now;
      if (now.layout === 'narrow') break;
    } catch (e) { console.log('drag err', e.message); }
  }
  data.dragResult = dragged;
  data.narrowState = await measure();
  console.log('NARROW STATE:', JSON.stringify(data.narrowState));
  await page.screenshot({ path: OUT + '/shots/rb-07-narrow-lane.png' });

  // (4) guide page: close tab -> guide entries; click taskboard card
  const closeBtn = page.getByRole('button', { name: '关闭', exact: true });
  data.closeBtnCount = await closeBtn.count();
  if (await closeBtn.count()) { await closeBtn.first().click(); await page.waitForTimeout(2000); }
  data.guide = await page.evaluate(() => ({
    text: document.body.innerText.slice(-1500),
    hasGuideEntry: Array.from(document.querySelectorAll('*')).some(e => e.children.length === 0 && (e.innerText || '').trim() === '任务看板'),
  }));
  console.log('GUIDE TEXT TAIL:', JSON.stringify(data.guide.text).slice(0, 1500));
  await page.screenshot({ path: OUT + '/shots/rb-08-guide.png' });
  // click guide taskboard entry
  const guideEntry = page.getByText('任务看板', { exact: true }).last();
  data.guideEntryCount = await page.getByText('任务看板', { exact: true }).count();
  if (await guideEntry.count()) { await guideEntry.click().catch(e => console.log('guide click err', e.message)); await page.waitForTimeout(2500); }
  data.afterGuideClick = await measure();
  console.log('AFTER GUIDE CLICK:', JSON.stringify(data.afterGuideClick));
  await page.screenshot({ path: OUT + '/shots/rb-09-guide-open-board.png' });

  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/rb-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-120) }, null, 1));
  fs.writeFileSync(OUT + '/shots/rb-data.json', JSON.stringify(data, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)));
  console.log('DATA_WRITTEN');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
