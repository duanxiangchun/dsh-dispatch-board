const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const BOARD = 'C:\\Users\\duan\\.dsh\\storages\\dsh-taskboard\\board.json';
const COLD_ID = 'session-32108038-79e6-4229-9ac1-42a677e5bce2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'cold6-' + Math.random().toString(36).slice(2);
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
  const title = 'COLD3 验证：在 .dev/e2e/cold-demo4.txt 写入一行 cold4';
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 400) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 400) }));
  page.on('dialog', d => d.accept().catch(() => {}));
  const cardText = t => page.evaluate((needle) => { const c = Array.from(document.querySelectorAll('.tb-card')).find(x => (x.innerText || '').includes(needle)); return c ? c.innerText.replace(/\n+/g, ' | ') : null; }, t);

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  const exp = page.getByRole('button', { name: /展开其余/ }).first();
  if (await exp.count()) { await exp.click(); await page.waitForTimeout(1200); }
  const row = page.getByText('刷新小时会话', { exact: true }).first();
  data.rowCount = await row.count();
  if (await row.count()) { await row.click(); await page.waitForTimeout(5000); }
  data.agentsAfterOpen = (await snap()).agents;
  data.stillCold = !data.agentsAfterOpen.some(a => a.sessionId === COLD_ID);
  console.log('ROW:', data.rowCount, 'stillCold=', data.stillCold);

  // open board
  data.headBtn = await page.locator('.tb-headbtn').count();
  if (data.headBtn) { await page.locator('.tb-headbtn').first().click(); await page.waitForTimeout(3000); }
  data.cardPending = await cardText('COLD3 验证');
  data.taskPending = taskByTitle(readBoard(), title);
  console.log('TASK PENDING:', JSON.stringify(data.taskPending));
  console.log('CARD PENDING:', JSON.stringify(data.cardPending));
  await page.screenshot({ path: OUT + '/shots/cold6-01-pending.png' });

  // send "继续" by Enter
  const editors = await page.locator('[contenteditable="true"]').all();
  data.editorArias = [];
  let editor = null;
  for (const e of editors) { const aria = await e.getAttribute('aria-label'); data.editorArias.push(aria); if (aria && aria.includes('发消息或创建任务')) editor = e; }
  if (!editor && editors.length) editor = editors[editors.length - 1];
  await editor.click();
  await page.keyboard.type('继续，请简短回复 ok。', { delay: 25 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await sleep(2500);
  data.composerAfterSend = await page.evaluate(() => { const e = document.querySelector('[contenteditable="true"]'); return e ? e.innerText.slice(0, 120) : null; });
  data.bodyHasMsg = await page.evaluate(() => document.body.innerText.includes('继续，请简短回复'));
  console.log('AFTER SEND composer=', JSON.stringify(data.composerAfterSend), 'bodyHasMsg=', data.bodyHasMsg);
  await page.screenshot({ path: OUT + '/shots/cold6-02-sent.png' });

  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const s = await snap();
    const live = s.agents.some(a => a.sessionId === COLD_ID);
    console.log('act t+' + ((i + 1) * 5) + 's creatorLive=' + live);
    if (live) { data.activated = true; data.activatedAt = (i + 1) * 5; break; }
  }
  await page.screenshot({ path: OUT + '/shots/cold6-03-activated.png' });

  data.timeline = [];
  let doingShot = false, bound = false, done = false;
  for (let i = 0; i < 72; i++) {
    await sleep(5000);
    const s = await snap();
    const t = taskByTitle(readBoard(), title);
    data.timeline.push({ t: (i + 1) * 5, status: t ? t.status : 'missing', pollSid: s.poll.lastDispatchSessionId, skip: s.poll.lastSkipReason });
    if (t && t.sessionId && s.poll.lastDispatchSessionId === t.sessionId) bound = true;
    console.log('B t+' + ((i + 1) * 5) + 's status=' + (t ? t.status : '?') + ' pollSid=' + s.poll.lastDispatchSessionId + ' skip=' + s.poll.lastSkipReason);
    if (t && t.status === 'doing' && !doingShot) { doingShot = true; await page.screenshot({ path: OUT + '/shots/cold6-04-doing.png' }); }
    if (t && t.status === 'done') { done = true; break; }
  }
  data.bound = bound; data.done = done;
  data.pollFinal = (await snap()).poll;
  data.taskFinal = taskByTitle(readBoard(), title);
  const file = 'C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\cold-demo4.txt';
  data.coldDemo4 = fs.existsSync(file) ? { exists: true, content: fs.readFileSync(file, 'utf8'), bytes: fs.statSync(file).size } : { exists: false };
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/shots/cold6-05-done.png' });
  console.log('FINAL:', JSON.stringify({ activated: data.activated, bound, done, taskFinal: data.taskFinal, coldDemo4: data.coldDemo4 }));
  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/cold6-data.json', JSON.stringify(data, null, 1));
  fs.writeFileSync(OUT + '/shots/cold6-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-120) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
