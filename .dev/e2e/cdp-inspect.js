const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  console.log('pages:', pages.length);
  for (const p of pages) console.log(' -', p.url());
  const page = pages[0] || await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
  console.log('url:', page.url());
  console.log('title:', await page.title().catch(e => 'ERR ' + e.message));
  const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 400) : '').catch(() => '');
  console.log('text:', JSON.stringify(body));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-login.png' }).catch(e => console.log('shot err', e.message));
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
