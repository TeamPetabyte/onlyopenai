/**
 * server.js — PetabyteAi Backend Server
 * OpenAI Streaming proxy + PostgreSQL database
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');    // Phase 9
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { validate, schemas } = require('./validation');  // Phase 10
const { runMigrations, migrationStatus } = require('./migrate-schema'); // Phase 11
const { logger, httpLogger, flushLogger } = require('./logger');        // Phase 11 C
const openaiAdmin           = require('./openai-admin');                // Phase 15
const cryptoStore           = require('./crypto');                       // Phase 17
const skillPrompts          = require('./skill-prompts');
// pure logic lifted out of this file. No pool, no OpenAI client —
// each of these can be exercised by a test directly.
const promptLib             = require('./lib/prompt');                  // Phase 46
const { PROMPT_COMMON_APPENDIX, applyCodePlaceholder, orgStandardsBlock } = promptLib;
const pkg                   = require('./package.json');
const app  = express();
const PORT = process.env.PORT || 3001;

// cloudflared ต่อเข้า localhost — ไม่ตั้งค่านี้ req.ip เป็น 127.0.0.1 ของทุกคน rate limit ต่อ IP จึงรวมถังเดียว
// ใช้ TRUST_PROXY=0 ปิดได้เมื่อรันแบบเปิดพอร์ตตรง
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
// IP จริงของผู้เรียก: Cloudflare ใส่ CF-Connecting-IP ให้ (client ปลอมไม่ได้เพราะ tunnel เขียนทับ)
// ส่วน X-Forwarded-For ดิบ client เติมหัวแถวเองได้ จึงห้ามใช้ตรง ๆ
app.use((req, res, next) => {
    const cf = req.headers['cf-connecting-ip'];
    req.clientIp = (typeof cf === 'string' && cf ? cf : req.ip || '').toString().slice(0, 45);
    next();
});

// cookie-parser must run BEFORE any route that reads req.cookies.
// Single line, no secret needed (we use HttpOnly+SameSite=Strict, not signed).
app.use(cookieParser());

// request log ต่อบรรทัด (redact header ลับ); /api/health ถูกข้ามกัน log ท่วม
app.use(httpLogger);

// CSP: ล็อกทุกอย่างยกเว้น 'unsafe-inline' (HTML ยังมี inline handler เป็นสิบ) + Google Fonts; HSTS เฉพาะ prod
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            defaultSrc:  ["'self'"],
            // 'unsafe-inline' still required until we refactor inline handlers
            scriptSrc:   ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc:     ["'self'", 'https://fonts.gstatic.com', 'data:'],
            imgSrc:      ["'self'", 'data:', 'https:'],
            connectSrc:  ["'self'"],
            objectSrc:   ["'none'"],
            baseUri:     ["'self'"],
            frameAncestors: ["'none'"],
            formAction:  ["'self'"],
            ...(process.env.NODE_ENV === 'production'
                ? { upgradeInsecureRequests: [] }
                : {}),
        },
    },
    crossOriginEmbedderPolicy: false,    // would block external font/CSS CDNs
    // hsts is only applied when NODE_ENV=production AND the request was https.
    // In dev (http://localhost) helmet skips it automatically — no breakage.
    hsts: (process.env.NODE_ENV === 'production') ? {
        maxAge: 60 * 60 * 24 * 365,      // 1 year
        includeSubDomains: true,
        preload: true,
    } : false,
}));

// ── Tier 1 Security Config ────────────────────────────────
const NODE_ENV = (process.env.NODE_ENV || 'development').toLowerCase();
const IS_PROD  = NODE_ENV === 'production';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const CHAT_RATE_LIMIT_PER_MIN = parseInt(process.env.CHAT_RATE_LIMIT_PER_MIN) || 30;
const MAX_BALANCE = parseFloat(process.env.MAX_BALANCE) || 1000000;

// Hard-fail if production without an allow-list — prevents a public deploy from accepting any origin.
if (IS_PROD && ALLOWED_ORIGINS.length === 0) {
    console.error('');
    console.error('╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: NODE_ENV=production but ALLOWED_ORIGINS is empty.     ║');
    console.error('║  Set ALLOWED_ORIGINS=https://your.domain in .env and restart. ║');
    console.error('╚════════════════════════════════════════════════════════════════╝');
    logger.fatal('NODE_ENV=production but ALLOWED_ORIGINS is empty — refusing to boot');
    process.exit(1);
}
if (!IS_PROD && ALLOWED_ORIGINS.length === 0) {
    console.warn('[cors] ⚠  dev mode: ALLOWED_ORIGINS empty → all origins permitted. Set ALLOWED_ORIGINS for production.');
} else {
    console.log(`[cors] whitelist: ${ALLOWED_ORIGINS.join(', ')}`);
}


// Account lockout policy. Persistent (DB-backed) so it
// survives restart and complements the in-memory rate limiter.
const LOCKOUT_THRESHOLD = parseInt(process.env.LOCKOUT_THRESHOLD) || 5;
const LOCKOUT_MINUTES   = parseInt(process.env.LOCKOUT_MINUTES)   || 15;




// ── PostgreSQL Database ────────────────────────────────────
const { Pool } = require('pg');
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT) || 5432;
const DB_NAME = process.env.DB_NAME || 'petabyte_ai';
const pool = new Pool({
    host:              DB_HOST,
    port:              DB_PORT,
    database:          DB_NAME,
    user:              process.env.DB_USER     || 'postgres',
    password:          process.env.DB_PASS     || '',
    max:               10,
    idleTimeoutMillis: 30000,
    // Higher timeout for slower / VPN networks (was 5s — too tight)
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT) || 15000,
    // Soft keepalive — recover from idle drop on flaky links
    keepAlive:         true,
    // Send TCP keepalive after 10s idle → detect dead sockets faster
    // (default ~2 hours on Linux → zombie connections linger forever)
    keepAliveInitialDelayMillis: 10000,
    // Hard ceiling on any single query — stops a hung DB call from
    // tying up an Express request indefinitely.
    query_timeout:     30000,
    // Don't hold the event loop open just because the pool is idle
    // (useful for smoke scripts / one-shot CLI tools).
    allowExitOnIdle:   false,
});

// Stop unhandled 'error' from killing the process when DB drops.
pool.on('error', err => {
    console.error('⚠️  PostgreSQL pool error (will retry on next query):', err.message);
});

// Initial connect with retry — useful when DB / VPN comes up after server start.
function connectWithRetry(attempt = 1, maxAttempts = 3) {
    pool.connect()
        .then(c => {
            console.log(`✅ PostgreSQL connected: ${DB_NAME} @ ${DB_HOST}:${DB_PORT}`);
            c.release();
        })
        .catch(err => {
            console.error(`❌ PostgreSQL connection failed (attempt ${attempt}/${maxAttempts}): ${err.message}`);
            if (attempt < maxAttempts) {
                const delay = attempt * 3000;
                console.log(`   ↻ Retrying in ${delay / 1000}s...`);
                setTimeout(() => connectWithRetry(attempt + 1, maxAttempts), delay);
            } else {
                console.error('   ⛔ Giving up — server stays alive but DB-backed endpoints will fail.');
                console.error('      Check: VPN / firewall / DB_HOST in .env / PostgreSQL service status');
            }
        });
}
connectWithRetry();

// โครงสร้างพื้นฐานย้ายไปเป็นโมดูล — ชื่อเดิมทั้งหมด destructure กลับมา
// validateAmount ไม่ import — zod แทนที่ไปนานแล้ว (ใน validation.js)
const { validatePasswordStrength, normalizeRole } = require('./lib/validators');
const sessionStore = require('./services/session-store')({ pool, isProd: IS_PROD });
const { SESSION_COOKIE, ACTIVE_COOKIE,
        createSession, getSession, deleteSession,
        _sessionCookieOpts, _markerCookieOpts, _extractToken } = sessionStore;
const { csrfGuard, requireAdmin, requireTrainer, requireAuth } =
    require('./middleware/auth')({ sessionStore });
const { logAdminAction, logAuthEvent } = require('./services/audit')({ pool });
const { spentToday, getEffectiveDailyCap, getProjectPool,
        checkChatBudget, getActivePricing } = require('./services/billing')({ pool });

// เครื่องยนต์ AI อยู่ใน services/ai/* — route เข้าถึงผ่าน ctx spread ด้านล่าง
const aiClient = require('./services/ai/client')({ pool });
const { HAS_API_KEY } = aiClient;
const aiTools = require('./services/ai/tools')({ ai: aiClient });
const skillRouter = require('./services/ai/skill-router')({ ai: aiClient, skillPrompts });
const { runSkillPromptOnce } = require('./services/ai/skill-runner')({ ai: aiClient, tools: aiTools });
aiClient.startKnowledgeInit();

// CORS whitelist จาก env — prod ห้ามว่าง (เช็คด้านบน), dev ว่าง = เปิดหมด, ไม่มี Origin = ผ่าน
app.use(cors({
    origin: function (origin, callback) {
        if (!origin)                         return callback(null, true); // curl / server-to-server
        if (!IS_PROD && ALLOWED_ORIGINS.length === 0) return callback(null, true); // dev open mode
        if (ALLOWED_ORIGINS.includes(origin))return callback(null, true);
        console.warn(`[cors] rejected origin: ${origin}`);
        return callback(new Error('CORS policy: origin not allowed'));
    },
    methods:        ['GET', 'POST', 'PUT', 'DELETE'],
    // X-CSRF-Token ต้องอยู่ใน allowlist ไม่งั้น browser ตัดทิ้งตอน preflight
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    credentials:    true,
}));
app.use(express.json({ limit: '2mb' }));
// CSRF guard runs after CORS+json so 403 responses still get CORS
// headers and we have access to req.body if any future logic needs it.
app.use(csrfGuard);
// static เสิร์ฟ repo root ซึ่งมีทั้ง .git, server/, logs, backups — จึงใช้ allow-list ของสิ่งที่หน้าเว็บใช้จริง
// (blocklist เดิมเทียบกับ req.path ดิบ แล้ว //server/x, /./server/x, /%2E/server/x หลุดไปถึงไฟล์)
const STATIC_ALLOW = /^\/$|^\/(?:assets|css|js|static)\/|^\/[A-Za-z0-9_-]+(?:\.html)?$/;
function canonicalPath(raw) {
    let s;
    try { s = decodeURIComponent(raw); } catch (_) { return null; }   // %-encoding พัง = ปฏิเสธ
    if (s.includes('\0')) return null;
    return path.posix.normalize(s.replace(/\\/g, '/')).replace(/\/{2,}/g, '/');
}
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const p = canonicalPath(req.path);
    if (p === null || p.startsWith('..') || !STATIC_ALLOW.test(p)) {
        return res.status(404).send('Not found');
    }
    next();
});

// clean URL: /login ↔ login.html (301 จาก .html เดิม) — ต้องมาก่อน static
app.get(['/login.html', '/admin.html', '/change-password.html', '/index.html'], (req, res) => {
    const clean = req.path === '/index.html' ? '/' : req.path.replace(/\.html$/, '');
    const query = req.originalUrl.slice(req.path.length);   // keep ?expired=1 etc.
    res.redirect(301, clean + query);
});

// HTML ห้าม cache เสมอ; ไฟล์อื่นใช้ค่า default (ตัว build ใส่ hash ในชื่อแล้ว)
const STATIC_OPTS = {
    extensions: ['html'],
    setHeaders: function (res, filePath) {
        if (filePath.toLowerCase().endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
            res.setHeader('Pragma',  'no-cache');
            res.setHeader('Expires', '0');
        }
    },
};
// เสิร์ฟ dist ก่อนแล้วตกลง source tree — dist ที่ build จาก commit อื่นต้องข้าม ไม่งั้นได้หน้าเก่าคู่ API ใหม่
const DIST_DIR = path.join(__dirname, '..', 'dist');
function distIsCurrent() {
    if (!fs.existsSync(DIST_DIR)) return false;
    let meta = null, head = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'build-meta.json'), 'utf8')); } catch (_) { /* build เก่าก่อนมี meta */ }
    try { head = require('child_process').execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { /* ไม่มี git */ }
    const built = meta && meta.commit;
    if (built && head && built === head) return true;
    const why = !meta ? 'no build-meta.json' : !built ? 'no commit in build-meta' : !head ? 'cannot read git HEAD' : 'built at ' + built.slice(0, 7) + ' but HEAD is ' + head.slice(0, 7);
    console.warn('[static] dist/ skipped (' + why + ') — serving source tree; run npm run build');
    return false;
}
if (distIsCurrent()) {
    app.use(express.static(DIST_DIR, STATIC_OPTS));
    console.log('[static] dist/ (built) first, source tree as fallback');
}
app.use(express.static(path.join(__dirname, '..'), STATIC_OPTS));

