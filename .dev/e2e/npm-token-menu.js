const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/settings/duanxc/tokens', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const gen = page.getByText('Generate New Token', { exact: false }).first();
  console.log('gen count:', await page.getByText('Generate New Token', { exact: false }).count());
  await gen.click({ timeout: 10000 }).catch(e => console.log('click err', e.message));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-token-menu.png' });
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a,button,li')).map(n => ({ tag: n.tagName, text: (n.innerText||'').trim().slice(0,60), href: n.getAttribute && n.getAttribute('href') })).filter(o => o.text && o.text.length < 60));
  console.log('ITEMS ' + JSON.stringify(links.slice(-25)));
  console.log('URL', page.url());
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
