const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('.tb-head select'));
    const dispatch = selects.find(s => s.getAttribute('aria-label') === '派发到');
    return {
      selectCount: selects.length,
      dispatchValue: dispatch ? dispatch.value : null,
      options: dispatch ? Array.from(dispatch.options).map(o => o.textContent) : [],
      hasNewChatOption: dispatch ? Array.from(dispatch.options).some(o => o.textContent === '新对话') : false,
    };
  });
  console.log('INFO ' + JSON.stringify(info));
  await page.screenshot({ path: OUT + '/shots/dispatch-mode.png' });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });