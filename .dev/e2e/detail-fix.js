const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
async function rpc(method, payload = {}) {
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'd', method, payload }) });
  return (await r.json()).result;
}
(async () => {
  const events = [];
  await rpc('set-config', { pollEnabled: false });
  const added = await rpc('add-task', { title: '测试派发任务', note: '验收标准：详情浮层应该覆盖整屏、居中显示，字段行不能挤在一起；结论完整可见。', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  const id = added.value.task.id;
  await rpc('update-task', { id, status: 'doing' });
  await rpc('update-task', { id, status: 'done', result: '审核通过：这是一段较长的结论，用来验证详情浮层里的结论区能完整展示并且可滚动，不会被卡片的一行截断。', assignee: 'subagent:demo' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') events.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => events.push('pageerror: ' + (e.message || String(e)).slice(0, 200)));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('.tb-card', { hasText: '测试派发任务' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(800);
  const box = await page.evaluate(() => {
    const mask = document.querySelector('.tb-detail-mask');
    const dlg = document.querySelector('.tb-detail');
    const rect = mask ? mask.getBoundingClientRect() : null;
    return {
      mask: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      position: mask ? getComputedStyle(mask).position : null,
      zIndex: mask ? getComputedStyle(mask).zIndex : null,
      dialogBg: dlg ? getComputedStyle(dlg).backgroundColor : null,
      dialog: dlg ? (() => { const r = dlg.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
      rows: Array.from(document.querySelectorAll('.tb-detail-row')).map(r => Math.round(r.getBoundingClientRect().height)),
    };
  });
  console.log('BOX ' + JSON.stringify(box, null, 1));
  await page.screenshot({ path: OUT + '/shots/detail-fix-02.png' });
  console.log('CONSOLE ' + JSON.stringify(events));
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
