const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/settings/duanxc/tokens/granular-access-tokens/new', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await page.locator('input[name="tokenName"]').first().fill('gh-actions-bypass-2');
  await page.locator('#create-gat_packagesAndScopesPermission_Read-and-write').check({ force: true });
  await page.waitForTimeout(500);
  await page.locator('#packagesAll').check({ force: true });
  await page.waitForTimeout(400);
  const bypass = page.locator('input[name="bypass2FA"]');
  if (await bypass.count() && !(await bypass.first().isDisabled())) { await bypass.first().check({ force: true }); }
  await page.getByText('7 days', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  const opt = page.getByRole('option', { name: '90 days' }).first();
  if (await opt.count()) await opt.click().catch(() => {});
  await page.waitForTimeout(500);
  const summary = await page.evaluate(() => {
    const t = document.body.innerText;
    const i = t.indexOf('This token will');
    return t.slice(i, i + 220).replace(/\n+/g, ' | ');
  });
  console.log('SUMMARY ' + summary);
  await page.getByRole('button', { name: 'Generate token' }).click({ timeout: 10000 });
  await page.waitForTimeout(2500);
  const token = await page.evaluate(() => {
    const m = document.body.innerText.match(/npm_[A-Za-z0-9]{20,}/);
    return m ? m[0] : null;
  });
  if (token) {
    fs.writeFileSync('C:\\Users\\duan\\.npm-token-github.tmp', token, 'utf8');
    console.log('CREATED prefix=' + token.slice(0, 10) + ' len=' + token.length + ' saved');
  } else {
    console.log('CREATE FAILED (no token on page)');
  }
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-token3.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
