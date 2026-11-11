const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/settings/duanxc/tokens', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const rows = await page.evaluate(() => {
    const table = document.querySelector('table');
    if (!table) return { text: document.body.innerText.slice(0, 800) };
    return {
      headers: Array.from(table.querySelectorAll('th')).map(th => th.innerText.trim()),
      rows: Array.from(table.querySelectorAll('tbody tr')).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim().replace(/\s+/g, ' '))),
    };
  });
  fs.writeFileSync(process.env.OUT_DIR + '/tmp-tokens.json', JSON.stringify(rows, null, 1), 'utf8');
  console.log('WROTE');
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
