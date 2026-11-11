const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
async function rpc(method, payload = {}) {
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'd', method, payload }) });
  return (await r.json()).result;
}
const RESULT = [
  '## 审核结论：通过',
  '',
  '主 Agent 独立复核了子 Agent 的产物，**没有只采信自检**。',
  '',
  '### 核验项',
  '- 文件路径：.dev/e2e/ws-demo3.txt',
  '- 字节数：6（`demo3` + LF）',
  '- hex：`64 65 6D 6F 33 0A`',
  '- git status：无其它改动',
  '',
  '### 命令复核',
  '```powershell',
  '$bytes = [IO.File]::ReadAllBytes($p)',
  '$bytes.Length   # 6',
  '```',
  '',
  '> 结论：交付物与验收标准一致，准予通过。',
  '',
  '---',
  '执行者：subagent:cabe6945',
].join('\n');
(async () => {
  await rpc('set-config', { pollEnabled: false });
  const c1 = await rpc('add-task', { title: '测试派发任务', note: '验收标准：结论要按 markdown 结构渲染（标题/列表/代码块），不要一坨文字。', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  const id = c1.value.task.id;
  await rpc('update-task', { id, status: 'doing' });
  await rpc('update-task', { id, status: 'done', result: RESULT, assignee: 'subagent:cabe6945' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 200)));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('.tb-card', { hasText: '测试派发任务' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => {
    const rich = document.querySelector('.tb-detail-result');
    return { headings: rich.querySelectorAll('.tb-rich-h').length, lists: rich.querySelectorAll('ul,ol').length, listItems: rich.querySelectorAll('li').length, codes: rich.querySelectorAll('code').length, pre: rich.querySelectorAll('pre').length, quotes: rich.querySelectorAll('blockquote').length, hrs: rich.querySelectorAll('hr').length, strong: rich.querySelectorAll('strong').length, paragraphs: rich.querySelectorAll('p').length };
  });
  console.log('INFO ' + JSON.stringify(info));
  console.log('ERRORS ' + JSON.stringify(errors));
  await page.screenshot({ path: OUT + '/shots/detail-rich-01.png' });
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
