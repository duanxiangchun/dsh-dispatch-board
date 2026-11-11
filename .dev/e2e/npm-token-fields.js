const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const fields = await page.evaluate(() => {
    const q = (sel) => Array.from(document.querySelectorAll(sel)).map(i => ({
      tag: i.tagName, type: i.type, name: i.name, id: i.id, placeholder: i.placeholder || '', value: i.value || '',
      aria: i.getAttribute('aria-label') || '', cls: (i.className||'').toString().slice(0,50)
    }));
    return { inputs: q('input'), selects: q('select'), textareas: q('textarea') };
  });
  console.log('INPUTS ' + JSON.stringify(fields.inputs, null, 1));
  console.log('SELECTS ' + JSON.stringify(fields.selects, null, 1));
  console.log('TEXTAREAS ' + JSON.stringify(fields.textareas, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
