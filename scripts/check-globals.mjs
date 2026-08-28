// check-globals.mjs — สัญญา global ของหน้าเว็บ: ทุก handler ที่ HTML เรียก
// (ทั้งใน .html และใน HTML ที่ JS สร้างเป็นสตริง) ต้องถูกวางบน window
// โดยไฟล์ใน chain ของหน้านั้น ไม่งั้นหลัง Vite แปลงเป็น module มันจะเงียบหาย
import { readFileSync } from 'fs';

const PAGES = {
    'index.html': ['js/i18n.js', 'js/md.js', 'js/config.js', 'js/auth.js',
        'js/pricing.js', 'js/mock-ai.js', 'js/ai-client.js', 'js/chat.js'],
    'admin.html': ['js/i18n.js', 'js/config.js', 'js/auth.js', 'js/pricing.js', 'js/admin.js'],
    'login.html': ['js/config.js', 'js/auth.js', 'js/login.js'],
    'change-password.html': ['js/config.js', 'js/auth.js', 'js/change-password.js'],
};
// ชื่อที่ browser มีให้เอง หรือมาจาก classic <script> (vendor)
const BUILTIN = new Set(['document', 'event', 'this', 'if', 'window', 'location',
    'localStorage', 'marked', 'DOMPurify', 'hljs']);

const HANDLER_RE = /\son[a-z]+="([A-Za-z_$][A-Za-z0-9_$.]*)\s*\(/g;

function handlersIn(text) {
    const out = new Set();
    for (const m of text.matchAll(HANDLER_RE)) out.add(m[1].split('.')[0]);
    return out;
}
function windowNamesIn(src) {
    const out = new Set();
    for (const m of src.matchAll(/window\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) out.add(m[1]);
    for (const m of src.matchAll(/Object\.assign\(window,\s*\{([^}]+)\}/g)) {
        for (const n of m[1].split(',')) {
            const t = n.trim().split(':')[0].trim();
            if (t) out.add(t);
        }
    }
    // global.X = ... (สไตล์ i18n.js — พารามิเตอร์ IIFE คือ window)
    for (const m of src.matchAll(/global\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) out.add(m[1]);
    return out;
}

let fail = 0;
for (const [page, chain] of Object.entries(PAGES)) {
    const html = readFileSync(page, 'utf8');
    const sources = chain.map((f) => readFileSync(f, 'utf8'));
    const provided = new Set();
    for (const s of sources) for (const n of windowNamesIn(s)) provided.add(n);
    // inline <script> ในหน้า (theme bootstrap ฯลฯ) ก็ประกาศ function ได้
    for (const m of html.matchAll(/function ([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) provided.add(m[1]);

    const needed = handlersIn(html);
    for (const s of sources) for (const n of handlersIn(s)) needed.add(n);

    for (const n of needed) {
        if (BUILTIN.has(n) || provided.has(n)) continue;
        console.error(`MISSING  ${page}: handler "${n}" ไม่ได้ถูกวางบน window โดยไฟล์ใน chain`);
        fail++;
    }
}
if (fail) {
    console.error(`\n${fail} handler(s) would break at runtime`);
    process.exit(1);
}
console.log('global contract OK — ทุก handler มีเจ้าของบน window');
