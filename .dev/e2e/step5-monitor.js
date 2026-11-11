const { chromium } = require('playwright');
const fs = require('fs');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const BASE = 'http://127.0.0.1:3099';
const TASK_ID = 't-3';
const SESSION_ID = 'session-0a81f6b1-4214-4730-b5d6-563b74ba36fd';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, payload = {}) {
  const id = 'e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const r = await fetch(BASE + '/taskboard/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }) });
  const j = await r.json();
  return j.result;
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch (e) {} }
  await page.getByText('派单模式自检', { exact: true }).first().click();
  await page.waitForTimeout(3500);
  const head = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  if (!head.includes('派单看板模式')) { console.log('!! opened session is not dispatch mode'); }
  fs.writeFileSync(OUT + '/shots/step5-00-session-open.txt', head);
  await page.screenshot({ path: OUT + '/shots/step5-00-session-open.png' });
  console.log('session page opened, dispatch mode visible:', head.includes('派单看板模式'));

  const before = await rpc('snapshot');
  console.log('AGENTS BEFORE:', JSON.stringify(before.value.agents));
  const upd = await rpc('update-task', { id: TASK_ID, status: 'todo', sessionId: SESSION_ID, result: '', clearError: true });
  console.log('QUEUE TASK:', JSON.stringify(upd && upd.ok !== false ? upd.value && upd.value.task : upd));
  fs.writeFileSync(OUT + '/shots/step5-01-queued.json', JSON.stringify(upd, null, 1));

  let done = false;
  for (let i = 1; i <= 22; i++) {
    await sleep(30000);
    let snap = null, err = '';
    try { snap = await rpc('snapshot'); } catch (e) { err = String(e && e.message || e); }
    const t = snap && snap.value.tasks.find(x => x.id === TASK_ID);
    const poll = snap && snap.value.poll;
    const body = await page.evaluate(() => document.body.innerText);
    const tag = String(i).padStart(2, '0');
    fs.writeFileSync(OUT + '/shots/step5-' + tag + '-body.txt', body);
    await page.screenshot({ path: OUT + '/shots/step5-' + tag + '.png' });
    const marks = {
      dispatchMsg: body.includes('【任务看板 · 待开始】'),
      subagentTool: /subagent/.test(body),
      doing: !!t && t.status === 'doing',
      done: !!t && t.status === 'done' && !!(t.result || '').trim(),
    };
    console.log('t+' + (i * 30) + 's status=' + (t && t.status) + ' resultLen=' + ((t && t.result || '').length) + ' poll=' + JSON.stringify(poll && { at: poll.lastDispatchAt, sid: poll.lastDispatchSessionId, skip: poll.lastSkipReason }) + ' marks=' + JSON.stringify(marks) + (err ? ' ERR=' + err : ''));
    if (marks.done) { done = true; console.log('DONE-DETECTED'); break; }
  }
  const finalSnap = await rpc('snapshot');
  fs.writeFileSync(OUT + '/shots/step5-final-snapshot.json', JSON.stringify(finalSnap.value, null, 1));
  const body = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync(OUT + '/shots/step5-final-body.txt', body);
  await page.screenshot({ path: OUT + '/shots/step5-final.png' });
  console.log('FINAL TASK:', JSON.stringify(finalSnap.value.tasks.find(x => x.id === TASK_ID)));
  console.log('DONE=' + done);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
