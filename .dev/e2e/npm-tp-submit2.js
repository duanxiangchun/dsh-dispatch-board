const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.waitForTimeout(300);
  let nav = false;
  page.once('framenavigated', () => { nav = true; });
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('#oidc button')).find(b => /set up connection/i.test(b.innerText));
    if (btn) btn.click(); else document.getElementById('oidc').requestSubmit();
  });
  await page.waitForTimeout(5000);
  const after = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 1600) }));
  fs.writeFileSync(process.env.OUT_DIR + '/tmp-tp-after2.json', JSON.stringify(after, null, 1), 'utf8');
  console.log('URL ' + after.url);
  console.log('SUCCESS ' + /success|connected|created/i.test(after.text));
  console.log('HAS_OWNER ' + after.text.includes('duanxiangchun'));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-tp-submitted.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
