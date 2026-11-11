const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)); });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="panelRow"]')).map(b => ({ aria: b.getAttribute('aria-label'), text: (b.innerText || '').trim() })));
  console.log('LEFT MENU:', JSON.stringify(menu));
  // click platform board
  const plat = page.getByRole('button', { name: '平台任务看板', exact: true }).first();
  console.log('platform btn count:', await plat.count());
  if (await plat.count()) { await plat.click(); await page.waitForTimeout(3500); }
  await page.screenshot({ path: OUT + '/shots/dual-probe-platform.png' });
  const info = await page.evaluate(() => {
    const sels = Array.from(document.querySelectorAll('select')).map(s => ({ aria: s.getAttribute('aria-label'), cls: (s.className||'').toString().slice(0,60), value: s.value, options: Array.from(s.options).map(o => o.textContent) }));
    const btns = Array.from(document.querySelectorAll('button')).filter(b => (b.innerText || '').trim()).map(b => ({ text: (b.innerText || '').trim().slice(0, 30), disabled: b.disabled, cls: (b.className||'').toString().slice(0,60) }));
    return { body: document.body.innerText.slice(0, 1800), sels, btns: btns.slice(0, 30), inputs: Array.from(document.querySelectorAll('input')).map(i => ({ ph: i.getAttribute('placeholder'), aria: i.getAttribute('aria-label'), cls: (i.className||'').toString().slice(0,50) })) };
  });
  console.log('PLATFORM INFO:', JSON.stringify(info, null, 1).slice(0, 7000));
  // workspace selector in new-session composer
  await page.getByRole('button', { name: '新会话', exact: true }).first().click().catch(async () => { await page.getByRole('button', { name: '新建会话', exact: true }).first().click(); });
  await page.waitForTimeout(2500);
  const wsBtn = page.getByRole('button', { name: '选择工作区', exact: true }).first();
  console.log('workspace btn count:', await wsBtn.count());
  if (await wsBtn.count()) {
    await wsBtn.click(); await page.waitForTimeout(1200);
    const items = await page.evaluate(() => Array.from(document.querySelectorAll('[role=menuitem],[role=option],button')).filter(e => /plinto|日常问答|工时填报/.test((e.innerText || '').trim())).map(e => ({ tag: e.tagName, role: e.getAttribute('role'), text: (e.innerText || '').trim().slice(0, 60) })).slice(0, 20));
    console.log('WS MENU ITEMS:', JSON.stringify(items));
    await page.screenshot({ path: OUT + '/shots/dual-probe-wsmenu.png' });
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
