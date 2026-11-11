import { readFileSync } from 'node:fs';
const t = readFileSync(process.argv[2], 'utf8');
const blocks = t.split('\n### ');
const keep = [];
for (let b of blocks) {
  if (/^(TOOL CALL|ASSISTANT|INBOX SPLICED|SUBAGENT|USER)/.test(b)) {
    keep.push('### ' + b.slice(0, 900));
  }
}
console.log(keep.join('\n\n----\n\n'));
