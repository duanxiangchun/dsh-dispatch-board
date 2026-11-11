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
  await rpc('add-task', { title: 'STYLE 探针', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  await page.waitForTimeout(2000);
  await page.locator('.tb-card', { hasText: 'STYLE 探针' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(600);
  const info = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const names = ['--dsw-alias-bg-primary','--dsw-alias-bg-secondary','--dsw-alias-bg-elevated','--dsw-color-bg','--dsw-alias-bg-l1','--dsw-alias-bg-l2','--dsw-alias-border-l1','--dsw-alias-label-primary','--dsw-radius-lg','--dsw-font-xs-12'];
    const vars = {}; for (const n of names) vars[n] = root.getPropertyValue(n).trim().slice(0, 40);
    const dlg = document.querySelector('.tb-detail');
    const cs = dlg ? getComputedStyle(dlg) : null;
    return { vars, dialogBg: cs ? cs.backgroundColor : null, dialogBorder: cs ? cs.borderColor : null, dialogColor: cs ? cs.color : null, cardBg: getComputedStyle(document.querySelector('.tb-card')).backgroundColor };
  });
  console.log('INFO ' + JSON.stringify(info, null, 1));
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
