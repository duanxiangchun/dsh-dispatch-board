const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
async function agentRows() {
  const id = 'r-' + Math.random().toString(36).slice(2);
  const r = await fetch(BASE + '/taskboard/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method: 'snapshot', payload: {} }) });
  const j = await r.json();
  return j.result.value.agents;
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  console.log('AGENTS after home load:', JSON.stringify(await agentRows()));

  for (const name of ['派单模式自检', 'E2E 冒烟测试 hello 文件写入', 'dsh子代理派发模式插件开发']) {
    const row = page.getByText(name, { exact: true }).first();
    const n = await row.count();
    console.log('\n--- open:', name, 'count=', n);
    if (!n) continue;
    await row.click();
    await page.waitForTimeout(3000);
    const header = await page.evaluate(() => {
      const seat = document.querySelector('button[title="选择新任务使用的 Agent 预设"]');
      const h = document.querySelector('[class*="header"]');
      return { seat: seat && seat.innerText.trim(), bodyStart: document.body.innerText.slice(0, 400) };
    });
    console.log('UI mode seat:', header.seat);
    console.log('agents now:', JSON.stringify(await agentRows()));
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
