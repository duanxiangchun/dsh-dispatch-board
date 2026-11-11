const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console.' + m.type() + ']', m.text().slice(0, 300)); });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  console.log('body head:', JSON.stringify((await page.evaluate(() => document.body.innerText.slice(0, 300)))));
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  const row = page.getByText('派单模式自检', { exact: true }).first();
  console.log('row count:', await row.count());
  if (await row.count()) { await row.click(); await page.waitForTimeout(5000); }
  console.log('headbtn count:', await page.locator('.tb-headbtn').count());
  const info = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).map(b => ({ aria: b.getAttribute('aria-label') || '', title: b.getAttribute('title') || '', cls: (b.className || '').toString().slice(0, 60) })).filter(b => b.aria || b.title);
    const headerArea = Array.from(document.querySelectorAll('[class*="header"],[class*="Header"]')).slice(0, 6).map(e => ({ cls: (e.className||'').toString().slice(0,80), text: (e.innerText||'').trim().slice(0,120) }));
    return { buttons: btns.slice(-30), headerArea, bodyTail: document.body.innerText.slice(0, 500) };
  });
  console.log('INFO:', JSON.stringify(info, null, 1).slice(0, 6000));
  await page.screenshot({ path: OUT + '/shots/rs-debug-01.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