// ── Rate Limiting (per-user token bucket) ──────────────────
// key by session token if present, otherwise by IP. Applied to expensive AI endpoints.
const chatRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      CHAT_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders:   false,
    keyGenerator: (req, res) => {
        // v8: ipKeyGenerator(ip) ไม่ใช่ (req,res) — เรียกผิดแล้ว key เป็น [object Object] รวมทุกคนถังเดียว
        // key ตาม token ก่อน (ไม่ต้องแตะ DB) ไม่มีค่อยใช้ IP
        const tok = _extractToken(req);
        if (tok) return `t:${tok.slice(0, 16)}`;
        return `ip:${ipKeyGenerator(req.ip)}`;
    },
    handler: (req, res) => {
        const tok = _extractToken(req);
        console.warn(`[rate-limit] blocked — token=${tok.slice(0, 8)} ip=${req.ip}`);
        res.status(429).json({ ok: false, error: `Rate limit exceeded. Max ${CHAT_RATE_LIMIT_PER_MIN} requests/min.` });
    },
});


// สิ่งที่ error บอก client ได้: ข้อความที่เราเขียนเอง + ref สั้น ๆ — stack จริงลง log
// (เดิม 62 handler ส่ง e.message ตรง ๆ ซึ่งสะกดชื่อตาราง/พาธออกไป)
function safeError(e, req) {
    const ref = crypto.randomBytes(4).toString('hex');
    const where = req ? `${req.method} ${req.originalUrl}` : '';
    console.error(`[error ${ref}] ${where}:`, e && e.stack ? e.stack : e);
    // A message we wrote ourselves is meant for the user and stays; anything
    // thrown by pg, fs or the OpenAI SDK does not.
    if (e && e.userFacing) return { error: String(e.message || 'Request failed'), ref };
    return { error: 'Something went wrong — quote reference ' + ref + ' when reporting it.', ref };
}

