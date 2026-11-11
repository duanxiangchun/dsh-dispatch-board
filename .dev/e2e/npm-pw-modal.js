const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const info = await page.evaluate(() => {
    const pw = Array.from(document.querySelectorAll('input[type=password]')).map(i => ({ name: i.name, id: i.id, placeholder: i.placeholder }));
    const buttons = Array.from(document.querySelectorAll('button')).map(b => ({ text: (b.innerText||'').trim(), type: b.type, visible: !!b.offsetParent })).filter(b => b.visible && b.text);
    const text = document.body.innerText.slice(0, 700);
    return { url: location.href, pw, buttons, text };
  });
  console.log(JSON.stringify(info, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
