const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
async function rpc(method, payload = {}) {
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'd', method, payload }) });
  return (await r.json()).result;
}
(async () => {
  await rpc('set-config', { pollEnabled: false });
  const c1 = await rpc('add-task', { title: '测试派发任务', note: '验收标准：详情浮层要清晰分组、字段对齐、结论与备注有独立底色块，时间线一眼能读。', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答', sessionId: 'session-e7a5bfc7-28c1-444c-bfb0-e73cb3b03515' });
  const id = c1.value.task.id;
  await rpc('update-task', { id, status: 'doing' });
  await rpc('update-task', { id, status: 'done', result: '审核通过（主 Agent 独立复核）：产物 t17-smoke/result.md 存在，42 字节、2 行，hex=742d3137206f6b0a...，sha256=BBCE3148…53898C；顶层其它文件未改动；子 Agent d38ff7f8 在工作区执行，主 Agent 复核通过。', assignee: 'subagent:d38ff7f8' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const events = [];
  page.on('pageerror', e => events.push(String(e.message || e).slice(0, 200)));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('.tb-card', { hasText: '测试派发任务' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => {
    const dlg = document.querySelector('.tb-detail');
    const r = dlg.getBoundingClientRect();
    return {
      dialog: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      sections: document.querySelectorAll('.tb-detail-section').length,
      rows: document.querySelectorAll('.tb-detail-row').length,
      badges: Array.from(document.querySelectorAll('.tb-detail-badges > *')).map(n => n.className + ':' + n.textContent),
      resultBlocks: document.querySelectorAll('.tb-detail-result').length,
      pageErrors: [],
    };
  });
  console.log('INFO ' + JSON.stringify(info, null, 1));
  console.log('PAGEERRORS ' + JSON.stringify(events));
  await page.screenshot({ path: OUT + '/shots/detail-style-01.png' });
  // 窄屏（右栏宽度）也看一眼
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/shots/detail-style-02-narrow.png' });
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
