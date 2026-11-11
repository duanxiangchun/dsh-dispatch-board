const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.goto('https://www.npmjs.com/package/dsh-dispatch-board/access', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.getByText('GitHub Actions', { exact: true }).first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(1200);
  const data = await page.evaluate(() => {
    const out = [];
    for (const i of document.querySelectorAll('input, textarea')) {
      const label = i.labels && i.labels[0] ? (i.labels[0].innerText || '').trim().slice(0, 60) : '';
      out.push({ tag: i.tagName, type: i.type, name: i.name, id: i.id, placeholder: i.placeholder || '', label, value: i.value || '' });
    }
    return { url: location.href, inputs: out, buttons: Array.from(document.querySelectorAll('button')).map(b => ({ text: (b.innerText||'').trim().slice(0,40), type: b.type })) };
  });
  fs.writeFileSync(process.env.OUT_DIR + '/tmp-tp-inputs.json', JSON.stringify(data, null, 1), 'utf8');
  console.log('WROTE ' + data.inputs.length + ' inputs, ' + data.buttons.length + ' buttons');
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
