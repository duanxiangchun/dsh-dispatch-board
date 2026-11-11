const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2400);
  const info = await page.evaluate(() => {
    const p = document.querySelector('.tb-page');
    const r = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    return {
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      leftGap: Math.round(r.x), topGap: Math.round(r.y),
      rightGap: Math.round(window.innerWidth - r.right),
      bottomGap: Math.round(window.innerHeight - r.bottom),
      margin: cs.margin, width: cs.width, height: cs.height, radius: cs.borderRadius,
      innerScroll: p.scrollHeight > p.clientHeight,
    };
  });
  console.log('INFO ' + JSON.stringify(info));
  await page.screenshot({ path: OUT + '/shots/canvas-margin.png' });
  // 窄屏
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.waitForTimeout(800);
  const info2 = await page.evaluate(() => {
    const p = document.querySelector('.tb-page');
    const r = p.getBoundingClientRect();
    return { leftGap: Math.round(r.x), topGap: Math.round(r.y), w: Math.round(r.width), innerScroll: p.scrollHeight > p.clientHeight };
  });
  console.log('NARROW ' + JSON.stringify(info2));
  await page.screenshot({ path: OUT + '/shots/canvas-margin-narrow.png' });
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
