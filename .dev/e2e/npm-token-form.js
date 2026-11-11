const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  console.log('url:', page.url());
  const info = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input,select,textarea')).map(i => ({
      tag: i.tagName, type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, value: i.value,
      aria: i.getAttribute('aria-label'), label: (i.labels && i.labels[0] && i.labels[0].innerText || '').trim().slice(0,40)
    }));
    const radios = Array.from(document.querySelectorAll('input[type=radio], input[type=checkbox]')).map(i => ({ name: i.name, id: i.id, value: i.value, checked: i.checked, label: (i.labels && i.labels[0] && i.labels[0].innerText || '').trim().slice(0,60) }));
    return { inputs, radios, text: document.body.innerText.slice(0, 1500) };
  });
  console.log(JSON.stringify(info.inputs, null, 1));
  console.log('RADIOS ' + JSON.stringify(info.radios, null, 1));
  console.log('TEXT\n' + info.text);
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-granular-form.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
