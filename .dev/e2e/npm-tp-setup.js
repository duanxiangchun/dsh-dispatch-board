const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/package/dsh-dispatch-board/access', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.getByText('GitHub Actions', { exact: true }).first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(1200);
  const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder || '' })));
  console.log('INPUTS ' + JSON.stringify(inputs));
  const fill = async (labelRe, value) => {
    const loc = page.getByLabel(labelRe).first();
    if (await loc.count()) { await loc.fill(value); console.log('filled', String(labelRe), '=', value); return true; }
    console.log('missing label', String(labelRe));
    return false;
  };
  await fill(/Organization or user/i, 'duanxiangchun');
  await fill(/^Repository/i, 'dsh-dispatch-board');
  await fill(/Workflow filename/i, 'publish.yml');
  await fill(/^Label/i, 'dsh-dispatch-board CI');
  // Allow npm publish
  const allow = page.getByLabel(/Allow npm publish/i).first();
  if (await allow.count()) { await allow.check({ force: true }); console.log('checked allow publish'); } else console.log('allow publish checkbox missing');
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-tp-filled.png', fullPage: true });
  await page.getByRole('button', { name: /Set up connection/i }).first().click({ timeout: 10000 }).catch(e => console.log('submit err', e.message));
  await page.waitForTimeout(3500);
  const after = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 1200) }));
  console.log('AFTER URL ' + after.url);
  console.log('AFTER TEXT\n' + after.text);
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-tp-done.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
