const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch(e){} }
  // open a fresh session
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: OUT + '/shots/step4a-new-session.png' });
  // composer info
  const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('textarea, input, [contenteditable="true"]')).map(e => ({ tag: e.tagName, ph: e.getAttribute('placeholder'), aria: e.getAttribute('aria-label'), cls: (e.className||'').toString().slice(0,80), editable: e.getAttribute('contenteditable') })));
  console.log('INPUTS:', JSON.stringify(inputs, null, 1));
  // mode selector
  const mode = page.locator('button[title="选择新任务使用的 Agent 预设"]');
  console.log('mode button count:', await mode.count(), 'text:', await mode.count() ? await mode.first().innerText() : 'n/a');
  await mode.first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + '/shots/step4b-mode-menu.png' });
  const menu = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role=menuitem],[role=option],li,button')).filter(e => e.innerText && /派单看板|标准模式/.test(e.innerText) && e.offsetParent !== null).map(e => ({ tag: e.tagName, role: e.getAttribute('role'), text: e.innerText.trim().slice(0,120), cls: (e.className||'').toString().slice(0,60) }));
    return items.slice(0, 30);
  });
  console.log('MENU ITEMS:', JSON.stringify(menu, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
