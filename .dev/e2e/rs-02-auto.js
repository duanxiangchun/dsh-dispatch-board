const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'ad-' + Math.random().toString(36).slice(2);
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }) });
  const j = await r.json();
  return j.result;
}
async function snap() { const res = await rpc('snapshot'); return res.value; }
async function openBoard(page) {
  // 1) header button if a conversation is open
  if (await page.locator('.tb-headbtn').count()) {
    await page.locator('.tb-headbtn').first().click();
    await page.waitForTimeout(2500);
    if (await page.locator('.tb-page').count()) return 'header';
  }
  // 2) right sidebar guide entry
  if (!(await page.getByRole('button', { name: '打开右侧边栏', exact: true }).count()) && !(await page.locator('.tb-page').count())) {
    // sidebar may already be open
  }
  if (await page.getByRole('button', { name: '打开右侧边栏', exact: true }).count()) {
    await page.getByRole('button', { name: '打开右侧边栏', exact: true }).first().click();
    await page.waitForTimeout(1500);
  }
  const guide = page.locator('button').filter({ hasText: '看板在右侧栏里' }).first();
  if (await guide.count()) {
    await guide.click();
    await page.waitForTimeout(2500);
    return 'guide';
  }
  const guide2 = page.locator('button').filter({ hasText: '任务看板' }).last();
  if (await guide2.count()) { await guide2.click(); await page.waitForTimeout(2500); return 'guide2'; }
  // 3) open a session then header button
  const row = page.getByText('dsh子代理派发模式插件开发', { exact: true }).first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(3000); }
  if (await page.locator('.tb-headbtn').count()) { await page.locator('.tb-headbtn').first().click(); await page.waitForTimeout(2500); return 'session-header'; }
  return 'none';
}
(async () => {
  const consoleEvents = [];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 400) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 400) }));
  page.on('dialog', d => d.accept().catch(() => {}));
  const data = { timeline: [] };

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  data.openVia = await openBoard(page);
  console.log('OPEN BOARD VIA:', data.openVia, 'tbPage=', await page.locator('.tb-page').count());
  await page.waitForTimeout(1500);
  data.agentsAtStart = (await snap()).agents;
  console.log('AGENTS AT START:', JSON.stringify(data.agentsAtStart));

  // (1) composer visual
  data.composer = await page.evaluate(() => {
    const c = document.querySelector('.tb-composer');
    return c ? { text: c.innerText.replace(/\n+/g, ' | '), selectCount: c.querySelectorAll('select').length, hasTargetText: /派发给/.test(c.innerText) } : null;
  });
  console.log('COMPOSER:', JSON.stringify(data.composer));
  await page.screenshot({ path: OUT + '/shots/rs-01-composer.png' });

  // ensure polling on
  const resumeBtn = page.getByRole('button', { name: '恢复轮询', exact: true });
  if (await resumeBtn.count()) { await resumeBtn.click(); await page.waitForTimeout(600); }
  data.pollStateText = await page.evaluate(() => { const p = document.querySelector('.tb-sub'); return p ? p.innerText.trim() : null; });

  // (2) add task only, then do nothing
  const title = 'RS 自动派发：在 .dev/e2e/rs-auto.txt 写入一行 auto';
  await page.locator('input.tb-input').fill(title);
  const noteBtn = page.locator('button.tb-linkbtn');
  if (await noteBtn.count()) { await noteBtn.click(); await page.waitForTimeout(400); await page.locator('textarea.tb-textarea').fill('验收标准：C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\rs-auto.txt 恰好一行 auto（auto+LF）；完成后把任务置为 done 并在 result 写可核验结论。'); }
  const t0 = Date.now();
  await page.getByRole('button', { name: '添加到待开始', exact: true }).click();
  console.log('TASK ADDED at', new Date().toISOString());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + '/shots/rs-01b-added.png' });

  let done = false, doingShot = false, taskInfo = null, pollInfo = null;
  for (let i = 0; i < 52; i++) {
    await sleep(5000);
    const s = await snap();
    pollInfo = s.poll;
    const t = s.tasks.find(x => x.title === title);
    taskInfo = t || null;
    const rec = { t: Math.round((Date.now() - t0) / 1000), status: t ? t.status : 'missing', pollAt: s.poll.lastDispatchAt, pollSid: s.poll.lastDispatchSessionId, agents: s.agents.map(a => ({ sid: a.sessionId, status: a.status, preset: a.preset })) };
    data.timeline.push(rec);
    console.log('t+' + rec.t + 's status=' + rec.status + ' poll=' + JSON.stringify({ at: rec.pollAt, sid: rec.pollSid }) + ' agents=' + JSON.stringify(rec.agents));
    if (t && t.status === 'doing' && !doingShot) { doingShot = true; await page.screenshot({ path: OUT + '/shots/rs-02-doing.png' }); }
    if (t && t.status === 'done') { done = true; break; }
  }
  data.done = done;
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/shots/rs-03-done.png' });
  data.task = taskInfo;
  const finalSnap = await snap();
  data.finalAgents = finalSnap.agents;
  data.finalPoll = finalSnap.poll;
  const board = JSON.parse(fs.readFileSync('C:\\Users\\duan\\.dsh\\storages\\dsh-taskboard\\board.json', 'utf8'));
  const bt = board.tasks.find(x => x.title === title);
  data.boardTask = bt ? { id: bt.id, status: bt.status, sessionId: bt.sessionId, result: bt.result, source: bt.source } : null;
  data.boardRevision = board.revision;
  data.pollSidOnline = data.finalPoll.lastDispatchSessionId ? data.finalAgents.some(a => a.sessionId === data.finalPoll.lastDispatchSessionId) : false;
  const autoPath = 'C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\rs-auto.txt';
  data.rsAuto = fs.existsSync(autoPath) ? { exists: true, content: fs.readFileSync(autoPath, 'utf8'), bytes: fs.statSync(autoPath).size } : { exists: false };
  console.log('BOARD TASK:', JSON.stringify(data.boardTask));
  console.log('FINAL POLL:', JSON.stringify(data.finalPoll), 'sidOnline=', data.pollSidOnline);
  console.log('RS-AUTO:', JSON.stringify(data.rsAuto));
  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/rs-data.json', JSON.stringify(data, null, 1));
  fs.writeFileSync(OUT + '/shots/rs-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-120) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)));
  console.log('DONE=' + done);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
