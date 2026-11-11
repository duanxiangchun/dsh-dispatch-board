const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const deadline = Date.now() + 90000;
  let last = '';
  while (Date.now() < deadline) {
    const url = page.url();
    const title = await page.title().catch(() => '');
    if (url !== last) { console.log('now:', url, '|', title); last = url; }
    if (!/login/.test(url)) break;
    await page.waitForTimeout(2000);
  }
  const url = page.url();
  console.log('final url:', url);
  const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : '');
  console.log('text:', JSON.stringify(text));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-after-login.png' }).catch(() => {});
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
