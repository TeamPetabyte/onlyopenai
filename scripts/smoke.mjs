// smoke.mjs — เส้นทางเงินบน server ที่รันอยู่: login → chat 1 คำถาม → เครดิต project ถูกตัดเท่า cost
// ใช้: $env:SMOKE_USER='...'; $env:SMOKE_PASS='...'; npm run smoke  (SMOKE_URL เปลี่ยน server ได้ ค่าเริ่มต้น :3001)

const URL_BASE = process.env.SMOKE_URL || 'http://localhost:3001';
const USER = process.env.SMOKE_USER, PASS = process.env.SMOKE_PASS;

function die(msg) { console.error(`SMOKE FAIL — ${msg}`); process.exit(1); }
const step = (msg) => console.log(`[smoke] ${msg}`);

if (!USER || !PASS) die('ต้องตั้ง SMOKE_USER และ SMOKE_PASS (user ที่ chat ได้จริง ไม่ติด mustChangePassword)');

async function http(path, opts = {}, timeoutMs = 15000) {
    return fetch(URL_BASE + path, { ...opts, signal: AbortSignal.timeout(timeoutMs) })
        .catch((e) => die(`${path}: ${e.cause?.code || e.message} — server รันอยู่ที่ ${URL_BASE} ไหม?`));
}

step('health');
const health = await http('/api/health');
if (!health.ok) die(`health ${health.status}`);

step(`login: ${USER}`);
const loginRes = await http('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
});
const login = await loginRes.json().catch(() => null);
if (loginRes.status === 423) die(`ล็อกอินไม่ผ่าน (423): ${JSON.stringify(login)} — บัญชีล็อกหรือต้องเปลี่ยนรหัสก่อน`);
if (!loginRes.ok || !login?.ok) die(`login ${loginRes.status}: ${JSON.stringify(login)}`);
if (login.mustChangePassword) die('user นี้ติด mustChangePassword — เปลี่ยนรหัสก่อนถึงจะ chat ได้');
// cookie petabyte_session เป็นทางเดียวที่ server รับ auth; POST อื่นต้องมี x-csrf-token คู่กัน
const setCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')].filter(Boolean);
const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
if (!cookie.includes('petabyte_session=')) die('login สำเร็จแต่ไม่ได้ cookie petabyte_session');
const auth = { cookie, 'x-csrf-token': login.csrfToken };

// เงินจริงอยู่ที่ project_credits (Concept B) — ไม่ใช่ balance ราย user
async function projectBalance() {
    const r = await http('/api/projects', { headers: auth });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) die(`GET /api/projects ${r.status}: ${JSON.stringify(j)}`);
    const p = j.projects.find((x) => x.id === login.user.projectId) || j.projects[0];
    if (!p) die('user ไม่มี project ให้เช็คยอด');
    return Number(p.balance);
}
const before = await projectBalance();
step(`project balance ก่อน chat = ${before}`);
if (!(before > 0)) die('project_credits ไม่เป็นบวก — เติมเครดิต project ก่อน ไม่งั้น chat โดน 402');

step('chat 1 คำถาม');
const chatRes = await http('/api/chat', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'ตอบสั้นที่สุด: 2+2 เท่ากับเท่าไร' }),
}, 120000);
if ((chatRes.headers.get('content-type') || '').includes('application/json')) {
    const j = await chatRes.json().catch(() => null);
    if (j?.useMock) die('server อยู่ใน MOCK mode (ไม่มี API key) — เส้นทางเงินไม่ถูกทดสอบ');
    die(`chat ${chatRes.status}: ${JSON.stringify(j)}`);
}
let done = null, text = '', buf = '';
const decoder = new TextDecoder();
for await (const chunk of chatRes.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'chunk') text += ev.text;
        else if (ev.type === 'error') die(`chat stream error: ${ev.error}`);
        else if (ev.type === 'use_mock') die('server ตอบ mock — เส้นทางเงินไม่ถูกทดสอบ');
        else if (ev.type === 'done') done = ev;
    }
    if (done) break;
}
if (!done) die('stream จบโดยไม่มี done frame');
const skillName = done.detectedSkill && (done.detectedSkill.id || done.detectedSkill.name || done.detectedSkill);
step(`ได้คำตอบ ${text.length} ตัวอักษร, cost = ${done.cost}, skill = ${typeof skillName === 'string' ? skillName : '-'}`);
if (!(done.cost > 0)) die(`cost ไม่เป็นบวก: ${done.cost}`);

// การตัดเครดิต commit ก่อน done frame — อ่านยอดตอนนี้เชื่อถือได้
const after = await projectBalance();
const drop = before - after;
step(`project balance หลัง chat = ${after} (ลดลง ${drop.toFixed(6)})`);
if (Math.abs(drop - done.cost) > 0.01) die(`ยอดลดลง ${drop} แต่ cost ที่รายงาน = ${done.cost}`);

console.log(`SMOKE PASS — login → chat → เครดิตถูกตัด ${done.cost} ตรงตาม cost`);
