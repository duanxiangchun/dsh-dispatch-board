const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const BOARD = 'C:\\Users\\duan\\.dsh\\storages\\dsh-taskboard\\board.json';
const FAKE = 'session-00000000-0000-0000-0000-000000000000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'fix2-' + Math.random().toString(36).slice(2);
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }) });
  const j = await r.json();
  if (!j.result || j.result.ok === false) throw new Error(method + ': ' + JSON.stringify(j.result && j.result.error));
  return j.result.value;
}
async function snap() { return await rpc('snapshot'); }
function readBoard() { return JSON.parse(fs.readFileSync(BOARD, 'utf8')); }
function taskByTitle(b, title) { const t = b.tasks.find(x => x.title === title); return t ? { id: t.id, status: t.status, sessionId: t.sessionId, cwd: t.cwd } : null; }
(async () => {
  const consoleEvents = [];
  const data = {};
  const tA = 'LEGACY 验证A：无 cwd 但属于本对话';
  const tB = 'LEGACY 验证B：无 cwd 且属于别的会话';
  const tC = 'LEGACY 验证C：平台看板本工作区任务';
  const tD = 'LEGACY 验证D：平台看板别的工作区任务';
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 400) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 400) }));
  page.on('dialog', d => d.accept().catch(() => {}));
  const rightText = () => page.evaluate(() => { const p = document.querySelector('.tb-page'); return p ? p.innerText.replace(/\n+/g, ' | ') : null; });
  const rightCards = () => page.evaluate(() => Array.from(document.querySelectorAll('.tb-page .tb-card')).map(c => (c.innerText || '').replace(/\n+/g, ' | ').slice(0, 160)));
  const platformCards = () => page.evaluate(() => Array.from(document.querySelectorAll('.tb-card')).map(c => (c.innerText || '').replace(/\n+/g, ' | ').slice(0, 160)));

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  const before = await snap();
  const knownIds = new Set(before.agents.map(a => a.sessionId));

  // create a fresh session in 日常问答 workspace
  await page.getByRole('button', { name: '新会话', exact: true }).first().click().catch(async () => { await page.getByRole('button', { name: '新建会话', exact: true }).first().click(); });
  await page.waitForTimeout(2000);
  const wsBtn = page.getByRole('button', { name: '选择工作区', exact: true }).first();
  if (await wsBtn.count()) {
    await wsBtn.click(); await page.waitForTimeout(1000);
    const item = page.locator('[role=menuitem]').filter({ hasText: '日常问答' }).first();
    if (await item.count()) await item.click();
    await page.waitForTimeout(900);
  }
  const editor = page.locator('[contenteditable="true"][aria-label*="文件或对话"]').first();
  await editor.click();
  await page.keyboard.type('LEGACY 修复自检：只回复 ok，不要使用工具。', { delay: 8 });
  await page.getByRole('button', { name: '发送消息', exact: true }).first().click();
  console.log('new session message sent');
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const stop = await page.getByRole('button', { name: /停止|stop/i }).count();
    const txt = await page.evaluate(() => document.body.innerText);
    if (stop === 0 && /\bok\b/i.test(txt)) { data.turnDone = true; break; }
  }
  const after = await snap();
  const newAgents = after.agents.filter(a => !knownIds.has(a.sessionId));
  data.sessionId = newAgents.length ? newAgents[newAgents.length - 1].sessionId : null;
  data.newAgents = newAgents.map(a => ({ sid: a.sessionId, cwd: a.cwd }));
  console.log('SESSION ID:', data.sessionId, 'new=', JSON.stringify(data.newAgents));
  if (!data.sessionId) throw new Error('cannot determine current session id');

  // open right board
  data.headBtn = await page.locator('.tb-headbtn').count();
  if (data.headBtn) { await page.locator('.tb-headbtn').first().click(); await page.waitForTimeout(2500); }

  // pause polling
  await rpc('set-config', { pollEnabled: false });
  console.log('POLL PAUSED');

  // A: no cwd + fake session -> rebind sessionId to current; B: no cwd + fake session
  const a1 = await rpc('add-task', { title: tA, sessionId: FAKE });
  await rpc('update-task', { id: a1.task.id, sessionId: data.sessionId });
  const b1 = await rpc('add-task', { title: tB, sessionId: FAKE });
  data.taskA = taskByTitle(readBoard(), tA);
  data.taskB = taskByTitle(readBoard(), tB);
  console.log('TASK A:', JSON.stringify(data.taskA), 'TASK B:', JSON.stringify(data.taskB));

  await page.locator('.tb-page').getByRole('button', { name: '刷新', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(2200);
  data.rightText1 = await rightText();
  data.rightCards1 = await rightCards();
  data.hint1 = (data.rightText1 || '').match(/另有 [^|]*/)?.[0] || (data.rightText1 || '').match(/另有[^|]*/)?.[0] || 'none';
  await page.screenshot({ path: OUT + '/shots/fix-01-right-show.png' });
  console.log('RIGHT1:', JSON.stringify(data.rightCards1));
  console.log('HINT1:', data.hint1);

  // C/D via platform board
  await page.getByRole('button', { name: '平台任务看板', exact: true }).first().click();
  await page.waitForTimeout(2500);
  const addPlatform = async (ws, title) => {
    await page.selectOption('select[aria-label="任务所属工作区"]', { label: ws });
    await page.waitForTimeout(300);
    await page.locator('input.tb-input').fill(title);
    await page.getByRole('button', { name: '添加到待开始', exact: true }).click();
    await page.waitForTimeout(1200);
  };
  await addPlatform('日常问答', tC);
  await addPlatform('plinto', tD);
  data.taskC = taskByTitle(readBoard(), tC);
  data.taskD = taskByTitle(readBoard(), tD);
  data.platformCards = await platformCards();
  await page.screenshot({ path: OUT + '/shots/fix-03-other-ws.png' });
  console.log('TASK C:', JSON.stringify(data.taskC), 'TASK D:', JSON.stringify(data.taskD));
  console.log('PLATFORM CARDS:', JSON.stringify(data.platformCards));

  // back to session, right board
  await page.getByRole('button', { name: '新会话', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  // switch back by clicking session row (title auto: use first session row under 日常问答 containing LEGACY 修复自检)
  const row = page.getByText(/LEGACY 修复自检|新会话/, { exact: false }).first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(3500); }
  if (await page.locator('.tb-page').count() === 0 && await page.locator('.tb-headbtn').count()) { await page.locator('.tb-headbtn').first().click(); await page.waitForTimeout(2000); }
  await page.locator('.tb-page').getByRole('button', { name: '刷新', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(2500);
  data.rightText2 = await rightText();
  data.rightCards2 = await rightCards();
  data.hint2 = (data.rightText2 || '').match(/另有 [^|]*/)?.[0] || (data.rightText2 || '').match(/另有[^|]*/)?.[0] || 'none';
  await page.screenshot({ path: OUT + '/shots/fix-02-platform-task.png' });
  console.log('RIGHT2:', JSON.stringify(data.rightCards2));
  console.log('HINT2:', data.hint2);

  // cleanup
  for (const title of [tA, tB, tC, tD]) {
    const b = readBoard();
    const t = b.tasks.find(x => x.title === title);
    if (t) { try { await rpc('delete-task', { id: t.id }); } catch (e) { console.log('delete fail', title, e.message); } }
  }
  await rpc('set-config', { pollEnabled: true });
  await page.waitForTimeout(1500);
  data.cleanupBoard = readBoard();
  data.cleanupCount = data.cleanupBoard.tasks.length;
  data.pollFinal = (await snap()).poll;
  await page.locator('.tb-page').getByRole('button', { name: '刷新', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/shots/fix-04-cleanup.png' });
  console.log('CLEANUP COUNT:', data.cleanupCount, 'poll:', JSON.stringify(data.pollFinal));

  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  data.console = { total: consoleEvents.length, errors, warnings };
  fs.writeFileSync(OUT + '/shots/fix-data.json', JSON.stringify(data, null, 1));
  fs.writeFileSync(OUT + '/shots/fix-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-120) }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  console.log('DONE');
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
