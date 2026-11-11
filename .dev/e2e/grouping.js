const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const SID = 'session-2271b4fa-1cf6-4fa1-aa44-ac3dedc9c42a';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const info = await page.evaluate((sid) => {
    const byAttr = document.querySelector('[data-session-id="' + sid + '"]');
    const all = Array.from(document.querySelectorAll('[data-session-id]')).map(e => e.getAttribute('data-session-id'));
    let groupText = null;
    if (byAttr) {
      let node = byAttr;
      for (let i = 0; i < 8 && node; i++) {
        node = node.parentElement;
        if (!node) break;
        const text = (node.innerText || '').trim();
        if (text.includes('日常问答') && text.length < 400) { groupText = text.split('\n').slice(0, 3).join(' | '); break; }
      }
    }
    return { found: Boolean(byAttr), sessionIdsInSidebar: all.slice(0, 20), groupText, rowText: byAttr ? (byAttr.innerText || '').trim().slice(0, 40) : null };
  }, SID);
  console.log('INFO ' + JSON.stringify(info));
  await page.screenshot({ path: OUT + '/shots/grouping-01.png' });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });