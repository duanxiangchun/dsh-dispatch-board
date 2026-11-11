const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'rg-' + Math.random().toString(36).slice(2);
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }) });
  const j = await r.json();
  return j.result;
}
async function snap() { const res = await rpc('snapshot'); return res.value; }
(async () => {
  const consoleEvents = [];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', m => consoleEvents.push({ type: m.type(), text: m.text().slice(0, 500) }));
  page.on('pageerror', e => consoleEvents.push({ type: 'pageerror', text: (e.message || String(e)).slice(0, 500) }));
  page.on('dialog', d => d.accept().catch(() => {}));

  const log = [];
  const badgeText = async () => page.evaluate(() => {
    const b = document.querySelector('[aria-label="任务看板"] .tb-badge');
    return b ? (b.textContent || '').trim() : null;
  });
  const boardText = async () => page.evaluate(() => document.body.innerText);
  const headerLine = txt => (txt.split('\n').find(l => l.includes('上次派发')) || '').trim();
  const pauseBtn = () => page.getByRole('button', { name: '暂停轮询', exact: true });

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }

  // board page
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '/shots/regress-board.png' });
  const layout = await page.evaluate(() => {
    const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
    return { vh: window.innerHeight, scrollH: document.documentElement.scrollHeight, board: r(document.querySelector('.tb-board')), cols: Array.from(document.querySelectorAll('.tb-col')).map(c => ({ s: c.getAttribute('data-status'), ...r(c) })) };
  });
  console.log('LAYOUT:', JSON.stringify(layout));
  log.push({ step: 'board-layout', layout });

  // pause polling for badge test
  await pauseBtn().click();
  await page.waitForTimeout(1200);
  const paused = (await boardText()).includes('恢复轮询');
  console.log('POLL PAUSED:', paused);
  log.push({ step: 'pause-poll', paused });

  // badge appears
  const before = await badgeText();
  await page.locator('input.tb-input').fill('回归角标测试任务');
  await page.getByRole('button', { name: '添加到待开始' }).click();
  let appeared = null;
  for (let i = 0; i < 10; i++) { await sleep(1000); appeared = await badgeText(); if (appeared) break; }
  console.log('BADGE after create:', appeared, '(before:', before + ')');
  await page.screenshot({ path: OUT + '/shots/regress-badge.png' });
  // delete it
  const card = page.locator('.tb-card').filter({ hasText: '回归角标测试任务' }).first();
  await card.getByRole('button', { name: '删除' }).click();
  await page.waitForTimeout(1500);
  let gone = null;
  for (let i = 0; i < 12; i++) { gone = await badgeText(); if (!gone) break; await sleep(1000); }
  console.log('BADGE after delete:', gone);
  await page.screenshot({ path: OUT + '/shots/regress-badge-after.png' });
  log.push({ step: 'badge', before, appeared, gone });

  // ---- new dispatch session to test dropdown labels ----
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.locator('button[title="选择新任务使用的 Agent 预设"]').first().click();
  await page.waitForTimeout(1000);
  await page.locator('[role=menuitem]').filter({ hasText: '派单看板模式' }).first().click();
  await page.waitForTimeout(800);
  const editor = page.locator('[contenteditable="true"][aria-label^="描述你想要构建的内容"]').first();
  await editor.click();
  await page.keyboard.type('回归自检：只回复「就绪」两个字，不要用工具。', { delay: 5 });
  await page.getByRole('button', { name: '发送消息', exact: true }).first().click();
  console.log('new dispatch session message sent at', new Date().toISOString());
  let turnDone = false;
  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const stop = await page.getByRole('button', { name: /停止|stop/i }).count();
    const txt = await boardText();
    if (stop === 0 && txt.includes('就绪')) { turnDone = true; break; }
  }
  console.log('new session turn done:', turnDone);
  const agentsAfterNew = (await snap()).agents;
  // session title from sidebar: grab new session row (the one with newest) hard; just log agents
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(2500);
  const opts = await page.evaluate(() => {
    const sel = document.querySelector('select.tb-select[aria-label="派发给"]');
    return sel ? Array.from(sel.options).map(o => ({ value: o.value, text: o.textContent })) : null;
  });
  console.log('AGENTS:', JSON.stringify(agentsAfterNew));
  console.log('TARGET OPTIONS:', JSON.stringify(opts));
  log.push({ step: 'target-options', agents: agentsAfterNew, opts });
  await page.screenshot({ path: OUT + '/shots/regress-target-select.png' });

  // resume polling
  await page.getByRole('button', { name: '恢复轮询', exact: true }).click();
  await page.waitForTimeout(1200);
  console.log('POLL RESUMED:', (await boardText()).includes('暂停轮询'));
  log.push({ step: 'resume-poll' });

  // ---- header label after a dispatch ----
  await page.locator('input.tb-input').fill('回归：头部派发对象标签检查');
  await page.locator('button.tb-linkbtn').click();
  await page.locator('textarea.tb-textarea').fill('仅回归检查，不要改动任何文件；收到后把任务置为 done 并在 result 写 ok。');
  await page.getByRole('button', { name: '添加到待开始' }).click();
  console.log('dispatch test task created');
  let dispatched = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const s = await snap();
    if (s.poll.lastDispatchAt) { dispatched = s.poll; break; }
  }
  console.log('DISPATCH:', JSON.stringify(dispatched));
  await page.waitForTimeout(1000);
  const txtAfter = await boardText();
  console.log('HEADER LINE AFTER DISPATCH:', headerLine(txtAfter));
  await page.screenshot({ path: OUT + '/shots/regress-board-header.png' });

  // wait task done up to 4 min
  let status = '';
  for (let i = 0; i < 48; i++) {
    await sleep(5000);
    const s = await snap();
    const t = s.tasks.find(x => x.title === '回归：头部派发对象标签检查');
    status = t ? t.status + (t.result ? '|result' : '') : 'missing';
    if (t && t.status === 'done') break;
  }
  console.log('DISPATCH TASK FINAL STATUS:', status);
  await page.screenshot({ path: OUT + '/shots/regress-board-final.png' });

  const errors = consoleEvents.filter(e => e.type === 'error' || e.type === 'pageerror');
  const warnings = consoleEvents.filter(e => e.type === 'warning');
  fs.writeFileSync(OUT + '/shots/regress-console.json', JSON.stringify({ total: consoleEvents.length, errors, warnings, all: consoleEvents.slice(-100) }, null, 1));
  fs.writeFileSync(OUT + '/shots/regress-data.json', JSON.stringify({ layout, log, consoleErrors: errors, warnings, turnDone, dispatched, status }, null, 1));
  console.log('CONSOLE total=' + consoleEvents.length + ' errors=' + errors.length + ' warnings=' + warnings.length);
  if (errors.length) console.log('ERRORS:', JSON.stringify(errors.slice(0, 10)));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