// brute-force protection on login. Per IP+username so an attacker
// can't burn one user's rate budget for another.
const LOGIN_MAX_PER_15MIN = parseInt(process.env.LOGIN_MAX_PER_15MIN) || 10;
// backstop ของ route ที่เผาเงิน/บัฟเฟอร์ใหญ่ — กัน retry ค้าง/ดับเบิลคลิก ไม่ใช่โควต้า
const EXPENSIVE_RATE_LIMIT_PER_MIN = Number(process.env.EXPENSIVE_RATE_LIMIT_PER_MIN) || 30;
const expensiveRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      EXPENSIVE_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders:   false,
    keyGenerator: (req, res) => {
        // key รวม path ด้วย — instance เดียวถังเดียว ไม่งั้นห้า route แชร์ 30/min ก้อนเดียว
        const who = _extractToken(req) ? `t:${_extractToken(req).slice(0, 16)}`
                                       : `ip:${ipKeyGenerator(req.ip)}`;
        return `${who}|${req.path}`;
    },
    handler: (req, res) => {
        console.warn(`[rate-limit] expensive route blocked — ${req.method} ${req.path} ip=${req.ip}`);
        res.status(429).json({ ok: false, error: `Rate limit exceeded. Max ${EXPENSIVE_RATE_LIMIT_PER_MIN} requests/min for this endpoint.` });
    },
});

const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: LOGIN_MAX_PER_15MIN,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,    // only failed attempts count
    keyGenerator: (req, res) => {
        // coerce with String() — attacker may send non-string shapes
        // that crash toLowerCase. Clamp length so huge input doesn't grow keys.
        const u = String(req.body?.username || '').toLowerCase().slice(0, 64);
        return `${ipKeyGenerator(req.ip)}:${u}`;
    },
    handler: (req, res) => {
        // ผ่าน pino: ค่าถูก JSON-encode จึงแทรกบรรทัดปลอมด้วย \n ไม่ได้ และอยู่ในสายที่ redact ได้
        logger.warn({ event: 'login_rate_limit', ip: req.clientIp || req.ip, username: req.body?.username },
            'login rate limit: blocked');
        res.status(429).json({ ok: false, error: 'Too many login attempts. Try again in 15 minutes.' });
    },
});

// ══════════════════════════════════════════════════════════
//  ROUTES — Phase 49: หนึ่งกลุ่มหนึ่งไฟล์ใน ./routes, mount ตามลำดับเดิม
// ══════════════════════════════════════════════════════════
const { PRICING_LATERAL_JOIN, PRICING_PRICE_EXPR_RAW, PRICING_COST_EXPR } = require('./lib/pricing-sql');
const usageSync = require('./services/usage-sync')({ pool, openaiAdmin, logger });
const { runUsageSync, startUsageSyncTimer, getSyncState } = usageSync;

const ctx = {
    // infra
    pool, logger, safeError, validate, schemas,
    requireAdmin, requireTrainer, requireAuth,
    loginRateLimiter, chatRateLimiter, expensiveRateLimiter,
    // sessions + cookies
    SESSION_COOKIE, ACTIVE_COOKIE, createSession, getSession, deleteSession,
    _sessionCookieOpts, _markerCookieOpts, _extractToken,
    // rules + audit + billing
    validatePasswordStrength, normalizeRole,
    logAdminAction, logAuthEvent,
    spentToday, getEffectiveDailyCap, getProjectPool, checkChatBudget, getActivePricing,
    // AI engine (client/tools/router/runner)
    ...aiClient, ...aiTools, ...skillRouter, runSkillPromptOnce,
    PROMPT_COMMON_APPENDIX, applyCodePlaceholder, orgStandardsBlock,
    // misc deps
    skillPrompts, openaiAdmin, cryptoStore, migrationStatus, pkg,
    runUsageSync, getSyncState,
    PRICING_LATERAL_JOIN, PRICING_PRICE_EXPR_RAW, PRICING_COST_EXPR,
    MAX_BALANCE, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES, IS_PROD,
};

app.use(require('./routes/auth')(ctx));
app.use(require('./routes/users')(ctx));
app.use(require('./routes/projects')(ctx));
app.use(require('./routes/admin-logs')(ctx));
app.use(require('./routes/sync')(ctx));
app.use(require('./routes/skills')(ctx));
app.use(require('./routes/skill-test-logs')(ctx));
app.use(require('./routes/evals')(ctx));
app.use(require('./routes/reports')(ctx));
app.use(require('./routes/quota')(ctx));
app.use(require('./routes/history')(ctx));
app.use(require('./routes/chat-sessions')(ctx));
app.use(require('./routes/knowledge')(ctx));
app.use(require('./routes/misc')(ctx));
app.use(require('./routes/chat')(ctx));


// ── Start ── boot: migrations (fail = ไม่ start) → listen → signal handlers
let _httpServer = null;
let _shuttingDown = false;

