const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/settings/duanxc/tokens/granular-access-tokens/new', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const cb = document.querySelector('input[name="bypass2FA"]');
    return {
      url: location.href,
      hasBypass: Boolean(cb),
      bypassDisabled: cb ? cb.disabled : null,
      bypassChecked: cb ? cb.checked : null,
      bypassVisible: cb ? !!(cb.offsetParent) : null,
      bodyHint: document.body.innerText.slice(0, 200).replace(/\n+/g, ' | '),
    };
  });
  console.log('BYPASS ' + JSON.stringify(info));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-bypass-check.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
