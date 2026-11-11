const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const BOARD = 'C:\\Users\\duan\\.dsh\\storages\\dsh-taskboard\\board.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'cold2-' + Math.random().toString(36).slice(2);
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
  const composerText = () => page.evaluate(() => { const c = document.querySelector('.tb-composer'); return c ? c.innerText.replace(/\n+/g, ' | ') : null; });
  const cardText = title => page.evaluate((t) => { const c = Array.from(document.querySelectorAll('.tb-card')).find(x => (x.innerText || '').includes(t)); return c ? c.innerText.replace(/\n+/g, ' | ') : null; }, title);

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  data.agentsBefore = (await snap()).agents;

  // open a cold historical session
  const candidatesSessions = ['刷新小时会话', '寻找出售住宅IP的NTT平台', 'dsh子代理派发模式插件开发'];
  data.coldSessionName = null;
  for (const name of candidatesSessions) {
    const row = page.getByText(name, { exact: true }).first();
    if (await row.count()) { await row.click(); await page.waitForTimeout(4000); data.coldSessionName = name; break; }
  }
  data.agentsAfterOpen = (await snap()).agents;
  console.log('cold session:', data.coldSessionName, 'agents:', JSON.stringify(data.agentsAfterOpen.map(a => a.sessionId)));

  // open board from header
  data.headBtnCount = await page.locator('.tb-headbtn').count();
  if (data.headBtnCount) { await page.locator('.tb-headbtn').first().click(); await page.waitForTimeout(3000); }
  data.composerCold = await composerText();
  console.log('COMPOSER(cold):', JSON.stringify(data.composerCold));
  await page.screenshot({ path: OUT + '/shots/cold2-01-hint.png' });

  // ---------- (1) add task A from cold session
  const titleA = 'COLD2 验证A：在 .dev/e2e/cold-demo2.txt 写入一行 cold2';
  await page.locator('input.tb-input').fill(titleA);
  const nb = page.locator('button.tb-linkbtn');
  if (await nb.count()) { await nb.click(); await page.waitForTimeout(400); await page.locator('textarea.tb-textarea').fill('验收标准：C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\cold-demo2.txt 恰好一行 cold2（cold2+LF）；完成后置 done 并在 result 写可核验结论。'); }
  await page.getByRole('button', { name: '添加到待开始', exact: true }).click();
  await sleep(1200);
  data.taskAInitial = taskByTitle(readBoard(), titleA);
  data.cardAInitial = await cardText('COLD2 验证A');
  console.log('TASK A INITIAL:', JSON.stringify(data.taskAInitial));
  console.log('CARD A:', JSON.stringify(data.cardAInitial));
  await page.screenshot({ path: OUT + '/shots/cold2-02-task.png' });

  // ---------- (2) wait 90s: should stay todo with creator-cold reason, no dispatch
  const pollBefore = (await snap()).poll;
  await sleep(90000);
  const snapPending = await snap();
  data.pollPending = snapPending.poll;
  data.taskAPending = taskByTitle(readBoard(), titleA);
  data.cardAPending = await cardText('COLD2 验证A');
  data.pollUnchanged = JSON.stringify(pollBefore.lastDispatchSessionId) === JSON.stringify(snapPending.poll.lastDispatchSessionId);
  console.log('PENDING poll:', JSON.stringify(snapPending.poll));
  console.log('TASK A PENDING:', JSON.stringify(data.taskAPending));
  console.log('CARD A PENDING:', JSON.stringify(data.cardAPending));
  await page.screenshot({ path: OUT + '/shots/cold2-03-pending-reason.png' });

  // ---------- (3) force escape hatch: click 立即派发 on task A -> expect other idle session
  const cardA = page.locator('.tb-card').filter({ hasText: 'COLD2 验证A' }).first();
  let forceOk = false;
  if (await cardA.count()) {
    await cardA.getByRole('button', { name: '立即派发' }).click();
    await page.waitForTimeout(4000);
    const s2 = await snap();
    const tA = taskByTitle(readBoard(), titleA);
    data.forcePoll = s2.poll;
    data.taskAAfterForce = tA;
    forceOk = !!(tA && tA.sessionId && s2.poll.lastDispatchSessionId && s2.poll.lastDispatchSessionId !== tA.sessionId);
    console.log('AFTER FORCE poll:', JSON.stringify(s2.poll), 'taskA:', JSON.stringify(tA), 'forceOk=', forceOk);
    await page.screenshot({ path: OUT + '/shots/cold2-04-force-dispatched.png' });
  }
  data.forceOk = forceOk;

  // ---------- (4) add task B from the same cold session, then activate by sending a message
  const titleB = 'COLD2 验证B：在 .dev/e2e/cold-demo3.txt 写入一行 cold3';
  await page.locator('input.tb-input').fill(titleB);
  const nb2 = page.locator('button.tb-linkbtn');
  if (await nb2.count()) { await nb2.click(); await page.waitForTimeout(400); await page.locator('textarea.tb-textarea').fill('验收标准：C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\cold-demo3.txt 恰好一行 cold3（cold3+LF）；完成后置 done 并在 result 写可核验结论。'); }
  else { await page.locator('textarea.tb-textarea').fill('验收标准：C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\cold-demo3.txt 恰好一行 cold3（cold3+LF）；完成后置 done 并在 result 写可核验结论。'); }
  await page.getByRole('button', { name: '添加到待开始', exact: true }).click();
  await sleep(1500);
  data.taskBInitial = taskByTitle(readBoard(), titleB);
  console.log('TASK B INITIAL:', JSON.stringify(data.taskBInitial));
  await sleep(20000);
  data.taskBPending = taskByTitle(readBoard(), titleB);
  data.cardBPending = await cardText('COLD2 验证B');
  console.log('TASK B PENDING:', JSON.stringify(data.taskBPending), 'CARD B:', JSON.stringify(data.cardBPending));

  // activate the cold session by sending a message in it
  const editor = page.locator('[contenteditable="true"][aria-label^="描述你想要构建的内容"]').first();
  await editor.click();
  await page.keyboard.type('继续', { delay: 20 });
  await page.getByRole('button', { name: '发送消息', exact: true }).first().click();
  console.log('activation message sent at', new Date().toISOString());
  let activated = false;
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const s = await snap();
    const tB = taskByTitle(readBoard(), titleB);
    const creatorLive = tB && tB.sessionId ? s.agents.some(a => a.sessionId === tB.sessionId) : false;
    if (creatorLive && !activated) { activated = true; data.activatedAt = i * 5; await page.screenshot({ path: OUT + '/shots/cold2-05-activated.png' }); }
    if (tB && tB.sessionId && s.poll.lastDispatchSessionId === tB.sessionId) data.boundB = true;
    console.log('act t+' + (i * 5) + 's creatorLive=' + creatorLive + ' status=' + (tB ? tB.status : '?') + ' pollSid=' + s.poll.lastDispatchSessionId);
    if (creatorLive) break;
  }
  data.activated = activated;
  // wait dispatch back to creator + doing -> done
  let doingShot = false, doneB = false;
  for (let i = 0; i < 48; i++) {
    await sleep(5000);
    const s = await snap();
    const tB = taskByTitle(readBoard(), titleB);
    data.timelineB = data.timelineB || [];
    data.timelineB.push({ t: i * 5, status: tB ? tB.status : 'missing', pollSid: s.poll.lastDispatchSessionId });
    if (tB && tB.sessionId && s.poll.lastDispatchSessionId === tB.sessionId) data.boundB = true;
    if (tB && tB.status === 'doing' && !doingShot) { doingShot = true; await page.screenshot({ path: OUT + '/shots/cold2-06-doing.png' }); }
    console.log('B t+' + (i * 5) + 's status=' + (tB ? tB.status : '?') + ' pollSid=' + s.poll.lastDispatchSessionId);
    if (tB && tB.status === 'done') { doneB = true; break; }
  }
  data.doneB = doneB;
  data.pollFinal = (await snap()).poll;
  data.taskBFinal = taskByTitle(readBoard(), titleB);
  const file = 'C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\cold-demo3.txt';
  data.coldDemo3 = fs.existsSync(file) ? { exists: true, content: fs.readFileSync(file, 'utf8'), bytes: fs.statSync(file).size } : { exists: false };
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/shots/cold2-07-done.png' });
  console.log('FINAL:', JSON.stringify({ activated, boundB: data.boundB, doneB, taskBFinal: data.taskBFinal, coldDemo3: data.coldDemo3 }));
  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/cold2-data.json', JSON.stringify(data, null, 1));
  fs.writeFileSync(OUT + '/shots/cold2-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-120) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)));
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
