const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 160)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(7000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const pageEl = document.querySelector('.tb-page');
    const css = document.querySelector('style[data-plugin-css]');
    return {
      boardRendered: Boolean(pageEl),
      canvasBg: pageEl ? getComputedStyle(pageEl).backgroundColor : null,
      cssTag: css ? css.getAttribute('data-plugin-css') : null,
      cardCount: document.querySelectorAll('.tb-card, .tb-col').length,
    };
  });
  console.log('INFO ' + JSON.stringify(info));
  console.log('ERRORS ' + JSON.stringify(errors.slice(0, 5)));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/renamed-load.png' });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
