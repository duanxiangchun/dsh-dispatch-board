const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/settings/duanxc/staged-packages', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3500);
  const info = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.slice(0, 1500),
    buttons: Array.from(document.querySelectorAll('button')).map(b => ({ text: (b.innerText||'').trim(), visible: !!b.offsetParent })).filter(b => b.text),
  }));
  fs.writeFileSync(process.env.OUT_DIR + '/tmp-staged-now.json', JSON.stringify(info, null, 1), 'utf8');
  console.log('WROTE ' + info.url);
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-staged-now.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
