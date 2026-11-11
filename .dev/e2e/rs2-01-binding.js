const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const BOARD = 'C:\\Users\\duan\\.dsh\\storages\\dsh-taskboard\\board.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'ws-' + Math.random().toString(36).slice(2);
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }) });
  const j = await r.json();
  return j.result;
}
async function snap() { const res = await rpc('snapshot'); return res.value; }
function readBoardTask(title) {
  const b = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
  const t = b.tasks.find(x => x.title === title);
  return { revision: b.revision, task: t ? { id: t.id, title: t.title, status: t.status, sessionId: t.sessionId, cwd: t.cwd, result: t.result } : null };
}
(async () => {
  const consoleEvents = [];
  const data = { timeline: [] };
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 400) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 400) }));
  page.on('dialog', d => d.accept().catch(() => {}));

  const openSession = async (names) => {
    for (const name of names) {
      const row = page.getByText(name, { exact: true }).first();
      if (await row.count()) { await row.click(); await page.waitForTimeout(3500); return name; }
    }
    return null;
  };
  const openBoardViaHeader = async () => {
    if (await page.locator('.tb-page').count()) return true;
    if (await page.locator('.tb-headbtn').count()) { await page.locator('.tb-headbtn').first().click(); await page.waitForTimeout(3000); }
    return (await page.locator('.tb-page').count()) > 0;
  };
  const closeBoardTab = async () => {
    const close = page.getByRole('button', { name: '关闭', exact: true });
    if (await close.count()) { await close.first().click(); await page.waitForTimeout(1800); }
  };
  const composerText = () => page.evaluate(() => { const c = document.querySelector('.tb-composer'); return c ? c.innerText.replace(/\n+/g, ' | ') : null; });
  const addTask = async (title, note) => {
    await page.locator('input.tb-input').fill(title);
    if (note) {
      const nb = page.locator('button.tb-linkbtn');
      if (await nb.count()) { await nb.click(); await page.waitForTimeout(400); await page.locator('textarea.tb-textarea').fill(note); }
    }
    await page.getByRole('button', { name: '添加到待开始', exact: true }).click();
  };

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }

  // ---- session A
  data.sessionA = await openSession(['看板任务自动派发执行', '刷新小时会话', 'dsh子代理派发模式插件开发']);
  await openBoardViaHeader();
  await page.waitForTimeout(1500);
  data.composerA = await composerText();
  console.log('SESSION A:', data.sessionA, 'COMPOSER:', JSON.stringify(data.composerA));
  await page.screenshot({ path: OUT + '/shots/rs2-01-hint.png' });

  // ---- task 1
  const title1 = 'WS 验证：在 .dev/e2e/ws-demo.txt 写入一行 demo';
  await addTask(title1, '验收标准：C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\ws-demo.txt 恰好一行 demo（demo+LF）；完成后把任务置为 done 并在 result 写可核验结论。');
  console.log('task1 added at', new Date().toISOString());
  await sleep(1000);
  data.task1 = readBoardTask(title1);
  console.log('TASK1 BOARD:', JSON.stringify(data.task1));
  await page.screenshot({ path: OUT + '/shots/rs2-02-task.png' });

  // ---- wait auto dispatch to creator session -> done (<=4min)
  let done1 = false, doingShot1 = false;
  const t1start = Date.now();
  for (let i = 0; i < 50; i++) {
    await sleep(5000);
    const s = await snap();
    const bt = readBoardTask(title1).task;
    const rec = { t: Math.round((Date.now() - t1start) / 1000), status: bt ? bt.status : 'missing', pollSid: s.poll.lastDispatchSessionId, pollAt: s.poll.lastDispatchAt, agents: s.agents.map(a => a.sessionId + ':' + a.status) };
    data.timeline.push(rec);
    console.log('t+' + rec.t + 's status=' + rec.status + ' pollSid=' + rec.pollSid + ' agents=' + JSON.stringify(rec.agents));
    if (bt && bt.status === 'doing' && !doingShot1) { doingShot1 = true; await page.screenshot({ path: OUT + '/shots/rs2-03-doing.png' }); }
    if (bt && bt.status === 'done') { done1 = true; break; }
  }
  data.done1 = done1;
  const s1 = await snap();
  data.pollAfter1 = s1.poll;
  data.task1Final = readBoardTask(title1);
  data.bound1 = !!(data.task1.task && s1.poll.lastDispatchSessionId === data.task1.task.sessionId);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + '/shots/rs2-04-done.png' });
  const ws1 = 'C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\ws-demo.txt';
  data.wsDemo1 = fs.existsSync(ws1) ? { exists: true, content: fs.readFileSync(ws1, 'utf8'), bytes: fs.statSync(ws1).size } : { exists: false };
  console.log('TASK1 FINAL:', JSON.stringify(data.task1Final), 'bound1=', data.bound1, 'wsDemo1=', JSON.stringify(data.wsDemo1));

  // ---- session B + task 2
  await closeBoardTab();
  data.sessionB = await openSession(['刷新小时会话', 'dsh子代理派发模式插件开发', '寻找出售住宅IP的NTT平台']);
  await openBoardViaHeader();
  await page.waitForTimeout(1500);
  data.composerB = await composerText();
  console.log('SESSION B:', data.sessionB, 'COMPOSER:', JSON.stringify(data.composerB));
  const title2 = 'WS 验证 2：在 .dev/e2e/ws-demo2.txt 写入一行 demo2';
  await addTask(title2, '验收标准：C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\ws-demo2.txt 恰好一行 demo2（demo2+LF）；完成后把任务置为 done 并在 result 写可核验结论。');
  await sleep(1000);
  data.task2 = readBoardTask(title2);
  console.log('TASK2 BOARD:', JSON.stringify(data.task2));
  await page.screenshot({ path: OUT + '/shots/rs2-05-second.png' });
  // wait dispatch to session B (<=3min)
  let bound2 = false, done2 = false;
  const t2start = Date.now();
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const s = await snap();
    const bt2 = readBoardTask(title2).task;
    data.timeline2 = data.timeline2 || [];
    const rec = { t: Math.round((Date.now() - t2start) / 1000), status: bt2 ? bt2.status : 'missing', pollSid: s.poll.lastDispatchSessionId, agents: s.agents.map(a => a.sessionId + ':' + a.status) };
    data.timeline2.push(rec);
    console.log('T2 t+' + rec.t + 's status=' + rec.status + ' pollSid=' + rec.pollSid);
    if (bt2 && bt2.sessionId && s.poll.lastDispatchSessionId === bt2.sessionId) bound2 = true;
    if (bt2 && bt2.status === 'done') { done2 = true; break; }
    if (bound2 && rec.t > 25) break;
  }
  data.bound2 = bound2;
  data.done2 = done2;
  const s2 = await snap();
  data.pollAfter2 = s2.poll;
  data.task2Final = readBoardTask(title2);
  data.twoDistinctSessions = !!(data.task1.task && data.task2.task && data.task1.task.sessionId && data.task2.task.sessionId && data.task1.task.sessionId !== data.task2.task.sessionId);
  await page.screenshot({ path: OUT + '/shots/rs2-06-second-dispatched.png' });
  console.log('TASK2 FINAL:', JSON.stringify(data.task2Final), 'bound2=', bound2, 'distinct=', data.twoDistinctSessions, 'done2=', done2);

  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/rs2-data.json', JSON.stringify(data, null, 1));
  fs.writeFileSync(OUT + '/shots/rs2-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-120) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)));
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
