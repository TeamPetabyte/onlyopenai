// check-globals.mjs — สัญญา global ของหน้าเว็บ: ทุก handler ที่ HTML เรียก
// (ทั้งใน .html และใน HTML ที่ JS สร้างเป็นสตริง) ต้องถูกวางบน window
// โดยไฟล์ใน chain ของหน้านั้น ไม่งั้นหลัง Vite แปลงเป็น module มันจะเงียบหาย
import { readFileSync } from 'fs';

const PAGES = {
    'index.html': ['js/i18n.js', 'js/md.js', 'js/config.js', 'js/auth.js',
        'js/pricing.js', 'js/mock-ai.js', 'js/ai-client.js', 'js/chat.js'],
    'admin.html': ['js/i18n.js', 'js/config.js', 'js/auth.js', 'js/pricing.js', 'js/admin.js',
        'js/admin/helpers.js', 'js/admin/core.js', 'js/admin/overview.js', 'js/admin/sync.js',
        'js/admin/skills-lab.js', 'js/admin/credits.js', 'js/admin/users.js',
        'js/admin/projects.js', 'js/admin/activity.js', 'js/admin/usage.js'],
    'login.html': ['js/config.js', 'js/auth.js', 'js/login.js'],
    'change-password.html': ['js/config.js', 'js/auth.js', 'js/change-password.js'],
};
// ชื่อที่ browser มีให้เอง หรือมาจาก classic <script> (vendor)
const BUILTIN = new Set(['document', 'event', 'this', 'if', 'window', 'location', 'navigator',
    'localStorage', 'marked', 'DOMPurify', 'hljs']);

// ค่าของ on*="..." ทั้งก้อน — ใน .js มันอยู่ในสตริง '...'/`...` ที่ต่อกันด้วย + จึงต้องเดินข้าม \'
// ช่วง expression ระหว่าง literal และ ${…} (แทนด้วย \0) ไปจนถึง " ที่ปิด attribute
function handlerValues(text, isJs) {
    const out = [];
    for (const m of text.matchAll(/\son[a-z]+="/g)) {
        let i = m.index + m[0].length, val = '', inLit = true;
        while (i < text.length) {
            const c = text[i];
            if (!inLit) { if (c === "'" || c === '`') { inLit = true; val += '\0'; } i++; continue; }
            if (c === '\\' && isJs) { val += text[i + 1]; i += 2; continue; }
            if (c === '$' && text[i + 1] === '{' && isJs) { const end = text.indexOf('}', i); val += '\0'; i = end === -1 ? text.length : end + 1; continue; }
            if (c === '"') break;
            if ((c === "'" || c === '`') && isJs) { inLit = false; i++; continue; }
            val += c; i++;
        }
        out.push(val);
    }
    return out;
}
// ทุก call ในค่านั้น เอาเฉพาะชื่อต้นของ chain (admin.x() → admin, ()=>flash() → flash)
// ชื่อในสตริงย่อย ('rgba(...)', 'var(--x)') ไม่นับ
function handlersIn(text, isJs) {
    const out = new Set();
    for (const v of handlerValues(text, isJs)) {
        const code = v.replace(/'[^']*'/g, "''");
        for (const m of code.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*\s*\(/g)) out.add(m[2]);
    }
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

    const needed = handlersIn(html, false);
    for (const s of sources) for (const n of handlersIn(s, true)) needed.add(n);

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
