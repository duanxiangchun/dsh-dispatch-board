const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  // 选 90 days
  const opt = page.getByRole('option', { name: '90 days' }).first();
  await opt.click({ timeout: 8000 }).catch(async (e) => {
    console.log('option click failed:', e.message);
    const t = page.getByText('90 days', { exact: true }).first();
    await t.click({ timeout: 8000 }).catch(e2 => console.log('fallback click failed:', e2.message));
  });
  await page.waitForTimeout(800);
  const summary = await page.evaluate(() => {
    const t = document.body.innerText;
    const i = t.indexOf('Expires on');
    return t.slice(i, i + 80).replace(/\n+/g, ' | ');
  });
  console.log('EXPIRY ' + summary);
  // 生成
  await page.getByRole('button', { name: 'Generate token' }).click({ timeout: 10000 });
  await page.waitForTimeout(2500);
  const token = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    for (const i of inputs) if (i.value && i.value.startsWith('npm_')) return i.value;
    const codes = Array.from(document.querySelectorAll('code, pre, [data-testid], span, div'));
    for (const c of codes) { const t = (c.innerText || '').trim(); if (/^npm_[A-Za-z0-9]{10,}/.test(t) && t.length < 200) return t; }
    const body = document.body.innerText;
    const m = body.match(/npm_[A-Za-z0-9]{20,}/);
    return m ? m[0] : null;
  });
  console.log('TOKEN_PREFIX ' + (token ? token.slice(0, 10) : 'NONE') + ' len=' + (token ? token.length : 0));
  if (token) fs.writeFileSync('C:\\Users\\duan\\.npm-ci-token.tmp', token, { encoding: 'utf8' });
  const info = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.slice(0, 700),
  }));
  console.log('URL ' + info.url);
  console.log('PAGE ' + info.text.replace(/\n+/g, ' | ').slice(0, 600));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-token-created.png', fullPage: true });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
