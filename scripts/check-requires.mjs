// check-requires.mjs — ทุก require('./…') ใต้ server/ ต้อง resolve ได้ (unit test โหลดแค่ lib/ จึงไม่เห็น path ที่พังหลังย้ายไฟล์)
import { readdirSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP = new Set(['node_modules', 'logs', 'knowledge']);
function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, out); }
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

let fail = 0;
for (const file of walk(join(ROOT, 'server'))) {
    const req = createRequire(file);
    // ตัด comment ออกก่อน ไม่งั้น require ที่ถูก comment ไว้ฟ้อง BROKEN ปลอม
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g)) {
        try { req.resolve(m[2]); }
        catch (_) { console.error(`BROKEN  ${relative(ROOT, file)}: require('${m[2]}') — ไม่มีไฟล์นี้จาก ${relative(ROOT, dirname(file))}`); fail++; }
    }
}
if (fail) {
    console.error(`\n${fail} require(s) would crash the server at boot`);
    process.exit(1);
}
console.log('requires OK — ทุก require ใต้ server/ resolve ได้');
