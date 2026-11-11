const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const BOARD = 'C:\\Users\\duan\\.dsh\\storages\\dsh-taskboard\\board.json';
const COLD_ID = 'session-e7a5bfc7-28c1-444c-bfb0-e73cb3b03515';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'cold4-' + Math.random().toString(36).slice(2);
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }) });
  const j = await r.json();
  return j.result;
}
async function snap() { const res = await rpc('snapshot'); return res.value; }
function readBoard() { return JSON.parse(fs.readFileSync(BOARD, 'utf8')); }
function taskByTitle(b, title) { const t = b.tasks.find(x => x.title === title); return t ? { id: t.id, status: t.status, sessionId: t.sessionId, cwd: t.cwd, result: t.result, lastError: t.lastError } : null; }
(async () => {
  const consoleEvents = [];
  const data = {};
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 400) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 400) }));
  page.on('dialog', d => d.accept().catch(() => {}));
  const cardText = title => page.evaluate((t) => { const c = Array.from(document.querySelectorAll('.tb-card')).find(x => (x.innerText || '').includes(t)); return c ? c.innerText.replace(/\n+/g, ' | ') : null; }, title);
  const titleB = 'COLD2 验证B：在 .dev/e2e/cold-demo3.txt 写入一行 cold3';

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }

  // expand hidden sessions if needed
  const exp = page.getByRole('button', { name: /展开其余/ }).first();
  if (await exp.count()) { await exp.click(); await page.waitForTimeout(1500); data.expanded = true; }
  const row = page.getByText('dsh子代理派发模式插件开发', { exact: true }).first();
  data.rowCount = await row.count();
  if (await row.count()) { await row.click(); await page.waitForTimeout(4500); }
  data.agentsAfterOpen = (await snap()).agents;
  data.stillCold = !data.agentsAfterOpen.some(a => a.sessionId === COLD_ID);
  console.log('ROW:', data.rowCount, 'stillCold=', data.stillCold, 'agents=', JSON.stringify(data.agentsAfterOpen.map(a => a.sessionId)));

  // open board via header
  data.headBtn = await page.locator('.tb-headbtn').count();
  if (data.headBtn) { await page.locator('.tb-headbtn').first().click(); await page.waitForTimeout(3000); }
  data.cardBPending = await cardText('COLD2 验证B');
  data.taskBPending = taskByTitle(readBoard(), titleB);
  data.pollBeforeActivate = (await snap()).poll;
  console.log('CARD B PENDING:', JSON.stringify(data.cardBPending));
  console.log('TASK B PENDING:', JSON.stringify(data.taskBPending));
  await page.screenshot({ path: OUT + '/shots/cold2-05-pending-reason.png' });

  // find conversation composer (not home composer)
  const editors = await page.locator('[contenteditable="true"]').all();
  data.editorCount = editors.length;
  let editor = null;
  for (const e of editors) {
    const aria = await e.getAttribute('aria-label');
    data.editorArias = data.editorArias || [];
    data.editorArias.push(aria);
    if (aria && aria.includes('发消息或创建任务')) { editor = e; break; }
  }
  if (!editor && editors.length) editor = editors[editors.length - 1];
  await editor.click();
  await page.keyboard.type('继续', { delay: 30 });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '发送消息', exact: true }).first().click();
  console.log('activation message sent at', new Date().toISOString());
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    const s = await snap();
    const live = s.agents.some(a => a.sessionId === COLD_ID);
    console.log('act t+' + ((i + 1) * 4) + 's creatorLive=' + live);
    if (live) { data.activated = true; data.activatedAt = (i + 1) * 4; break; }
  }
  await page.screenshot({ path: OUT + '/shots/cold2-06-activated.png' });

  // wait dispatch back to creator -> doing -> done
  data.timeline = [];
  let doingShot = false, bound = false, done = false;
  for (let i = 0; i < 80; i++) {
    await sleep(5000);
    const s = await snap();
    const t = taskByTitle(readBoard(), titleB);
    data.timeline.push({ t: (i + 1) * 5, status: t ? t.status : 'missing', pollSid: s.poll.lastDispatchSessionId, skip: s.poll.lastSkipReason });
    if (t && t.sessionId && s.poll.lastDispatchSessionId === t.sessionId) bound = true;
    console.log('B t+' + ((i + 1) * 5) + 's status=' + (t ? t.status : '?') + ' pollSid=' + s.poll.lastDispatchSessionId + ' skip=' + s.poll.lastSkipReason);
    if (t && t.status === 'doing' && !doingShot) { doingShot = true; await page.screenshot({ path: OUT + '/shots/cold2-07-doing.png' }); }
    if (t && t.status === 'done') { done = true; break; }
  }
  data.bound = bound; data.done = done;
  data.pollFinal = (await snap()).poll;
  data.taskBFinal = taskByTitle(readBoard(), titleB);
  const file = 'C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\cold-demo3.txt';
  data.coldDemo3 = fs.existsSync(file) ? { exists: true, content: fs.readFileSync(file, 'utf8'), bytes: fs.statSync(file).size } : { exists: false };
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/shots/cold2-08-done.png' });
  console.log('FINAL:', JSON.stringify({ activated: data.activated, bound, done, taskBFinal: data.taskBFinal, coldDemo3: data.coldDemo3, poll: data.pollFinal }));
  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/cold4-data.json', JSON.stringify(data, null, 1));
  fs.writeFileSync(OUT + '/shots/cold4-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-120) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
