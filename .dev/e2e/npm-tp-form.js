const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/package/dsh-dispatch-board/access', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3500);
  // 点击 GitHub Actions 发布者选项
  const gh = page.getByText('GitHub Actions', { exact: true }).first();
  console.log('gh count', await gh.count());
  await gh.click({ force: true, timeout: 8000 }).catch(e => console.log('click err', e.message));
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder }));
    const selects = Array.from(document.querySelectorAll('select')).map(s => ({ name: s.name, id: s.id, options: Array.from(s.options).map(o => o.value) }));
    const buttons = Array.from(document.querySelectorAll('button')).map(b => (b.innerText || '').trim()).filter(Boolean);
    const text = document.body.innerText.slice(0, 1600);
    return { inputs, selects, buttons, text };
  });
  console.log('INPUTS ' + JSON.stringify(info.inputs));
  console.log('SELECTS ' + JSON.stringify(info.selects));
  console.log('BUTTONS ' + JSON.stringify(info.buttons));
  console.log('TEXT\n' + info.text);
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-trusted-publisher.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
