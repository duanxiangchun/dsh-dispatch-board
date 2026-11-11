const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/package/dsh-dispatch-board/access', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
  if (await page.getByText('GitHub Actions', { exact: true }).count()) {
    await page.getByText('GitHub Actions', { exact: true }).first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.locator('#oidc-label').fill('dsh-dispatch-board CI');
  await page.locator('#oidc-repositoryOwner').fill('duanxiangchun');
  await page.locator('#oidc-repositoryName').fill('dsh-dispatch-board');
  await page.locator('#oidc-workflowName').fill('publish.yml');
  await page.locator('#oidc-allow-publish').check({ force: true }).catch(e => console.log('allow publish err', e.message));
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => ({
    owner: document.querySelector('#oidc-repositoryOwner')?.value,
    repo: document.querySelector('#oidc-repositoryName')?.value,
    wf: document.querySelector('#oidc-workflowName')?.value,
    allow: document.querySelector('#oidc-allow-publish')?.checked,
  }));
  console.log('FILLED ' + JSON.stringify(before));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-tp-ready.png', fullPage: true });
  await page.getByRole('button', { name: /Set up connection/i }).first().click({ timeout: 10000 }).catch(e => console.log('submit err', e.message));
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.slice(0, 1400),
  }));
  fs.writeFileSync(process.env.OUT_DIR + '/tmp-tp-after.json', JSON.stringify(after, null, 1), 'utf8');
  console.log('AFTER_URL ' + after.url);
  console.log('HAS_CONNECTION ' + /duanxiangchun\/dsh-dispatch-board|Delete trusted publisher|trusted publisher/i.test(after.text));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-tp-result.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
