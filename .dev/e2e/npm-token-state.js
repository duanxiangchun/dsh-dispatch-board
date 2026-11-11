const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  console.log('URL', page.url());
  const state = await page.evaluate(() => {
    const all = document.querySelector('#packagesAll');
    const name = document.querySelector('input[name="tokenName"]');
    const bodyText = document.body.innerText;
    const expIdx = bodyText.indexOf('Expiration');
    const around = bodyText.slice(expIdx, expIdx + 300).replace(/\n+/g, ' | ');
    const sumIdx = bodyText.indexOf('This token will');
    const summary = bodyText.slice(sumIdx, sumIdx + 260).replace(/\n+/g, ' | ');
    // 找 expiration 控件：按钮里带 days 文本
    const buttons = Array.from(document.querySelectorAll('button')).map(b => (b.innerText || '').trim()).filter(Boolean);
    return { packagesAllChecked: all ? all.checked : null, tokenName: name ? name.value : null, around, summary, buttons };
  });
  console.log('STATE ' + JSON.stringify(state, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
