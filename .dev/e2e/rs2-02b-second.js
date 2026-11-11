const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const BOARD = 'C:\\Users\\duan\\.dsh\\storages\\dsh-taskboard\\board.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'ws2-' + Math.random().toString(36).slice(2);
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }) });
  const j = await r.json();
  return j.result;
}
async function snap() { const res = await rpc('snapshot'); return res.value; }
function readBoard() { return JSON.parse(fs.readFileSync(BOARD, 'utf8')); }
function taskByTitle(b, title) { const t = b.tasks.find(x => x.title === title); return t ? { id: t.id, status: t.status, sessionId: t.sessionId, cwd: t.cwd, result: t.result } : null; }
(async () => {
  const consoleEvents = [];
  const data = { timeline: [] };
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 400) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 400) }));
  page.on('dialog', d => d.accept().catch(() => {}));

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }

  // --- create a fresh session in 日常问答 workspace (materialized by one short turn)
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await page.waitForTimeout(2000);
  const editor = page.locator('[contenteditable="true"][aria-label^="描述你想要构建的内容"]').first();
  await editor.click();
  await page.keyboard.type('WS 绑定自检：只回复「ok」，不要使用工具。', { delay: 5 });
  await page.getByRole('button', { name: '发送消息', exact: true }).first().click();
  console.log('new session message sent at', new Date().toISOString());
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const stop = await page.getByRole('button', { name: /停止|stop/i }).count();
    const txt = await page.evaluate(() => document.body.innerText);
    if (stop === 0 && /\bok\b|ok/i.test(txt)) { data.turnDone = true; break; }
  }
  console.log('new session turn done:', data.turnDone);
  data.agentsAfterNewSession = (await snap()).agents;
  console.log('AGENTS AFTER NEW SESSION:', JSON.stringify(data.agentsAfterNewSession));

  // --- open board from this session header
  await page.locator('.tb-headbtn').first().click();
  await page.waitForTimeout(3000);
  data.composerB = await page.evaluate(() => { const c = document.querySelector('.tb-composer'); return c ? c.innerText.replace(/\n+/g, ' | ') : null; });
  console.log('COMPOSER B:', JSON.stringify(data.composerB));

  // --- add task 3
  const title = 'WS 验证 3：在 .dev/e2e/ws-demo3.txt 写入一行 demo3';
  await page.locator('input.tb-input').fill(title);
  const nb = page.locator('button.tb-linkbtn');
  if (await nb.count()) { await nb.click(); await page.waitForTimeout(400); await page.locator('textarea.tb-textarea').fill('验收标准：C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\ws-demo3.txt 恰好一行 demo3（demo3+LF）；完成后把任务置为 done 并在 result 写可核验结论。'); }
  await page.getByRole('button', { name: '添加到待开始', exact: true }).click();
  await sleep(1000);
  data.task3Initial = taskByTitle(readBoard(), title);
  console.log('TASK3 INITIAL:', JSON.stringify(data.task3Initial));
  await page.screenshot({ path: OUT + '/shots/rs2-05b-second.png' });

  // --- wait for dispatch back to this session + done
  let bound = false, done = false, doingShot = false;
  const t0 = Date.now();
  for (let i = 0; i < 48; i++) {
    await sleep(5000);
    const s = await snap();
    const b = readBoard();
    const t = taskByTitle(b, title);
    const rec = { t: Math.round((Date.now() - t0) / 1000), status: t ? t.status : 'missing', pollSid: s.poll.lastDispatchSessionId, agents: s.agents.map(a => a.sessionId + ':' + a.status) };
    data.timeline.push(rec);
    console.log('t+' + rec.t + 's status=' + rec.status + ' pollSid=' + rec.pollSid);
    if (t && t.sessionId && s.poll.lastDispatchSessionId === t.sessionId) bound = true;
    if (t && t.status === 'doing' && !doingShot) { doingShot = true; await page.screenshot({ path: OUT + '/shots/rs2-06b-second-doing.png' }); }
    if (t && t.status === 'done') { done = true; break; }
  }
  data.bound = bound;
  data.done = done;
  data.pollFinal = (await snap()).poll;
  data.task3Final = taskByTitle(readBoard(), title);
  data.twoDistinct = !!(data.task3Initial && data.task3Initial.sessionId);
  const ws3 = 'C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\ws-demo3.txt';
  data.wsDemo3 = fs.existsSync(ws3) ? { exists: true, content: fs.readFileSync(ws3, 'utf8'), bytes: fs.statSync(ws3).size } : { exists: false };
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + '/shots/rs2-07b-second-done.png' });
  console.log('TASK3 FINAL:', JSON.stringify(data.task3Final), 'bound=', bound, 'done=', done, 'wsDemo3=', JSON.stringify(data.wsDemo3));

  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/rs2b-data.json', JSON.stringify(data, null, 1));
  fs.writeFileSync(OUT + '/shots/rs2b-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-120) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)));
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
