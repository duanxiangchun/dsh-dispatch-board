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
  const c = await rpc('add-task', { title: '测试派发任务', note: '验收标准：详情里完成结论排在最上面，其次是备注，然后才是我基本信息与时间线。', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  const id = c.value.task.id;
  await rpc('update-task', { id, status: 'doing' });
  await rpc('update-task', { id, status: 'done', result: '## 结论\n**通过**（独立验证，非仅看汇报）。\n\n### 产物\n- `t19-dispatch-test/run.ps1`（741 字节）\n- `t19-dispatch-test/result.md`（2 行）\n\n### 核验\n| 项 | 值 |\n| --- | --- |\n| 目录 | t19-dispatch-test |\n| 执行者 | subagent:26e6ae29 |', assignee: 'subagent:26e6ae29' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('.tb-card', { hasText: '测试派发任务' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => {
    const body = document.querySelector('.tb-detail-body');
    const order = Array.from(document.querySelectorAll('.tb-detail-sub')).map(n => n.textContent);
    return { order, bodyScrollHeight: body ? body.scrollHeight : null };
  });
  console.log('INFO ' + JSON.stringify(info));
  await page.screenshot({ path: OUT + '/shots/detail-result-top.png' });
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });