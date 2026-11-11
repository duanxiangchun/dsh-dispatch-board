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
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  const a = await rpc('add-task', { title: '整理登录页视觉稿', note: '按新的设计规范调整间距与字号', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  await rpc('add-task', { title: '修复导出 CSV 乱码', note: 'Windows 下用 UTF-8 BOM', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  await rpc('add-task', { title: '补充任务看板文档', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  const b = await rpc('add-task', { title: '测试派发任务', note: '验收标准：结论要按 Markdown 渲染。', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答', sessionId: 'session-aaaa1111-2222-3333-4444-555566667777' });
  await rpc('update-task', { id: b.value.task.id, status: 'doing' });
  const c = await rpc('add-task', { title: '归档样例任务', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  await rpc('update-task', { id: c.value.task.id, status: 'doing' });
  await rpc('update-task', { id: c.value.task.id, status: 'done', result: '## 结论\n**通过**。', assignee: 'subagent:26e6ae29' });
  await rpc('update-task', { id: c.value.task.id, status: 'archived' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 200)));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '/shots/apple-board.png' });
  await page.locator('.tb-card', { hasText: '测试派发任务' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + '/shots/apple-detail.png' });
  console.log('ERRORS ' + JSON.stringify(errors));
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });