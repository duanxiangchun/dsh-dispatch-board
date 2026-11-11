const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  page.on('dialog', d => { console.log('[dialog]', d.message()); d.accept().catch(()=>{}); });
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch(e){} }

  // ---- delete t-3 if present (keep board clean for the dispatch-mode test)
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(2500);
  const card = page.locator('.tb-card').filter({ hasText: 't-3' }).first();
  if (await card.count()) {
    const del = card.getByRole('button', { name: '删除' });
    if (await del.count()) { await del.click(); await page.waitForTimeout(2000); console.log('t-3 deleted via UI'); }
  } else { console.log('t-3 card not found'); }
  await page.screenshot({ path: OUT + '/shots/step4a-after-delete.png' });

  // ---- new session with 派单看板模式
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.locator('button[title="选择新任务使用的 Agent 预设"]').first().click();
  await page.waitForTimeout(1200);
  const items = page.locator('[role=menuitem]').filter({ hasText: '派单看板模式' });
  console.log('menuitem matches:', await items.count());
  await items.first().click();
  await page.waitForTimeout(1500);
  const modeText = await page.locator('button[title="选择新任务使用的 Agent 预设"]').first().innerText();
  console.log('selected mode now:', modeText);
  await page.screenshot({ path: OUT + '/shots/step4c-mode-selected.png' });

  // ---- send first message to materialize the session with this preset
  const editor = page.locator('[contenteditable="true"][aria-label^="描述你想要构建的内容"]').first();
  await editor.click();
  await page.keyboard.type('自检：请只回复一句「派单模式已就绪」。不要执行任何任务，不要使用工具。', { delay: 10 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/shots/step4d-message-typed.png' });
  await page.getByRole('button', { name: '发送消息', exact: true }).first().click();
  console.log('message sent at', new Date().toISOString());

  // ---- wait for turn to finish (up to 240s), screenshot every 30s
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < 240000) {
    await sleep(30000); i++;
    const stop = await page.getByRole('button', { name: /停止|stop/i }).count();
    const body = await page.evaluate(() => document.body.innerText);
    const hasReady = body.includes('就绪');
    await page.screenshot({ path: OUT + '/shots/step4-wait-' + String(i).padStart(2,'0') + '.png' });
    console.log('t+' + (i*30) + 's stopBtn=' + stop + ' hasText=' + hasReady);
    if (stop === 0 && hasReady) break;
  }
  await page.screenshot({ path: OUT + '/shots/step4e-turn-done.png' });
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 2500));
  console.log('=== FINAL BODY TEXT ===');
  console.log(txt);
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
