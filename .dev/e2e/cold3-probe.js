const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  const info = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[class*="sessionRow"]')).map(r => (r.innerText || '').split('\n')[0]);
    const expand = Array.from(document.querySelectorAll('button')).filter(b => /展开其余|收起/.test((b.innerText || ''))).map(b => ({ cls: (b.className || '').toString().slice(0, 60), text: (b.innerText || '').trim().slice(0, 40) }));
    return { rows, expand, body: document.body.innerText.slice(0, 1200) };
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 5000));
  // try expand
  const exp = page.getByRole('button', { name: /展开其余/ }).first();
  if (await exp.count()) { await exp.click(); await page.waitForTimeout(1500); console.log('expanded'); }
  const rows2 = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="sessionRow"]')).map(r => (r.innerText || '').split('\n')[0]));
  console.log('ROWS AFTER EXPAND:', JSON.stringify(rows2));
  await page.screenshot({ path: process.env.OUT_DIR + '/shots/cold3-sidebar.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
