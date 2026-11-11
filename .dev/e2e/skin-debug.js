const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const BASE = 'http://127.0.0.1:3099';
async function rpc(method, payload = {}) {
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'd', method, payload }) });
  return (await r.json()).result;
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('.tb-card', { hasText: '测试派发任务' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const dlg = document.querySelector('.tb-detail');
    const body = document.querySelector('.tb-detail-body');
    const sec = document.querySelector('.tb-detail-section');
    const card = document.querySelector('.tb-card');
    const page_ = document.querySelector('.tb-page');
    const pick = (el) => el ? { bg: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderColor, radius: getComputedStyle(el).borderRadius, shadow: getComputedStyle(el).boxShadow.slice(0, 60) } : null;
    return {
      vars: {
        surface: root.getPropertyValue('--tb-surface').trim(),
        canvas: root.getPropertyValue('--tb-canvas').trim(),
        hairline: root.getPropertyValue('--tb-hairline').trim(),
        accent: root.getPropertyValue('--tb-accent').trim(),
      },
      dlg: pick(dlg), body: pick(body), sec: pick(sec), card: pick(card), pageBg: pick(page_),
      colorMixSupported: CSS.supports('color', 'color-mix(in srgb, red 50%, blue)'),
    };
  });
  console.log('INFO ' + JSON.stringify(info, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });