/**
 * server.js — PetabyteAi Backend Server
 * OpenAI Streaming proxy + PostgreSQL database
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const path         = require('path');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');    // Phase 9
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { validate, schemas } = require('./validation');  // Phase 10
const { runMigrations, migrationStatus } = require('./migrate-schema'); // Phase 11
const { logger, httpLogger, flushLogger } = require('./logger');        // Phase 11 C
const openaiAdmin           = require('./openai-admin');                // Phase 15
const cryptoStore           = require('./crypto');                       // Phase 17
const skillPrompts          = require('./skill-prompts');
// Phase 46: pure logic lifted out of this file. No pool, no OpenAI client —
// each of these can be exercised by a test directly.
const promptLib             = require('./lib/prompt');                  // Phase 46
const { PROMPT_COMMON_APPENDIX, applyCodePlaceholder, orgStandardsBlock } = promptLib;
const pkg                   = require('./package.json');
const app  = express();
const PORT = process.env.PORT || 3001;

// Phase 9: cookie-parser must run BEFORE any route that reads req.cookies.
// Single line, no secret needed (we use HttpOnly+SameSite=Strict, not signed).
app.use(cookieParser());

// Phase 11 C: structured request log — one JSON line per request, with
// redacted headers (Authorization/Cookie/CSRF). /api/health is skipped
// (see logger.js) so health-check spam does not drown the signal.
app.use(httpLogger);

// Phase 7: Security headers (CSP relaxed for inline scripts/styles in this app)
// Phase 8: HSTS in prod — once a browser sees this, it refuses HTTP for 1 year.
// Phase 10: CSP enabled with a curated policy. We HAVE to keep 'unsafe-inline'
// for both script and style because the existing HTML uses ~54 inline
// onclick/onsubmit handlers + many inline <style> blocks. Refactoring that
// out is a project of its own. But everything else gets locked down:
//   - object-src 'none'           no <embed>/<object>/flash
//   - base-uri 'self'             prevents <base> href hijack
//   - frame-ancestors 'none'      clickjacking kill
//   - form-action 'self'          forms can only POST to us
//   - default-src 'self'          no random cross-origin loads
// Google Fonts is the only allowed CDN (the app uses Inter + JetBrains Mono).
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


// Phase 8: Account lockout policy. Persistent (DB-backed) so it
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

// Phase 49: โครงสร้างพื้นฐานย้ายไปเป็นโมดูล — ชื่อเดิมทั้งหมด destructure กลับมา
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

// Phase 49: เครื่องยนต์ AI อยู่ใน services/ai/* — route เข้าถึงผ่าน ctx spread ด้านล่าง
const aiClient = require('./services/ai/client')({ pool });
const { HAS_API_KEY } = aiClient;
const aiTools = require('./services/ai/tools')({ ai: aiClient });
const skillRouter = require('./services/ai/skill-router')({ ai: aiClient, skillPrompts });
const { runSkillPromptOnce } = require('./services/ai/skill-runner')({ ai: aiClient, tools: aiTools });
aiClient.startKnowledgeInit();

// ── Middleware ─────────────────────────────────────────────
// CORS: whitelist from env. In prod, we already exit if list is empty (see above).
// In dev with empty list, allow all. Non-browser clients (no Origin header) always pass.
app.use(cors({
    origin: function (origin, callback) {
        if (!origin)                         return callback(null, true); // curl / server-to-server
        if (!IS_PROD && ALLOWED_ORIGINS.length === 0) return callback(null, true); // dev open mode
        if (ALLOWED_ORIGINS.includes(origin))return callback(null, true);
        console.warn(`[cors] rejected origin: ${origin}`);
        return callback(new Error('CORS policy: origin not allowed'));
    },
    methods:        ['GET', 'POST', 'PUT', 'DELETE'],
    // Phase 9: X-CSRF-Token must be in the CORS allowlist or browser
    // strips it on preflight before reaching our middleware.
    // Phase 39: Authorization removed — cookie is the only auth path.
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    credentials:    true,
}));
app.use(express.json({ limit: '2mb' }));
// Phase 9: CSRF guard runs after CORS+json so 403 responses still get CORS
// headers and we have access to req.body if any future logic needs it.
app.use(csrfGuard);
// Phase 19.7.1: never let the browser cache HTML. The HTML files
// reference versioned JS/CSS via ?v=... query strings, so caching the
// HTML aggressively (Express's default sends ETag → 304) means users
// can sit on a stale `index.html` that still points at old JS even
// after we ship new code. JS/CSS keep their default cache headers —
// the version-string in the URL is the cache buster for them.
// Security: express.static below serves the whole repo root (so the
// frontend at ../index.html, ../js, ../css, ../assets is reachable). That
// also exposed server source, internal docs, DB dumps, deploy scripts, and
// archived legacy data (e.g. GET /server/server.js, /docs/*.md, and
// /_archive/legacy/db.json which held bcrypt password hashes). Block every
// non-frontend top-level folder here, before static runs — including any dir
// starting with "_" (archives / mockups) or "." (.git, .env, .claude), which
// the earlier explicit list missed. Only js/ css/ assets/ + the page HTML
// files stay public.
const BLOCKED_TOP_DIRS = /^\/(server|docs|backups|windows|node_modules|_[^/]+|\.[^/]+)(\/|$)/i;
// Also block root-level source/config files (start.js, README.md, *.sh/.bat,
// etc.) — the browser only ever needs the page HTML files + js/css/assets, so
// these are just source exposure. Frontend assets live under js/ css/ assets/
// so the /dir/ prefix keeps them clear of this root-file match.
const BLOCKED_ROOT_FILES = /^\/[^/]+\.(js|mjs|cjs|ts|sh|bat|ps1|md|py|sql|json|ya?ml|env|example|lock)$/i;
app.use((req, res, next) => {
    if (BLOCKED_TOP_DIRS.test(req.path) || BLOCKED_ROOT_FILES.test(req.path)) {
        return res.status(404).send('Not found');
    }
    next();
});

// Clean URLs: /login instead of /login.html. Old .html addresses 301 to
// the extensionless form so bookmarks and old links keep working, and
// express.static's `extensions` option resolves /login back to login.html
// on disk. Must be registered BEFORE the static middleware, otherwise
// static serves the .html file first and the redirect never runs.
app.get(['/login.html', '/admin.html', '/change-password.html', '/index.html'], (req, res) => {
    const clean = req.path === '/index.html' ? '/' : req.path.replace(/\.html$/, '');
    const query = req.originalUrl.slice(req.path.length);   // keep ?expired=1 etc.
    res.redirect(301, clean + query);
});

app.use(express.static(path.join(__dirname, '..'), {
    extensions: ['html'],
    setHeaders: function (res, filePath) {
        if (filePath.toLowerCase().endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
            res.setHeader('Pragma',  'no-cache');
            res.setHeader('Expires', '0');
        }
    },
}));

// ── Rate Limiting (per-user token bucket) ──────────────────
// key by session token if present, otherwise by IP. Applied to expensive AI endpoints.
const chatRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      CHAT_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders:   false,
    keyGenerator: (req, res) => {
        // express-rate-limit v8 takes ipKeyGenerator(ip, ipv6Subnet), not
        // (req, res). Called the old way it returns the request object, the
        // key becomes "ip:[object Object]", and every unauthenticated caller
        // shares one bucket. Its own validator stays quiet because the source
        // contains the token "ipKeyGenerator" — nothing reports this.
        // Phase 7: rate-limit keys by token prefix when present (no DB lookup
        // needed in the hot path), otherwise IP. Endpoints that need the real
        // user id are already gated by requireAuth, which populates req.session.
        // Phase 39: token now comes from the session cookie (Bearer removed).
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


// Phase 47: what a caught error is allowed to tell the client.
//
// 62 handlers were returning e.message verbatim. A Postgres error names the
// table, the column and the constraint; an ENOENT names the server path. All
// of it is behind auth, so this is disclosure rather than a hole — but there
// was never a reason for it, and the global handler below does NOT cover these
// because a route that catches its own error never reaches it. The commit that
// added that handler claimed otherwise; this is the part that was missing.
//
// The full error still goes to the log with a reference the user can quote.
function safeError(e, req) {
    const ref = crypto.randomBytes(4).toString('hex');
    const where = req ? `${req.method} ${req.originalUrl}` : '';
    console.error(`[error ${ref}] ${where}:`, e && e.stack ? e.stack : e);
    // A message we wrote ourselves is meant for the user and stays; anything
    // thrown by pg, fs or the OpenAI SDK does not.
    if (e && e.userFacing) return { ...safeError(e, req), ref };
    return { error: 'Something went wrong — quote reference ' + ref + ' when reporting it.', ref };
}
// ══════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════

// Phase 7: brute-force protection on login. Per IP+username so an attacker
// can't burn one user's rate budget for another.
const LOGIN_MAX_PER_15MIN = parseInt(process.env.LOGIN_MAX_PER_15MIN) || 10;
// Phase 47: the routes that spend money or hold a big buffer. /api/chat and
// the login are already limited; these were not, and each one either fires a
// real OpenAI request (skills test, evals) or takes a 100MB upload. Generous
// on purpose — this is a backstop against a stuck retry loop or an accidental
// double-click, not a quota. Shares the chat limiter's key strategy so one
// user hitting it does not limit everyone behind the same IP.
const EXPENSIVE_RATE_LIMIT_PER_MIN = Number(process.env.EXPENSIVE_RATE_LIMIT_PER_MIN) || 30;
const expensiveRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      EXPENSIVE_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders:   false,
    keyGenerator: (req, res) => {
        // Keyed by PATH as well as caller. One rateLimit() instance owns one
        // store, so without this the five routes share a single 30/min budget
        // and the 429 says "for this endpoint" when it measured all of them —
        // 30 CSV exports would block an upload.
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
        // Phase 10: coerce with String() — attacker may send non-string shapes
        // that crash toLowerCase. Clamp length so huge input doesn't grow keys.
        const u = String(req.body?.username || '').toLowerCase().slice(0, 64);
        return `${ipKeyGenerator(req.ip)}:${u}`;
    },
    handler: (req, res) => {
        console.warn(`[login-rate-limit] blocked ip=${req.ip} user=${req.body?.username}`);
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


// ── Start ──────────────────────────────────────────────────
// Phase 11: boot sequence
//   1. Run pending schema migrations (abort if any fail — safer than
//      letting the server come up with a partially-migrated DB).
//   2. Start HTTP listener.
//   3. Install SIGTERM/SIGINT handlers for graceful shutdown.
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

// Phase 47: the last stop for anything a route did not catch. 61 handlers were
// returning e.message straight to the client — a Postgres error names tables
// and constraints, a filesystem error names server paths. All of it sits
// behind auth, so this is disclosure rather than a hole, but there is no
// reason for it. The full error goes to the log with an id; the client gets
// the id, which is what a person needs in order to report the problem.
app.use((err, req, res, _next) => {
    const ref = crypto.randomBytes(6).toString('hex');
    console.error(`[error ${ref}] ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
    // Express needs the error passed on once headers are out, so its default
    // handler destroys the socket. Returning here left an SSE response — and
    // /api/chat writes headers immediately — open until something timed out.
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

    // Phase 17.3: start the OpenAI usage sync background job. Runs first
    // pass ~10s after boot (so listener is up + DB warm), then every
    // OPENAI_USAGE_SYNC_INTERVAL_MIN minutes. No-op if admin key missing.
    startUsageSyncTimer();

    // Phase 18: load skill-prompts.json into the router's in-memory cache.
    // Safe to skip on parse error — `getSkills()` returns [] and the chat
    // path falls back to Assistant-only behaviour.
    // Phase 23: prompts now live in tbl_prompt (DB). Wire the pool and load
    // from DB (seeds from the JSON file on first boot when the table is empty;
    // falls back to the file if the DB is unreachable).
    skillPrompts.setPool(pool);
    await skillPrompts.load();

    // 3. Signal handlers — let Docker/systemd/PM2 stop us cleanly
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

    // 4. Phase 16.6: safety net for unhandled async errors.
    // Node ≥15 (we're on 24) terminates the process by default on an
    // unhandled promise rejection. Transient infra blips — DB EHOSTUNREACH,
    // OpenAI 5xx, slow Postgres queries that throw past every try/catch —
    // would silently kill the server. We log them loudly instead so they
    // still get noticed in the operator log, but the HTTP listener stays up.
    //
    // Note: this is NOT a license to skip per-route error handling. Every
    // route should still wrap its own awaits — this is the last resort that
    // prevents a single missed catch from taking the whole server down.
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
        // Synchronous throws are more dangerous than unhandled rejections —
        // state may be corrupt. Log and let the process keep running but
        // flag it loudly so the operator can decide whether to recycle.
        console.error('[uncaughtException]', err && err.message);
        if (err && err.stack) console.error(err.stack);
        try {
            logger?.fatal?.({ err: err?.message, stack: err?.stack },
                'uncaught exception — review state, consider restart');
        } catch (_) { /* nothing */ }
    });
}

boot();
