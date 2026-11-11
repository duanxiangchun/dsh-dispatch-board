const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const info = await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[type=radio]')).map(i => ({ id: i.id, name: i.name, value: i.value, checked: i.checked, label: (i.labels && i.labels[0] && i.labels[0].innerText || '').trim().slice(0,80) }));
    const selects = Array.from(document.querySelectorAll('select')).map(s => ({ name: s.name, id: s.id, value: s.value, options: Array.from(s.options).map(o => o.value + ':' + o.text) }));
    const buttons = Array.from(document.querySelectorAll('button')).map(b => ({ text: (b.innerText||'').trim().slice(0,40), type: b.type }));
    return { radios, selects, buttons };
  });
  console.log('RADIOS ' + JSON.stringify(info.radios, null, 1));
  console.log('SELECTS ' + JSON.stringify(info.selects));
  console.log('BUTTONS ' + JSON.stringify(info.buttons));
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
