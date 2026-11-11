const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  const sessions = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="sessionRow"]')).map(r => ({ title: (r.querySelector('[class*="title"]') || {}).innerText || (r.innerText || '').split('\n')[0], text: (r.innerText || '').replace(/\n/g, ' | ').slice(0, 100) })));
  const expand = await page.getByRole('button', { name: /展开其余/ }).count();
  console.log('SESSIONS:', JSON.stringify(sessions, null, 1));
  console.log('EXPAND BTN:', expand);
  const btns = await page.getByRole('button', { name: /展开其余/ }).allInnerTexts();
  console.log('EXPAND TEXTS:', JSON.stringify(btns));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
