const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const results = {};
  for (const url of [
    'https://www.npmjs.com/package/dsh-dispatch-board',
    'https://www.npmjs.com/package/dsh-dispatch-board/access',
  ]) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => { results[url] = 'goto ' + e.message; });
    await page.waitForTimeout(3000);
    results[url] = {
      actualUrl: page.url(),
      text: (await page.evaluate(() => document.body.innerText.slice(0, 900))),
    };
  }
  console.log(JSON.stringify(results, null, 1));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-pkg-access.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
