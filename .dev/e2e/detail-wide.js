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
  const add = await rpc('add-task', { title: '宽度验收', note: '弹窗加宽到 900。', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答', sessionId: 'session-aaaa1111-2222-3333-4444-555566667777' });
  const id = add.value.task.id;
  await rpc('update-task', { id, status: 'done', result: '## 结论\n**通过**（独立验证）。\n\n| 轮次 | 子 Agent | 内容 |\n| --- | --- | --- |\n| 1 | 71b1206e | 只读取证目录 / 按 AGENTS.md 记忆约定改 MEMORY.md |\n| 2 | 3e9421b9 | 把新条目与原 L157 的同主题记录合并为一条 |', assignee: 'subagent:71b1206e / 3e9421b9' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('.tb-card', { hasText: '宽度验收' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => {
    const dlg = document.querySelector('.tb-detail');
    const grid = document.querySelector('.tb-detail-grid');
    return { dialogWidth: Math.round(dlg.getBoundingClientRect().width), dialogHeight: Math.round(dlg.getBoundingClientRect().height), gridCols: grid ? getComputedStyle(grid).gridTemplateColumns : null };
  });
  console.log('INFO ' + JSON.stringify(info));
  await page.screenshot({ path: OUT + '/shots/detail-wide.png' });
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });