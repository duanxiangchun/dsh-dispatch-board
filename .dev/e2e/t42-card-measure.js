// t-42: measure card geometry at a given viewport width (default pass 1600 wide → 2x2 board / narrow lanes at small widths).
const { chromium } = require('playwright')
const fs = require('fs')
const TARGET = process.env.TARGET_URL
const OUT = process.env.OUT_DIR || 'C:/Users/duan/Code/dsh-taskboard/.dev/e2e'
const W = Number(process.env.VIEWPORT_W || 1600)
const H = Number(process.env.VIEWPORT_H || 1000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const logs = []
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') logs.push('console.error: ' + m.text().slice(0, 300)) })
  page.on('pageerror', (e) => logs.push('pageerror: ' + (e.message || String(e)).slice(0, 300)))
  fs.mkdirSync(OUT + '/shots', { recursive: true })

  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const cont = page.getByRole('button', { name: '继续', exact: true })
  if (await cont.count()) { try { await cont.first().click({ timeout: 3000 }) } catch {} }
  await page.waitForSelector('button[aria-label="搜索会话"]', { timeout: 30000 }).catch(() => {})
  await sleep(1500)

  let head = 0
  for (let attempt = 0; attempt < 3 && head === 0; attempt += 1) {
    const row = page.getByText('看板派发任务未新增', { exact: true }).first()
    if (await row.count()) {
      try { await row.click({ timeout: 8000 }) } catch (e) { console.log('row click attempt ' + attempt + ' failed: ' + e.message.split('\n')[0]) }
    }
    for (let i = 0; i < 8; i += 1) {
      head = await page.locator('.tb-headbtn').count()
      if (head > 0) break
      await sleep(1000)
    }
  }
  if (head === 0) throw new Error('no .tb-headbtn')
  await page.evaluate(() => document.querySelector('.tb-headbtn').click())
  await page.waitForSelector('.tb-page', { timeout: 20000 })
  await page.waitForFunction(() => document.querySelectorAll('.tb-card-fixed').length > 0, null, { timeout: 20000 })
  await sleep(4000)
  if (W !== 1600 || H !== 1000) { await page.setViewportSize({ width: W, height: H }); await sleep(3500) }

  const cssRules = await page.evaluate(() => {
    const found = []
    for (const tag of document.querySelectorAll('style[data-plugin-css]')) {
      const text = tag.textContent || ''
      if (!text.includes('.tb-card-fixed')) continue
      for (const line of text.split('\n')) {
        if (line.includes('tb-card-fixed') || /\.tb-card-actions\{[^}]*margin-top/.test(line)) found.push(line.trim())
      }
    }
    return found
  })

  const data = await page.evaluate(() => {
    const round = (n) => Math.round(n * 10) / 10
    const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, width: r.width } }
    const textLineBoxes = (el) => {
      const node = el.firstChild
      if (!node) return 0
      const range = document.createRange()
      range.selectNodeContents(el)
      return range.getClientRects().length
    }
    const cols = []
    for (const col of document.querySelectorAll('.tb-lanes .tb-col, .tb-board .tb-col')) {
      const name = ((col.querySelector('.tb-colname') || {}).textContent || '').trim()
      const cards = []
      for (const card of col.querySelectorAll('.tb-card-fixed')) {
        const title = card.querySelector('.tb-card-title')
        const actions = card.querySelector('.tb-card-actions')
        const tcs = getComputedStyle(title)
        const acs = getComputedStyle(actions)
        const ccs = getComputedStyle(card)
        const tr = rect(title)
        const ar = rect(actions)
        const cr = rect(card)
        const btns = Array.from(actions.querySelectorAll('button'))
        const rows = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size
        cards.push({
          text: (title.textContent || '').slice(0, 22),
          textLines: textLineBoxes(title),
          cardH: round(cr.height),
          cardMinH: ccs.minHeight,
          titleH: round(tr.height),
          titleMinH: tcs.minHeight,
          lineHeight: tcs.lineHeight,
          actionsH: round(ar.height),
          actionsMarginTop: acs.marginTop,
          actionsPaddingTop: acs.paddingTop,
          gapTitleToActions: round(ar.top - tr.bottom),
          lastTextLineToActions: round(ar.top - (tr.top + (textLineBoxes(title) * parseFloat(tcs.lineHeight)))),
          gapActionsToCardBottom: round(cr.bottom - ar.bottom),
          cardGap: ccs.gap,
          buttonRows: rows,
          buttonCount: btns.length,
        })
      }
      cols.push({ name, cardCount: cards.length, cards })
    }
    const p = document.querySelector('.tb-page')
    return {
      layout: p ? p.getAttribute('data-layout') : null,
      narrow: p ? p.getAttribute('data-narrow') : null,
      pageWidth: p ? Math.round(p.getBoundingClientRect().width) : null,
      colCount: cols.length,
      cols,
    }
  })

  console.log('viewport', W + 'x' + H, 'layout=' + data.layout, 'narrow=' + data.narrow, 'cols=' + data.colCount, 'pageWidth=' + data.pageWidth)
  console.log('LIVE CSS:', JSON.stringify(cssRules, null, 2))
  console.log('LOG errors:', JSON.stringify(logs))
  for (const col of data.cols) {
    console.log(`[${col.name}] cards=${col.cardCount}`)
    for (const c of col.cards) {
      console.log(
        `  "${c.text}" textLines=${c.textLines} cardH=${c.cardH} titleH=${c.titleH} titleMinH=${c.titleMinH} ` +
          `actionsH=${c.actionsH} marginTop=${c.actionsMarginTop} gapBlock(title→btn)=${c.gapTitleToActions} ` +
          `gapLastLine(text→btn)=${c.lastTextLineToActions} btnRows=${c.buttonRows} btnCount=${c.buttonCount} cardMinH=${c.cardMinH}`,
      )
    }
    const hs = col.cards.map((c) => c.cardH)
    console.log(`  heights=[${hs.join(', ')}] distinct=${JSON.stringify([...new Set(hs)])} btnRows=${JSON.stringify([...new Set(col.cards.map((c) => c.buttonRows))])} textLines=${JSON.stringify([...new Set(col.cards.map((c) => c.textLines))])}`)
  }
  const gaps = data.cols.flatMap((c) => c.cards.map((x) => x.gapTitleToActions))
  console.log('GAPS(title block → actions): ' + JSON.stringify(gaps))
  fs.writeFileSync(`${OUT}/t42-measure-${W}.json`, JSON.stringify({ url: TARGET, viewport: W + 'x' + H, cssRules, data }, null, 2))

  await page.screenshot({ path: `${OUT}/shots/t42-page-${W}.png` })
  const pane = await page.$('.tb-page')
  if (pane) await pane.screenshot({ path: `${OUT}/shots/t42-cards-page-${W}.png` })
  const doing = page.locator('.tb-col', { has: page.locator('.tb-colname', { hasText: '进行中' }) }).first()
  if (await doing.count()) await doing.screenshot({ path: `${OUT}/shots/t42-doing-column-${W}.png` })
  const archived = page.locator('.tb-col', { has: page.locator('.tb-colname', { hasText: '已归档' }) }).first()
  if (await archived.count()) await archived.screenshot({ path: `${OUT}/shots/t42-archived-column-${W}.png` })
  console.log('shots →', OUT + '/shots')
  await browser.close()
})().catch((e) => { console.error('FAILED', (e && e.stack) || e); process.exit(1) })

