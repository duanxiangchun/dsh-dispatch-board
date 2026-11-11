const { chromium } = require('playwright');
const TARGET = process.env.TARGET_URL;
const OUT = process.env.OUT_DIR;
const TITLE = 'E2E 冒烟：在 .dev/e2e/hello.txt 写入一行 hello';
const NOTE = '验收标准：创建文件 C:\\Users\\duan\\Code\\dsh-taskboard\\.dev\\e2e\\hello.txt，内容恰好一行 hello（无多余空行）。回报时给出文件绝对路径与文件内容，主 Agent 审核通过后把任务置为已完成并在 result 写一句可核验结论。';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(6000);
  const cont = page.getByRole('button', { name: '继续', exact: true });
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }); } catch(e){} }
  await page.getByRole('button', { name: '任务看板', exact: true }).first().click();
  await page.waitForTimeout(2500);

  // 1. click 加备注
  await page.locator('button.tb-linkbtn').click();
  await page.waitForTimeout(500);
  // 2. fill title
  await page.locator('input.tb-input').fill(TITLE);
  // 3. fill note
  await page.locator('textarea.tb-textarea').fill(NOTE);
  await page.screenshot({ path: OUT + '/shots/step3a-composer-filled.png' });
  console.log('filled composer');
  // 4. submit
  await page.getByRole('button', { name: '添加到待开始' }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + '/shots/step3b-task-added.png' });
  // dump columns
  const state = await page.evaluate(() => {
    const cols = Array.from(document.querySelectorAll('[class*="tb-col"]')).map(c => ({ text: c.innerText.slice(0, 500) }));
    return { cols, bodyHas: document.body.innerText.includes('E2E 冒烟') };
  });
  console.log(JSON.stringify(state, null, 1).slice(0, 5000));
  // 5. target select options
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('select.tb-select option')).map(o => ({ v: o.value, t: o.textContent })));
  console.log('TARGET OPTIONS:', JSON.stringify(opts));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
