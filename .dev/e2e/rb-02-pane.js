const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(7000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  const row = page.getByText('派单模式自检', { exact: true }).first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(2500); }
  await page.locator('.tb-headbtn').first().click();
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const tb = document.querySelector('.tb-page');
    if (!tb) return { error: 'no tb-page' };
    const chain = [];
    let el = tb;
    for (let i = 0; i < 8 && el; i++) {
      const r = el.getBoundingClientRect();
      chain.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 120), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top), attrs: Array.from(el.attributes).filter(a => a.name.startsWith('data-') || a.name === 'role' || a.name === 'aria-label').map(a => a.name + '=' + a.value).slice(0, 6) });
      el = el.parentElement;
    }
    const pane = tb.closest('[class*="right"],[class*="Right"],[class*="side"],[class*="Side"]') || tb.parentElement;
    const paneButtons = Array.from(pane.querySelectorAll('button')).map(b => ({ aria: b.getAttribute('aria-label') || '', title: b.getAttribute('title') || '', cls: (b.className || '').toString().slice(0, 80), text: (b.innerText || '').trim().slice(0, 24) })).filter(b => b.aria || b.title || b.text);
    const handles = Array.from(document.querySelectorAll('[role=separator],[class*="resize"],[class*="Resize"],[class*="divider"],[class*="Divider"],[class*="drag"],[class*="Drag"]')).map(e => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 100), role: e.getAttribute('role'), cursor: getComputedStyle(e).cursor }));
    return { chain, paneButtons, handles };
  });
  console.log('INFO:', JSON.stringify(info, null, 1).slice(0, 9000));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
