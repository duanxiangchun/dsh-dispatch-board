const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/settings/duanxc/tokens/granular-access-tokens/new', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);

  await page.locator('input[name="tokenName"]').first().fill('gh-actions-dispatch-bypass');
  await page.locator('#create-gat_packagesAndScopesPermission_Read-and-write').check({ force: true });
  await page.waitForTimeout(600);
  await page.locator('#packagesAll').check({ force: true });
  await page.waitForTimeout(600);

  // bypass 2FA
  const bypass = page.locator('input[name="bypass2FA"]');
  if (await bypass.count()) {
    const disabled = await bypass.first().isDisabled();
    if (!disabled) { await bypass.first().check({ force: true }); console.log('bypass checked'); }
    else console.log('bypass disabled');
  }

  // 90 days
  await page.getByText('7 days', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(700);
  const opt = page.getByRole('option', { name: '90 days' }).first();
  if (await opt.count()) { await opt.click().catch(() => {}); console.log('expiry 90d'); }
  await page.waitForTimeout(600);

  const summary = await page.evaluate(() => {
    const t = document.body.innerText;
    const i = t.indexOf('This token will');
    return t.slice(i, i + 240).replace(/\n+/g, ' | ');
  });
  console.log('SUMMARY ' + summary);

  await page.getByRole('button', { name: 'Generate token' }).click({ timeout: 10000 });
  await page.waitForTimeout(2500);
  const token = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    for (const i of inputs) if (i.value && i.value.startsWith('npm_')) return i.value;
    const m = document.body.innerText.match(/npm_[A-Za-z0-9]{20,}/);
    return m ? m[0] : null;
  });
  console.log('TOKEN_PREFIX ' + (token ? token.slice(0, 10) : 'NONE') + ' len=' + (token ? token.length : 0));
  if (token) {
    fs.writeFileSync('C:\\Users\\duan\\.npm-ci-token.tmp', token, 'utf8');
    console.log('saved to .npm-ci-token.tmp');
  }
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-token-created2.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
