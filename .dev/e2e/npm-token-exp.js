const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  await page.locator('#packagesAll').check({ force: true });
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div,label,button,span'));
    const exp = els.find(n => (n.innerText || '').trim().startsWith('Expiration Date'));
    let html = '';
    let n = null;
    for (const cand of els) {
      const t = (cand.innerText || '').trim();
      if (t.startsWith('Expiration Date') && t.length < 200) { n = cand; break; }
    }
    if (n) html = n.outerHTML.slice(0, 1500);
    const summary = (Array.from(els).find(x => (x.innerText||'').includes('This token will')) || {}).innerText || '';
    return { html, summary: summary.slice(0, 400) };
  });
  console.log('EXP HTML ' + info.html);
  console.log('SUMMARY ' + info.summary);
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-token-ready.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
