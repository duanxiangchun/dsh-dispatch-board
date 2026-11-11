const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const BOARD = 'C:\\Users\\duan\\.dsh\\storages\\dsh-taskboard\\board.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'cold-' + Math.random().toString(36).slice(2);
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }) });
  const j = await r.json();
  return j.result;
}
async function snap() { const res = await rpc('snapshot'); return res.value; }
function readBoard() { return JSON.parse(fs.readFileSync(BOARD, 'utf8')); }
function taskByTitle(b, title) { const t = b.tasks.find(x => x.title === title); return t ? { id: t.id, status: t.status, sessionId: t.sessionId, cwd: t.cwd, result: t.result, lastError: t.lastError } : null; }
(async () => {
  const consoleEvents = [];
  const data = { timeline: [] };
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 400) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 400) }));
  page.on('dialog', d => d.accept().catch(() => {}));
  const composerText = () => page.evaluate(() => { const c = document.querySelector('.tb-composer'); return c ? c.innerText.replace(/\n+/g, ' | ') : null; });
  const cardText = title => page.evaluate((t) => { const c = Array.from(document.querySelectorAll('.tb-card')).find(x => (x.innerText || '').includes(t)); return c ? c.innerText.replace(/\n+/g, ' | ') : null; }, title);

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  data.agentsBeforeOpen = (await snap()).agents;
  console.log('AGENTS BEFORE OPEN:', JSON.stringify(data.agentsBeforeOpen));

  // open historical (cold) session 刷新小时会话
  const target = '刷新小时会话';
  const row = page.getByText(target, { exact: true }).first();
  data.rowCount = await row.count();
  if (await row.count()) { await row.click(); await page.waitForTimeout(4500); }
  data.coldSessionGuessId = 'session-32108038-79e6-4229-9ac1-42a677e5bce2';
  data.agentsAfterOpen = (await snap()).agents;
  data.coldConfirmed = !data.agentsAfterOpen.some(a => a.sessionId === data.coldSessionGuessId);
  console.log('AGENTS AFTER OPEN:', JSON.stringify(data.agentsAfterOpen), 'coldConfirmed=', data.coldConfirmed);
  await page.screenshot({ path: OUT + '/shots/cold-00-session.png' });

  // open board from header
  data.headBtnCount = await page.locator('.tb-headbtn').count();
  if (data.headBtnCount) { await page.locator('.tb-headbtn').first().click(); await page.waitForTimeout(3000); }
  data.composerCold = await composerText();
  console.log('COMPOSER (cold):', JSON.stringify(data.composerCold));
  await page.screenshot({ path: OUT + '/shots/cold-01-hint.png' });

  // (1) add task
  const title = 'COLD 验证：在 .dev/e2e/cold-demo.txt 写入一行 cold';
  await page.locator('input.tb-input').fill(title);
  const nb = page.locator('button.tb-linkbtn');
  if (await nb.count()) { await nb.click(); await page.waitForTimeout(400); await page.locator('textarea.tb-textarea').fill('验收标准：C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\cold-demo.txt 恰好一行 cold（cold+LF）；完成后把任务置为 done 并在 result 写可核验结论。'); }
  await page.getByRole('button', { name: '添加到待开始', exact: true }).click();
  await sleep(1000);
  data.taskInitial = taskByTitle(readBoard(), title);
  data.cardInitial = await cardText('COLD 验证');
  console.log('TASK INITIAL:', JSON.stringify(data.taskInitial));
  console.log('CARD INITIAL:', JSON.stringify(data.cardInitial));
  await page.screenshot({ path: OUT + '/shots/cold-02-task.png' });

  // (2) wait for wake + dispatch to creator -> doing -> done (<=5min)
  let woken = false, doingShot = false, done = false, bound = false;
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const s = await snap();
    const b = readBoard();
    const t = taskByTitle(b, title);
    const hasCreator = s.agents.some(a => a.sessionId === data.coldSessionGuessId);
    const rec = { t: Math.round((Date.now() - t0) / 1000), status: t ? t.status : 'missing', lastError: t ? t.lastError : null, pollSid: s.poll.lastDispatchSessionId, pollAt: s.poll.lastDispatchAt, creatorLive: hasCreator, agents: s.agents.map(a => a.sessionId + ':' + a.status) };
    data.timeline.push(rec);
    console.log('t+' + rec.t + 's status=' + rec.status + ' pollSid=' + rec.pollSid + ' creatorLive=' + hasCreator + ' lastError=' + rec.lastError);
    if (hasCreator && !woken) { woken = true; data.wokenAt = rec.t; await page.screenshot({ path: OUT + '/shots/cold-03-woken.png' }); }
    if (t && t.sessionId && s.poll.lastDispatchSessionId === t.sessionId) bound = true;
    if (t && t.status === 'doing' && !doingShot) { doingShot = true; data.composerAfterWake = await composerText(); await page.screenshot({ path: OUT + '/shots/cold-04-doing.png' }); }
    if (t && t.status === 'done') { done = true; break; }
  }
  data.woken = woken; data.bound = bound; data.done = done;
  data.pollFinal = (await snap()).poll;
  data.taskFinal = taskByTitle(readBoard(), title);
  data.composerFinal = await composerText();
  const file = 'C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\cold-demo.txt';
  data.coldDemo = fs.existsSync(file) ? { exists: true, content: fs.readFileSync(file, 'utf8'), bytes: fs.statSync(file).size } : { exists: false };
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/shots/cold-05-done.png' });
  console.log('FINAL:', JSON.stringify({ woken, bound, done, taskFinal: data.taskFinal, coldDemo: data.coldDemo, poll: data.pollFinal }));
  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/cold-data.json', JSON.stringify(data, null, 1));
  fs.writeFileSync(OUT + '/shots/cold-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-120) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)));
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
