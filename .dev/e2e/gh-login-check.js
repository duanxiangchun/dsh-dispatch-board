const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://github.com/duanxiangchun/dsh-dispatch-board', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => ({
    url: location.href,
    loggedIn: !!document.querySelector('summary[aria-label="View profile and more"], img.avatar, [data-login]'),
    text: document.body.innerText.slice(0, 300).replace(/\n+/g, ' | '),
  }));
  console.log(JSON.stringify(info));
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
