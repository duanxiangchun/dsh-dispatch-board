const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  // dismiss preview note if present
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); console.log('dismissed preview note'); } catch(e){} }
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + '/shots/step1-home-sidebar.png' });
  console.log('step1 screenshot saved');

  // click taskboard sidebar button
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(4000);
  console.log('url after click:', page.url());
  await page.screenshot({ path: OUT + '/shots/step2-board-page.png' });
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  console.log('=== BODY TEXT AFTER CLICK ===');
  console.log(txt);
  // dump board DOM
  const html = await page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    return main.innerHTML.length > 6000 ? main.innerHTML.slice(0, 6000) : main.innerHTML;
  });
  console.log('=== MAIN HTML (first 6000) ===');
  console.log(html);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
