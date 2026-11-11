const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/settings/duanxc/staged-packages', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => console.log('goto', e.message));
  await page.waitForTimeout(3500);
  const info = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.slice(0, 1200),
    buttons: Array.from(document.querySelectorAll('button')).map(b => (b.innerText||'').trim()).filter(Boolean),
  }));
  console.log('URL ' + info.url);
  console.log('TEXT\n' + info.text);
  console.log('BUTTONS ' + JSON.stringify(info.buttons));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-staged.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
