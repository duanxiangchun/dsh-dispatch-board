import { readFileSync } from 'node:fs';
const file = process.argv[2];
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const counts = {};
for (const e of recs) { const k = (e.type || '?') + ':' + (e.role || ''); counts[k] = (counts[k] || 0) + 1; }
console.log('records', recs.length);
console.log(JSON.stringify(counts, null, 1));
console.log('=== first 3 records (truncated) ===');
for (const e of recs.slice(0, 3)) console.log(JSON.stringify(e).slice(0, 600));
console.log('=== keys per type ===');
const seen = new Set();
for (const e of recs) { const k = (e.type || '?') + ':' + (e.role || ''); if (!seen.has(k)) { seen.add(k); console.log(k, '->', Object.keys(e).join(',')); } }