async function gracefulShutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received — draining...`);
    logger.info({ signal }, 'shutdown: signal received, draining');
    // Stop accepting new connections
    if (_httpServer) {
        await new Promise((resolve) => _httpServer.close(() => {
            console.log('[shutdown] http closed');
            resolve();
        }));
    }
    // Clear intervals (session janitor)
    try { sessionStore.stopJanitor(); } catch (_) {}
    // Close DB pool
    try {
        await pool.end();
        console.log('[shutdown] db pool closed');
    } catch (e) {
        console.warn('[shutdown] pool.end error:', e.message);
        logger.warn({ err: e.message }, 'shutdown: pool.end error');
    }
    // Hard deadline in case anything hangs
    setTimeout(() => {
        console.warn('[shutdown] forced exit after 5s');
        process.exit(0);
    }, 5000).unref();
    console.log('[shutdown] bye');
    logger.info('shutdown: bye');
    // Flush pino worker transport before we exit so the final rows land on disk.
    await flushLogger();
    process.exit(0);
}

// ตาข่ายสุดท้าย: error ที่ route ไม่ได้จับ — client ได้ ref, log ได้ stack
app.use((err, req, res, _next) => {
    const ref = crypto.randomBytes(6).toString('hex');
    console.error(`[error ${ref}] ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
    // headers ออกไปแล้วต้องส่งต่อให้ Express ปิด socket — ไม่งั้น SSE ค้างจน timeout
    if (res.headersSent) return _next(err);
    res.status(err && err.status ? err.status : 500)
       .json({ ok: false, error: 'Internal error', ref });
});

async function boot() {
    // 1. Run migrations first — abort boot if any fail
    try {
        await runMigrations(pool);
    } catch (e) {
        console.error('[boot] ✗ migrations failed:', e.message);
        console.error('[boot] server will NOT start with a broken schema.');
        logger.fatal({ err: e.message }, 'boot: migrations failed — aborting');
        await flushLogger();
        process.exit(1);
    }

    // 2. Start HTTP listener
    _httpServer = app.listen(PORT, () => {
        console.log('');
        console.log('╔══════════════════════════════════════╗');
        console.log('║   PetabyteAi Backend Server          ║');
        console.log(`║   http://localhost:${PORT}              ║`);
        console.log(`║   OpenAI: ${HAS_API_KEY ? '🟢 Live           ' : '🟡 Mock          '}   ║`);
        console.log('║   DB:     🟢 PostgreSQL              ║');
        console.log('╚══════════════════════════════════════╝');
        console.log('');
    });

    // usage sync รอบแรก ~10s หลัง boot แล้ววนตาม env; ไม่มี admin key = no-op
    startUsageSyncTimer();

    // โหลด skill prompts จาก tbl_prompt (seed จากไฟล์ตอนตารางว่าง; DB ล่มใช้ไฟล์)
    skillPrompts.setPool(pool);
    await skillPrompts.load();

    // 3. Signal handlers — let Docker/systemd/PM2 stop us cleanly
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

    // unhandledRejection ห้ามฆ่า process — log ดัง ๆ แล้วอยู่ต่อ; ไม่ใช่ข้ออ้างให้ route เลิก try/catch
    process.on('unhandledRejection', (reason, promise) => {
        const msg = (reason && reason.message) || String(reason);
        console.error('[unhandledRejection]', msg);
        if (reason && reason.stack) console.error(reason.stack);
        try {
            logger?.error?.({ err: msg, stack: reason?.stack },
                'unhandled promise rejection — server staying up');
        } catch (_) { /* logger itself may be the problem */ }
    });
    process.on('uncaughtException', (err) => {
        // throw แบบ sync อันตรายกว่า — state อาจพัง; log ให้ operator ตัดสินใจ restart เอง
        console.error('[uncaughtException]', err && err.message);
        if (err && err.stack) console.error(err.stack);
        try {
            logger?.fatal?.({ err: err?.message, stack: err?.stack },
                'uncaught exception — review state, consider restart');
        } catch (_) { /* nothing */ }
    });
}

boot();
