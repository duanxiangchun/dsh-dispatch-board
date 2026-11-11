const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const TOKENS = [
  'bg-base','bg-layer-1','bg-layer-2','bg-layer-3','bg-skeleton','bg-overlay','bg-mask-1','bg-mask-2',
  'border-l1','border-l2','border-l3','border-l4',
  'label-primary','label-secondary','label-tertiary','label-caption','label-dimmed',
  'button-primary-fill','button-primary-hover','button-elevated-fill','button-contrast-fill','button-tool-bar-fill','button-ghost-active-fill',
  'interactive-bg-hover','state-business-primary','state-success-primary','state-warn-primary','state-error-primary',
  'markdown-inline-code','markdown-code-block','scrollbar-bg-l1','settings-card-fill','settings-card-stroke','link'
];
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  const values = await page.evaluate((tokens) => {
    const cs = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const out = {};
    for (const t of tokens) {
      const name = '--dsw-alias-' + t;
      const v = (cs.getPropertyValue(name) || body.getPropertyValue(name) || '').trim();
      out[t] = v;
    }
    const radius = ['--dsw-radius-xs','--dsw-radius-sm','--dsw-radius-md','--dsw-radius-lg','--dsw-radius-xl'];
    const r = {};
    for (const k of radius) r[k] = (cs.getPropertyValue(k) || '').trim();
    return { out, r, bodyBg: body.backgroundColor };
  }, TOKENS);
  console.log('TOKENS ' + JSON.stringify(values, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });