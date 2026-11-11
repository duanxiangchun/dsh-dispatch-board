const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/package/dsh-dispatch-board/access', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const before = await page.evaluate(() => ({
    hasForm: !!document.querySelector('#oidc-repositoryOwner'),
    existingTp: /Delete trusted publisher/i.test(document.body.innerText),
  }));
  console.log('BEFORE ' + JSON.stringify(before));
  if (!before.existingTp) {
    if (await page.getByText('GitHub Actions', { exact: true }).count()) {
      await page.getByText('GitHub Actions', { exact: true }).first().click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
    }
    await page.locator('#oidc-label').fill('dsh-dispatch-board CI');
    await page.locator('#oidc-repositoryOwner').fill('duanxiangchun');
    await page.locator('#oidc-repositoryName').fill('dsh-dispatch-board');
    await page.locator('#oidc-workflowName').fill('publish.yml');
    await page.locator('#oidc-allow-publish').check({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('#oidc button')).find(b => /set up connection/i.test(b.innerText));
      if (btn) btn.click();
    });
    await page.waitForTimeout(3500);
  }
  const after = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.slice(0, 900),
    hasPasswordModal: !!document.querySelector('input[type=password]'),
    hasDeleteTp: /Delete trusted publisher/i.test(document.body.innerText),
  }));
  fs.writeFileSync(process.env.OUT_DIR + '/tmp-tp-state.json', JSON.stringify(after, null, 1), 'utf8');
  console.log('AFTER ' + JSON.stringify({ url: after.url, hasPasswordModal: after.hasPasswordModal, hasDeleteTp: after.hasDeleteTp }));
  console.log('TEXT ' + after.text.replace(/\n+/g, ' | ').slice(0, 500));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-tp-state.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
