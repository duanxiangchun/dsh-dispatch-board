import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const out = process.argv[3];
const buf = readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let offsets = [];
let idx = buf.indexOf(MAGIC, 0);
while (idx !== -1 && idx < buf.length) { offsets.push(idx); idx = buf.indexOf(MAGIC, idx + 4); }
const parts = [];
let fail = 0;
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i];
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
  try {
    const chunk = zlib.zstdDecompressSync(buf.subarray(start, end));
    if (chunk.length) parts.push(chunk);
  } catch (e) { fail++; }
}
const text = Buffer.concat(parts).toString('utf8');
writeFileSync(out, text);
const lines = text.split('\n').filter(Boolean);
console.log('frames=' + offsets.length + ' failures=' + fail + ' lines=' + lines.length + ' bytes=' + text.length + ' -> ' + out);
