const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console.' + m.type() + ']', m.text().slice(0, 300)); });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(7000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  // open an existing session
  const row = page.getByText('派单模式自检', { exact: true }).first();
  console.log('session row count:', await row.count());
  if (await row.count()) { await row.click(); await page.waitForTimeout(3000); }
  else {
    // fallback: open first session by clicking any session row
    const any = page.locator('[class*="sessionRow"]').first();
    if (await any.count()) { await any.click(); await page.waitForTimeout(3000); }
  }
  await page.screenshot({ path: OUT + '/shots/explore-rightbar-01-session.png' });
  const state = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).map(b => ({ aria: b.getAttribute('aria-label') || '', title: b.getAttribute('title') || '', cls: (b.className || '').toString().slice(0, 60), text: (b.innerText || '').trim().slice(0, 30) }));
    const menuButtons = Array.from(document.querySelectorAll('[class*="panelRow"], [class*="panellist"] button')).map(b => ({ aria: b.getAttribute('aria-label') || '', text: (b.innerText || '').trim().slice(0, 40) }));
    return {
      headbtn: document.querySelectorAll('.tb-headbtn').length,
      tabs: document.querySelectorAll('[class*="tab"]').length,
      leftMenuButtons: menuButtons,
      headerButtons: btns.filter(b => b.aria || b.title).slice(0, 60),
      bodyStart: document.body.innerText.slice(0, 600),
    };
  });
  console.log('STATE:', JSON.stringify(state).slice(0, 6000));
  // click header board button
  const hb = page.locator('.tb-headbtn').first();
  console.log('tb-headbtn count:', await page.locator('.tb-headbtn').count());
  if (await hb.count()) {
    await hb.click({ timeout: 5000 }).catch(e => console.log('click err', e.message));
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: OUT + '/shots/explore-rightbar-02-panel.png' });
  const panel = await page.evaluate(() => {
    const pageEl = document.querySelector('.tb-page');
    const pane = document.querySelector('.tb-page') ? document.querySelector('.tb-page').closest('[class*="pane"],[class*="sidebar"],[class*="right"]') : null;
    const btns = Array.from(document.querySelectorAll('button')).map(b => ({ aria: b.getAttribute('aria-label') || '', title: b.getAttribute('title') || '', cls: (b.className || '').toString().slice(0, 70), text: (b.innerText || '').trim().slice(0, 24) })).filter(b => b.aria || b.title);
    return {
      tbPage: pageEl ? { narrow: pageEl.getAttribute('data-narrow'), cls: pageEl.className, w: Math.round(pageEl.getBoundingClientRect().width) } : null,
      lanes: document.querySelectorAll('.tb-lanes').length,
      laneCols: document.querySelectorAll('.tb-lanes .tb-col').length,
      boards: document.querySelectorAll('.tb-board').length,
      boardCols: document.querySelectorAll('.tb-board .tb-col').length,
      tabTitles: Array.from(document.querySelectorAll('.tb-tabtitle')).map(e => e.innerText.trim()),
      paneRect: pane ? { w: Math.round(pane.getBoundingClientRect().width), h: Math.round(pane.getBoundingClientRect().height) } : null,
      buttons: btns.slice(0, 50),
    };
  });
  console.log('PANEL:', JSON.stringify(panel).slice(0, 7000));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
