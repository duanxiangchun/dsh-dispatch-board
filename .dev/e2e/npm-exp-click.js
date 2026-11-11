const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const target = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('*'));
    const hit = nodes.filter(n => (n.innerText || '').trim() === '7 days' && n.children.length === 0);
    const first = hit[0];
    return first ? { tag: first.tagName, cls: first.className, html: first.parentElement.outerHTML.slice(0, 600) } : null;
  });
  console.log('CTRL ' + JSON.stringify(target, null, 1));
  // 尝试点击包含 '7 days' 的可点击祖先
  const clickable = page.getByText('7 days', { exact: true }).first();
  await clickable.click({ timeout: 8000 }).catch(e => console.log('click err', e.message));
  await page.waitForTimeout(1200);
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('[role=option], li, button')).map(n => (n.innerText || '').trim()).filter(t => /day|month|year/i.test(t)).slice(0, 20));
  console.log('OPTS ' + JSON.stringify(opts));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/npm-exp-dropdown.png' });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
