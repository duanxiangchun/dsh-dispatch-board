const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/settings/duanxc/tokens', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('goto err', e.message));
  await page.waitForTimeout(4000);
  console.log('url:', page.url());
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log('TEXT\n' + text);
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll('button, a[role=button]')).map(b => (b.innerText || '').trim()).filter(t => t));
  console.log('BUTTONS ' + JSON.stringify(buttons.slice(0, 30)));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-tokens.png' });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
