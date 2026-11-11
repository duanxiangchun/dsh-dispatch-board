const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const brief = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map(i => [i.type, i.name, i.id, i.value].join(' | ')));
  console.log('ALL INPUTS\n' + brief.join('\n'));
  // 填名字 + 选 Read and write
  const nameInput = page.locator('input[name="tokenName"]');
  console.log('name inputs:', await nameInput.count());
  if (await nameInput.count()) await nameInput.first().fill('github-actions-dsh-dispatch-board');
  const rw = page.locator('#create-gat_packagesAndScopesPermission_Read-and-write');
  await rw.check({ force: true });
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({
    text: document.body.innerText.slice(0, 1600),
    inputs: Array.from(document.querySelectorAll('input')).map(i => [i.type, i.name, i.value].join('|')),
  }));
  console.log('AFTER\n' + after.text);
  console.log('INPUTS2 ' + JSON.stringify(after.inputs));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-granular-filled.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
