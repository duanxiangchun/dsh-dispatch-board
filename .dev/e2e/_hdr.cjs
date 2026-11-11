const fs=require('fs'), z=require('zlib');
const p=process.argv[2];
const buf=fs.readFileSync(p);
let out;
try { out = z.zstdDecompressSync(buf).toString('utf8'); } catch(e) { console.log('ERR', e.message); process.exit(1); }
const lines = out.split('\n');
console.log('lines', lines.length, 'chars', out.length);
console.log(lines[0].slice(0,1500));
