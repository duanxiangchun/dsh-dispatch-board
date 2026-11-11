const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const BOARD = 'C:\\Users\\duan\\.dsh\\storages\\dsh-taskboard\\board.json';
const A_PATH = 'C:\\Users\\duan\\Code\\demo\\demo\\日常问答';
const B_PATH = 'C:\\Users\\duan\\Code\\plinto';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'dual-' + Math.random().toString(36).slice(2);
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
  const titleA = 'DUAL 验证A：只回复 ok，不要改任何文件';
  const titleB = 'DUAL 验证：在 .dev/e2e/dual-b.txt 写入一行 dualb';
  const titleA2 = 'DUAL 验证B2：右栏建任务互通';

  const openPlatform = async () => { await page.getByRole('button', { name: '平台任务看板', exact: true }).first().click(); await page.waitForTimeout(2500); };
  const openSession = async (name) => {
    const exp = page.getByRole('button', { name: /展开其余/ }).first();
    if (await exp.count()) { await exp.click(); await page.waitForTimeout(1000); }
    const row = page.getByText(name, { exact: true }).first();
    if (await row.count()) { await row.click(); await page.waitForTimeout(4000); return true; }
    return false;
  };
  const platformAdd = async (workspace, title, note) => {
    await page.selectOption('select[aria-label="任务所属工作区"]', { label: workspace });
    await page.waitForTimeout(400);
    await page.locator('input.tb-input').fill(title);
    if (note) {
      const nb = page.locator('button.tb-linkbtn');
      if (await nb.count()) { await nb.click(); await page.waitForTimeout(300); await page.locator('textarea.tb-textarea').fill(note); }
    }
    await page.getByRole('button', { name: '添加到待开始', exact: true }).click();
    await page.waitForTimeout(1500);
  };
  const platformBody = () => page.evaluate(() => document.body.innerText);
  const cardsOnPage = () => page.evaluate(() => Array.from(document.querySelectorAll('.tb-card')).map(c => (c.innerText || '').replace(/\n+/g, ' | ').slice(0, 160)));

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }

  // ---------- (2) platform entry + required workspace
  data.leftMenu = await page.evaluate(() => Array.from(document.querySelectorAll('[class*="panelRow"]')).map(b => ({ aria: b.getAttribute('aria-label'), text: (b.innerText || '').trim() })));
  await openPlatform();
  data.platformInitial = { body: (await platformBody()).slice(0, 1200) };
  await page.screenshot({ path: OUT + '/shots/dual-02-platform.png' });
  const addBtn = page.getByRole('button', { name: '添加到待开始', exact: true });
  data.addDisabledBeforeSelect = await addBtn.isDisabled().catch(() => null);
  data.hintBeforeSelect = (await platformBody()).includes('先选择任务所属的工作区');
  await page.locator('input.tb-input').fill('placeholder check');
  data.addDisabledWithTitleNoWs = await addBtn.isDisabled().catch(() => null);
  await page.locator('input.tb-input').fill('');
  await page.screenshot({ path: OUT + '/shots/dual-03-required.png' });
  console.log('PLATFORM INIT disabled=', data.addDisabledBeforeSelect, 'hint=', data.hintBeforeSelect, 'disabledWithTitleNoWs=', data.addDisabledWithTitleNoWs);

  // ---------- create task A (日常问答) and task B (plinto)
  await platformAdd('日常问答', titleA, null);
  await platformAdd('plinto', titleB, '验收标准：C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\dual-b.txt 恰好一行 dualb（dualb+LF）；完成后置 done 并在 result 写可核验结论。');
  data.cardsAfterCreate = await cardsOnPage();
  const board1 = readBoard();
  data.taskA = taskByTitle(board1, titleA);
  data.taskB = taskByTitle(board1, titleB);
  console.log('TASK A:', JSON.stringify(data.taskA), 'TASK B:', JSON.stringify(data.taskB));
  console.log('CARDS:', JSON.stringify(data.cardsAfterCreate));
  await page.screenshot({ path: OUT + '/shots/dual-04-created.png' });

  // wait ~35s: both pending offline reasons
  await sleep(35000);
  data.taskA_offline = taskByTitle(readBoard(), titleA);
  data.taskB_offline = taskByTitle(readBoard(), titleB);
  data.pollOffline = (await snap()).poll;
  data.offlineBody = (await platformBody()).slice(0, 1500);
  await page.screenshot({ path: OUT + '/shots/dual-05-offline.png' });
  console.log('OFFLINE A:', JSON.stringify(data.taskA_offline), 'B:', JSON.stringify(data.taskB_offline), 'poll=', JSON.stringify(data.pollOffline));

  // ---------- (1) right board scope: open A session
  data.openedA = await openSession('WS 绑定自检');
  data.headBtnCount = await page.locator('.tb-headbtn').count();
  if (data.headBtnCount) { await page.locator('.tb-headbtn').first().click(); await page.waitForTimeout(3000); }
  data.rightBoardText = await page.evaluate(() => {
    const p = document.querySelector('.tb-page');
    return p ? p.innerText.replace(/\n+/g, ' | ').slice(0, 900) : null;
  });
  data.rightCards = await page.evaluate(() => Array.from(document.querySelectorAll('.tb-page .tb-card')).map(c => (c.innerText || '').replace(/\n+/g, ' | ').slice(0, 120)));
  await page.screenshot({ path: OUT + '/shots/dual-01-right-scope.png' });
  console.log('RIGHT BOARD:', JSON.stringify(data.rightBoardText));
  console.log('RIGHT CARDS:', JSON.stringify(data.rightCards));

  // ---------- (3) workspace B session + auto dispatch
  await page.getByRole('button', { name: '新会话', exact: true }).first().click().catch(async () => { await page.getByRole('button', { name: '新建会话', exact: true }).first().click(); });
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: '选择工作区', exact: true }).first().click();
  await page.waitForTimeout(1000);
  await page.locator('[role=menuitem]').filter({ hasText: 'plinto' }).first().click();
  await page.waitForTimeout(800);
  const editor = page.locator('[contenteditable="true"][aria-label*="文件或对话"]').first();
  await editor.click();
  await page.keyboard.type('自检：只回复 ok，不要使用工具。', { delay: 8 });
  await page.getByRole('button', { name: '发送消息', exact: true }).first().click();
  console.log('B session message sent');
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const txt = await platformBody();
    const stop = await page.getByRole('button', { name: /停止|stop/i }).count();
    if (stop === 0 && /\bok\b/i.test(txt)) { data.bTurnDone = true; break; }
  }
  data.agentsAfterB = (await snap()).agents;
  data.bSessionId = (data.agentsAfterB.find(a => a.cwd && a.cwd.replace(/\\+$/, '') === B_PATH.replace(/\\+$/, '')) || {}).sessionId || null;
  console.log('B SESSION ID:', data.bSessionId, 'agents=', JSON.stringify(data.agentsAfterB.map(a => a.sessionId + ':' + a.cwd)));

  // wait dispatch of B task to B session -> doing -> done
  data.timelineB = [];
  let doingShot = false, doneB = false, boundB = false;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const s = await snap();
    const t = taskByTitle(readBoard(), titleB);
    data.timelineB.push({ t: (i + 1) * 5, status: t ? t.status : 'missing', pollSid: s.poll.lastDispatchSessionId, skip: s.poll.lastSkipReason });
    if (t && t.sessionId === null && s.poll.lastDispatchSessionId === data.bSessionId) boundB = true;
    if (!boundB && data.bSessionId && s.poll.lastDispatchSessionId === data.bSessionId) boundB = true;
    console.log('B t+' + ((i + 1) * 5) + 's status=' + (t ? t.status : '?') + ' pollSid=' + s.poll.lastDispatchSessionId + ' skip=' + s.poll.lastSkipReason);
    if (t && t.status === 'doing' && !doingShot) { doingShot = true; await page.screenshot({ path: OUT + '/shots/dual-05b-doing.png' }); }
    if (t && t.status === 'done') { doneB = true; break; }
  }
  data.boundB = boundB; data.doneB = doneB;
  data.taskBFinal = taskByTitle(readBoard(), titleB);
  const fileB = 'C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\dual-b.txt';
  data.dualB = fs.existsSync(fileB) ? { exists: true, content: fs.readFileSync(fileB, 'utf8'), bytes: fs.statSync(fileB).size } : { exists: false };
  await page.screenshot({ path: OUT + '/shots/dual-05c-done.png' });
  console.log('B FINAL:', JSON.stringify(data.taskBFinal), 'boundB=', boundB, 'dualB=', JSON.stringify(data.dualB));

  // ---------- (5) filter test
  await openPlatform();
  const filterSel = 'select[aria-label="工作区"]';
  await page.selectOption(filterSel, { label: '全部工作区' });
  await page.waitForTimeout(1200);
  data.filterAll = await cardsOnPage();
  await page.screenshot({ path: OUT + '/shots/dual-06-filter-all.png' });
  await page.selectOption(filterSel, { label: 'plinto' });
  await page.waitForTimeout(1200);
  data.filterPlinto = await cardsOnPage();
  await page.selectOption(filterSel, { label: '日常问答' });
  await page.waitForTimeout(1200);
  data.filterDaily = await cardsOnPage();
  data.filterText = (await platformBody()).slice(0, 1200);
  await page.screenshot({ path: OUT + '/shots/dual-06-filter.png' });
  console.log('FILTER all:', data.filterAll.length, 'plinto:', JSON.stringify(data.filterPlinto), 'daily:', JSON.stringify(data.filterDaily));

  // ---------- (6) right board add task, platform sees it
  data.openedA2 = await openSession('WS 绑定自检');
  if (await page.locator('.tb-page').count() === 0 && await page.locator('.tb-headbtn').count()) { await page.locator('.tb-headbtn').first().click(); await page.waitForTimeout(2500); }
  await page.locator('.tb-page input.tb-input').first().fill(titleA2);
  await page.locator('.tb-page').getByRole('button', { name: '添加到待开始' }).first().click();
  await page.waitForTimeout(1500);
  data.taskA2 = taskByTitle(readBoard(), titleA2);
  await page.screenshot({ path: OUT + '/shots/dual-07-right-add.png' });
  await openPlatform();
  await page.selectOption(filterSel, { label: '全部工作区' });
  await page.waitForTimeout(1500);
  data.platformSeesA2 = (await cardsOnPage()).some(t => t.includes(titleA2));
  data.platformCardsFinal = await cardsOnPage();
  await page.screenshot({ path: OUT + '/shots/dual-07-both.png' });
  console.log('A2:', JSON.stringify(data.taskA2), 'platformSeesA2=', data.platformSeesA2);

  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/dual-data.json', JSON.stringify(data, null, 1));
  fs.writeFileSync(OUT + '/shots/dual-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-150) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)));
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
