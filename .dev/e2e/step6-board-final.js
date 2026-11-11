const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch(e){} }
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: OUT + '/shots/step6-board-final.png' });
  const txt = await page.evaluate(() => document.body.innerText);
  const i = txt.indexOf('任务看板');
  console.log(txt.slice(i, i + 2200));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
