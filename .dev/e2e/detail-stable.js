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
  const c1 = await rpc('add-task', { title: 'STABLE 验证：详情不闪', note: '验证打开详情后，轮询刷新不会重建浮层（不闪、滚动位置不丢）。', cwd: 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答' });
  const id = c1.value.task.id;
  await rpc('update-task', { id, status: 'doing' });
  await rpc('update-task', { id, status: 'done', result: '第一行结论\n第二行结论\n第三行结论\n第四行结论\n第五行结论\n第六行结论\n第七行结论\n第八行结论\n第九行结论\n第十行结论\n第十一行\n第十二行\n第十三行\n第十四行\n第十五行' });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 200)));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  await page.getByText('任务看板', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('.tb-card', { hasText: 'STABLE 验证' }).first().locator('.tb-card-title').click();
  await page.waitForTimeout(600);
  const before = await page.evaluate(() => {
    const dlg = document.querySelector('.tb-detail');
    dlg.dataset.mark = 'stable';
    const result = document.querySelector('.tb-detail-result');
    if (result) result.scrollTop = 9999;
    return {
      mark: dlg.dataset.mark,
      scrollTop: result ? result.scrollTop : -1,
      nodeCount: document.querySelectorAll('.tb-detail').length,
    };
  });
  // 等两轮轮询（2s 一次）
  await page.waitForTimeout(5000);
  const after = await page.evaluate(() => {
    const dlg = document.querySelector('.tb-detail');
    const result = document.querySelector('.tb-detail-result');
    return {
      mark: dlg ? dlg.dataset.mark : null,
      scrollTop: result ? result.scrollTop : -1,
      nodeCount: document.querySelectorAll('.tb-detail').length,
    };
  });
  console.log('BEFORE ' + JSON.stringify(before));
  console.log('AFTER  ' + JSON.stringify(after));
  console.log('STABLE ' + String(before.mark === 'stable' && after.mark === 'stable' && before.scrollTop === after.scrollTop));
  console.log('ERRORS ' + JSON.stringify(errors));
  await page.screenshot({ path: OUT + '/shots/detail-stable-01.png' });
  for (const t of (await rpc('snapshot')).value.tasks) { await rpc('delete-task', { id: t.id }); }
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
