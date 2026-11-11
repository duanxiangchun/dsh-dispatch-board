const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const info = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
      text: (b.innerText || '').trim(), type: b.type, disabled: b.disabled,
      cls: (b.className || '').toString().slice(0, 40),
      visible: !!(b.offsetParent), rect: (() => { const r = b.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
    }));
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({ action: f.action, method: f.method, id: f.id }));
    const fieldState = {
      owner: document.querySelector('#oidc-repositoryOwner')?.value,
      repo: document.querySelector('#oidc-repositoryName')?.value,
      wf: document.querySelector('#oidc-workflowName')?.value,
      allow: document.querySelector('#oidc-allow-publish')?.checked,
    };
    return { buttons, forms, fieldState };
  });
  fs.writeFileSync(process.env.OUT_DIR + '/tmp-tp-buttons.json', JSON.stringify(info, null, 1), 'utf8');
  console.log('FIELDS ' + JSON.stringify(info.fieldState));
  console.log('BUTTONS ' + JSON.stringify(info.buttons.filter(b => /connect|save|create|submit/i.test(b.text))));
  console.log('FORMS ' + JSON.stringify(info.forms));
  await browser.close();
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
