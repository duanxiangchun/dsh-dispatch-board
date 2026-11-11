const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch(e){} }
  const cands = await page.evaluate(() => Array.from(document.querySelectorAll('button,div,a,span')).filter(e => (e.innerText||'').trim().startsWith('派单模式自检') || (e.innerText||'').trim() === '派单模式自检').slice(0,10).map(e => ({ tag: e.tagName, cls: (e.className||'').toString().slice(0,100), text: (e.innerText||'').trim().slice(0,60) })));
  console.log('CANDS:', JSON.stringify(cands, null, 1));
  await page.getByText('派单模式自检', { exact: true }).first().click().catch(async () => {
    await page.getByText('派单模式自检', { exact: false }).first().click();
  });
  await page.waitForTimeout(4000);
  console.log('URL after click:', page.url());
  const body = await page.evaluate(() => document.body.innerText);
  console.log('=== BODY (first 1800) ===');
  console.log(body.slice(0, 1800));
  await page.screenshot({ path: OUT + '/shots/probe-session-open.png' });
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
