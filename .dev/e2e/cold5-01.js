const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const BOARD = 'C:\\Users\\duan\\.dsh\\storages\\dsh-taskboard\\board.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'cold5-' + Math.random().toString(36).slice(2);
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
  const title = 'COLD3 验证：在 .dev/e2e/cold-demo4.txt 写入一行 cold4';

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  const exp = page.getByRole('button', { name: /展开其余/ }).first();
  if (await exp.count()) { await exp.click(); await page.waitForTimeout(1200); }

  // open smaller cold historical session
  data.sessionName = null;
  for (const name of ['刷新小时会话', '寻找出售住宅IP的NTT平台']) {
    const row = page.getByText(name, { exact: true }).first();
    if (await row.count()) { await row.click(); await page.waitForTimeout(6000); data.sessionName = name; break; }
  }
  const headerTitle = await page.evaluate(() => { const h = document.querySelector('[class*="header"] [class*="title"], h1'); return h ? (h.innerText || '').slice(0, 80) : document.body.innerText.slice(0, 120); });
  data.headerTitle = headerTitle;
  console.log('OPENED SESSION:', data.sessionName, 'header:', JSON.stringify(headerTitle));
  data.agentsAfterOpen = (await snap()).agents;
  console.log('AGENTS:', JSON.stringify(data.agentsAfterOpen.map(a => a.sessionId + ':' + a.status)));

  // open board
  data.headBtn = await page.locator('.tb-headbtn').count();
  if (data.headBtn) { await page.locator('.tb-headbtn').first().click(); await page.waitForTimeout(3000); }
  data.composer = await page.evaluate(() => { const c = document.querySelector('.tb-composer'); return c ? c.innerText.replace(/\n+/g, ' | ') : null; });
  console.log('COMPOSER:', JSON.stringify(data.composer));

  // add task
  await page.locator('input.tb-input').fill(title);
  const nb = page.locator('button.tb-linkbtn');
  if (await nb.count()) { await nb.click(); await page.waitForTimeout(400); await page.locator('textarea.tb-textarea').fill('验收标准：C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\cold-demo4.txt 恰好一行 cold4（cold4+LF）；完成后置 done 并在 result 写可核验结论。'); }
  await page.getByRole('button', { name: '添加到待开始', exact: true }).click();
  await sleep(1500);
  data.taskInitial = taskByTitle(readBoard(), title);
  data.cardInitial = await cardText('COLD3 验证');
  console.log('TASK INITIAL:', JSON.stringify(data.taskInitial));
  console.log('CARD:', JSON.stringify(data.cardInitial));
  await page.screenshot({ path: OUT + '/shots/cold5-01-task.png' });

  // wait 90s: must stay todo + reason + no dispatch
  const pollBefore = (await snap()).poll;
  await sleep(90000);
  const sp = await snap();
  data.taskPending = taskByTitle(readBoard(), title);
  data.pollPending = sp.poll;
  data.cardPending = await cardText('COLD3 验证');
  data.pollUnchanged = pollBefore.lastDispatchSessionId === sp.poll.lastDispatchSessionId;
  console.log('PENDING:', JSON.stringify(data.taskPending), 'skip=', sp.poll.lastSkipReason, 'pollUnchanged=', data.pollUnchanged);
  console.log('CARD PENDING:', JSON.stringify(data.cardPending));
  await page.screenshot({ path: OUT + '/shots/cold5-02-pending.png' });

  // activate by sending a message in this session
  const editors = await page.locator('[contenteditable="true"]').all();
  data.editorArias = [];
  let editor = null;
  for (const e of editors) {
    const aria = await e.getAttribute('aria-label');
    data.editorArias.push(aria);
    if (aria && aria.includes('发消息或创建任务')) editor = e;
  }
  if (!editor && editors.length) editor = editors[editors.length - 1];
  await editor.click();
  await page.keyboard.type('继续', { delay: 30 });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: '发送消息', exact: true }).first().click();
  console.log('activation message sent at', new Date().toISOString());
  const creatorId = data.taskInitial.sessionId;
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const s = await snap();
    const live = s.agents.some(a => a.sessionId === creatorId);
    console.log('act t+' + ((i + 1) * 5) + 's creatorLive=' + live + ' agents=' + JSON.stringify(s.agents.map(a => a.sessionId.slice(-8) + ':' + a.status)));
    if (live) { data.activated = true; data.activatedAt = (i + 1) * 5; break; }
  }
  await page.screenshot({ path: OUT + '/shots/cold5-03-activated.png' });

  // wait dispatch back to creator + doing -> done
  data.timeline = [];
  let doingShot = false, bound = false, done = false;
  for (let i = 0; i < 72; i++) {
    await sleep(5000);
    const s = await snap();
    const t = taskByTitle(readBoard(), title);
    data.timeline.push({ t: (i + 1) * 5, status: t ? t.status : 'missing', pollSid: s.poll.lastDispatchSessionId, skip: s.poll.lastSkipReason });
    if (t && t.sessionId && s.poll.lastDispatchSessionId === t.sessionId) bound = true;
    console.log('B t+' + ((i + 1) * 5) + 's status=' + (t ? t.status : '?') + ' pollSid=' + s.poll.lastDispatchSessionId + ' skip=' + s.poll.lastSkipReason);
    if (t && t.status === 'doing' && !doingShot) { doingShot = true; await page.screenshot({ path: OUT + '/shots/cold5-04-doing.png' }); }
    if (t && t.status === 'done') { done = true; break; }
  }
  data.bound = bound; data.done = done;
  data.pollFinal = (await snap()).poll;
  data.taskFinal = taskByTitle(readBoard(), title);
  const file = 'C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\cold-demo4.txt';
  data.coldDemo4 = fs.existsSync(file) ? { exists: true, content: fs.readFileSync(file, 'utf8'), bytes: fs.statSync(file).size } : { exists: false };
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/shots/cold5-05-done.png' });
  console.log('FINAL:', JSON.stringify({ activated: data.activated, bound, done, taskFinal: data.taskFinal, coldDemo4: data.coldDemo4 }));
  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/cold5-data.json', JSON.stringify(data, null, 1));
  fs.writeFileSync(OUT + '/shots/cold5-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-120) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
