const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
async function rpc(method, payload = {}) {
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'd', method, payload }) });
  return (await r.json()).result;
}
const DENSE = '审核通过（主 Agent 独立复核，非仅采信子 Agent 自检）：工作目录 = C:/Users/duan/Code/demo/demo/日常问答（与任务工作区一致）；产物 t17-smoke/result.md 存在，42 字节、2 行，hex=742d...，sha256=BBCE3148；顶层其它文件未改动（MEMORY.md 仍是 15:22）；子 Agent d38ff7f8 在工作区执行，主 Agent 复核通过。';
const MD = ['## 审核结论：通过', '', '| 核验项 | 结果 |', '| --- | --- |', '| 工作目录 | C:/Users/duan/Code/demo/demo/日常问答 |', '| 产物 | `t17-smoke/result.md`（42 字节、2 行） |', '| 内容 | `t-17 ok` + ISO 时间 |', '| 副作用 | 其它文件未改动 |', '', '### 结论', '- **通过**：与验收标准一致', '- 执行者：subagent:d38ff7f8'].join('\n');
(async () => {
  await rpc('set-config', { pollEnabled: false });
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  const a = await rpc('add-task', { title: 'A 密集纯文本结论', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  await rpc('update-task', { id: a.value.task.id, status: 'doing' });
  await rpc('update-task', { id: a.value.task.id, status: 'done', result: DENSE });
  const b = await rpc('add-task', { title: 'B Markdown 表格结论', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  await rpc('update-task', { id: b.value.task.id, status: 'doing' });
  await rpc('update-task', { id: b.value.task.id, status: 'done', result: MD });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 200)));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  const report = {};
  await page.locator('.tb-card', { hasText: 'A 密集纯文本结论' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(600);
  report.dense = await page.evaluate(() => { const r = document.querySelector('.tb-detail-result'); return { lists: r.querySelectorAll('ul').length, items: r.querySelectorAll('li').length, textLen: r.innerText.length }; });
  await page.screenshot({ path: OUT + '/shots/rich-dense.png' });
  await page.locator('.tb-detail-close').click();
  await page.waitForTimeout(400);
  await page.locator('.tb-card', { hasText: 'B Markdown 表格结论' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(600);
  report.md = await page.evaluate(() => { const r = document.querySelector('.tb-detail-result'); return { tables: r.querySelectorAll('table').length, headers: r.querySelectorAll('th').length, rows: r.querySelectorAll('tbody tr').length, headings: r.querySelectorAll('.tb-rich-h').length, lists: r.querySelectorAll('ul').length, codes: r.querySelectorAll('code').length }; });
  await page.screenshot({ path: OUT + '/shots/rich-table.png' });
  report.errors = errors;
  console.log('REPORT ' + JSON.stringify(report, null, 1));
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });