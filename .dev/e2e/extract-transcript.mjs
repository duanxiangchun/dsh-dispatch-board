import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
const outFile = process.argv[3];
const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const out = [];
function txt(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map(c => {
    if (typeof c === 'string') return c;
    if (c && c.type === 'text') return c.text;
    if (c && c.type === 'tool-call') return '[tool-call ' + (c.name || c.toolName) + '] ' + JSON.stringify(c.input || c.arguments || {}).slice(0, 300);
    if (c && c.type === 'tool-result') return '[tool-result] ' + JSON.stringify(c.output || c.result || '').slice(0, 300);
    return JSON.stringify(c).slice(0, 300);
  }).join('\n');
}
for (const e of recs) {
  const d = e.data || {};
  if (e.type === 'user/message') {
    const source = d.source ? JSON.stringify(d.source) : '';
    out.push('\n### USER(' + source + ')\n' + txt(d.content || d.message || d).slice(0, 3000));
  } else if (e.type === 'assistant/message') {
    out.push('\n### ASSISTANT\n' + txt(d.content || d.message || d).slice(0, 3000));
  } else if (e.type === 'tool/call') {
    out.push('\n### TOOL CALL ' + (d.name || '?') + '\n' + JSON.stringify(d.input || d.arguments || {}).slice(0, 1200));
  } else if (e.type === 'tool/result') {
    out.push('\n### TOOL RESULT ' + (d.name || '') + '\n' + JSON.stringify(d.result || d.output || d).slice(0, 1000));
  } else if (e.type === 'agent/inbox/spliced') {
    out.push('\n### INBOX SPLICED\n' + JSON.stringify(d).slice(0, 1200));
  } else if (e.type === 'turn/start' || e.type === 'turn/end') {
    out.push('\n--- ' + e.type + ' ---');
  } else if (e.type === 'subagent/catalog') {
    out.push('\n### SUBAGENT CATALOG\n' + JSON.stringify(d).slice(0, 800));
  }
}
writeFileSync(outFile, out.join('\n'));
console.log('wrote', outFile, 'chars', out.join('\n').length);
const joined = out.join('\n');
const hit = joined.indexOf('【任务看板');
console.log('dispatch message found at', hit, hit >= 0 ? joined.slice(hit, hit + 400) : '');
