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
const bcrypt       = require('bcrypt');
const cookieParser = require('cookie-parser');    // Phase 9
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { validate, schemas } = require('./validation');  // Phase 10
const { runMigrations, migrationStatus } = require('./migrate-schema'); // Phase 11
const { logger, httpLogger, flushLogger } = require('./logger');        // Phase 11 C
const openaiAdmin           = require('./openai-admin');                // Phase 15
const cryptoStore           = require('./crypto');                       // Phase 17
const skillPrompts          = require('./skill-prompts');               // Phase 18
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

/** Phase 7: stricter password policy. Returns null if OK, error string if bad. */
function validatePasswordStrength(pw) {
    if (!pw || typeof pw !== 'string') return 'password is required';
    if (pw.length < 8)              return 'password must be at least 8 characters';
    if (pw.length > 128)            return 'password must be at most 128 characters';
    if (!/[A-Za-z]/.test(pw))       return 'password must contain at least one letter';
    if (!/[0-9]/.test(pw))          return 'password must contain at least one digit';
    return null;
}

// Phase 8: Account lockout policy. Persistent (DB-backed) so it
// survives restart and complements the in-memory rate limiter.
const LOCKOUT_THRESHOLD = parseInt(process.env.LOCKOUT_THRESHOLD) || 5;
const LOCKOUT_MINUTES   = parseInt(process.env.LOCKOUT_MINUTES)   || 15;

/** Validate balance/credit number. Returns number (safe) or throws. */
function validateAmount(value, { min = 0, max = MAX_BALANCE, required = true } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw new Error('amount required');
        return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error('amount must be a number');
    if (n < min) throw new Error(`amount must be >= ${min}`);
    if (n > max) throw new Error(`amount must be <= ${max}`);
    return n;
}

// ── Role normalization ─────────────────────────────────────
// DB stores tbl_user_role.role_des as 'admin' or 'general user'.
// Frontend (Auth.check / requireRole) compares against literal 'admin' / 'user'.
// Normalize at every response boundary so client & middleware never see 'general user'.
function normalizeRole(roleDes) {
    if (!roleDes) return 'user';
    return String(roleDes).toLowerCase().trim() === 'admin' ? 'admin' : 'user';
}

// ── Session Store (Phase 7: PostgreSQL-backed; Phase 9: CSRF token) ────
// Survives server restart, supports multi-instance scale, gives admins
// a real "who's logged in" / "logout-all" capability later.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SESSION_COOKIE = 'petabyte_session';
// Phase 24: readable (non-HttpOnly) session-scoped marker cookie. Lets the
// frontend tell whether the browser session is still alive. Dies when the
// browser closes (no maxAge) → drives "close browser = logout".
const ACTIVE_COOKIE = 'petabyte_active';
const CSRF_HEADER    = 'x-csrf-token';

async function createSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const csrf  = crypto.randomBytes(32).toString('hex');    // Phase 9
    const role  = normalizeRole(user.role);
    const expires = new Date(Date.now() + SESSION_TTL_MS);
    await pool.query(
        `INSERT INTO tbl_session (token, user_id, role, expires_at, csrf_token)
         VALUES ($1, $2, $3, $4, $5)`,
        [token, user.id, role, expires, csrf]
    );
    return { token, csrf };
}

/** Look up an active (unexpired) session by token. Touches last_seen_at. */
async function getSession(token) {
    if (!token) return null;
    const r = await pool.query(
        `SELECT s.token, s.user_id AS "userId", s.role, s.expires_at,
                s.csrf_token AS "csrfToken",
                u.username, u.must_change_password AS "mustChangePassword"
         FROM tbl_session s
         JOIN tbl_user u ON s.user_id = u.user_id
         WHERE s.token = $1 AND s.expires_at > NOW() AND u.is_deleted = FALSE`,
        [token]
    );
    if (r.rows.length === 0) return null;
    // best-effort touch — not awaited
    pool.query('UPDATE tbl_session SET last_seen_at = NOW() WHERE token = $1', [token])
        .catch(() => {});
    return r.rows[0];
}

// Phase 9: cookie option helper — single source of truth so login/logout match
function _sessionCookieOpts(maxAge) {
    return {
        httpOnly: true,
        sameSite: 'strict',           // browser refuses to send on cross-site nav
        secure:   IS_PROD,            // dev = http://, prod = https://
        path:     '/',
        ...(maxAge !== undefined ? { maxAge } : {}),
    };
}

// Phase 24: options for the readable marker cookie — NOT HttpOnly (JS must read
// it) and NO maxAge (session-scoped: the browser drops it when it closes).
function _markerCookieOpts() {
    return { httpOnly: false, sameSite: 'strict', secure: IS_PROD, path: '/' };
}

async function deleteSession(token) {
    if (!token) return;
    try { await pool.query('DELETE FROM tbl_session WHERE token = $1', [token]); }
    catch (e) { console.warn('[session] delete failed:', e.message); }
}

// Janitor: prune expired sessions every 10 minutes
// Phase 11: captured so graceful shutdown can clear it.
const _sessionJanitor = setInterval(() => {
    pool.query('DELETE FROM tbl_session WHERE expires_at <= NOW()')
        .then(r => { if (r.rowCount > 0) console.log(`[sessions] pruned ${r.rowCount} expired`); })
        .catch(e => console.warn('[sessions] janitor failed:', e.message));
}, 10 * 60 * 1000);
_sessionJanitor.unref();

function _extractToken(req) {
    // Phase 9: cookie wins (HttpOnly, can't be stolen by XSS).
    // Bearer header is fallback for backward compatibility — non-browser
    // clients (curl, smoke tests) and any old client code keep working.
    if (req.cookies && req.cookies[SESSION_COOKIE]) return req.cookies[SESSION_COOKIE];
    return (req.headers['authorization'] || '').replace('Bearer ', '');
}

// Phase 9: CSRF guard — applied to every state-changing request that
// already has a session. GET/HEAD/OPTIONS are safe by spec.
// Login is whitelisted (no session yet to compare against).
// Reasoning for double-submit-only: with HttpOnly + SameSite=Strict the
// auth cookie won't ride cross-site requests, so a CSRF attack would
// have to come from same-site (e.g. an XSS) — at which point it can
// also read the CSRF token from JS storage, defeating it. We keep the
// header check anyway as defense-in-depth + protection for the Bearer
// fallback path (where SameSite doesn't apply).
const CSRF_EXEMPT_PATHS = new Set([
    '/api/auth/login',     // no session yet
    '/api/health',         // public probe
    '/api/logout',         // best-effort cleanup; idempotent
]);
function _isCsrfMethod(m) { return m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH'; }

async function csrfGuard(req, res, next) {
    if (!_isCsrfMethod(req.method)) return next();
    if (CSRF_EXEMPT_PATHS.has(req.path)) return next();
    const token = _extractToken(req);
    if (!token) return next();   // no session → requireAuth will 401 later
    try {
        const sess = await getSession(token);
        if (!sess) return next(); // requireAuth will 401
        const headerCsrf = req.headers[CSRF_HEADER];
        if (!headerCsrf || headerCsrf !== sess.csrfToken) {
            // Phase 19.7.2: keep a one-line note so a future stale-CSRF
            // mismatch is at least visible in the server log (e.g. after
            // a deploy that rotates session secrets). No header dump.
            console.warn('[csrf] reject', req.method, req.path,
                '— browser CSRF stale; user needs to logout/login');
            return res.status(403).json({ ok: false, error: 'CSRF token missing or invalid' });
        }
        next();
    } catch (e) {
        console.error('[csrf]', e.message);
        res.status(500).json({ ok: false, error: 'CSRF check failed' });
    }
}
// app.use(csrfGuard) is registered later — AFTER cors() + body parser —
// so CORS headers ride along on the 403 reply.

// Phase 8: When must_change_password=true the only endpoints that work
// are the user changing their OWN password and logging out. Everything
// else returns 423 with a hint so the client can redirect to /change-pw.
// Path-based allowlist keeps the rule in one place rather than
// sprinkling checks through every route.
const PW_CHANGE_ALLOWED = [
    /^\/api\/users\/\d+\/password$/,    // PUT — self password change
    /^\/api\/logout$/,                   // POST — sign out
];
function _isPwChangeAllowed(req) {
    return PW_CHANGE_ALLOWED.some(rx => rx.test(req.path));
}

async function requireAdmin(req, res, next) {
    const token = _extractToken(req);
    if (!token) return res.status(401).json({ ok: false, error: 'Authentication required' });
    try {
        const sess = await getSession(token);
        if (!sess) return res.status(401).json({ ok: false, error: 'Session expired' });
        if (sess.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin access required' });
        if (sess.mustChangePassword && !_isPwChangeAllowed(req)) {
            return res.status(423).json({ ok: false, mustChangePassword: true,
                error: 'Password change required before continuing' });
        }
        req.session = sess;
        next();
    } catch (e) {
        console.error('[requireAdmin]', e.message);
        res.status(500).json({ ok: false, error: 'Auth check failed' });
    }
}

async function requireAuth(req, res, next) {
    const token = _extractToken(req);
    if (!token) return res.status(401).json({ ok: false, error: 'Authentication required' });
    try {
        const sess = await getSession(token);
        if (!sess) return res.status(401).json({ ok: false, error: 'Session expired' });
        if (sess.mustChangePassword && !_isPwChangeAllowed(req)) {
            return res.status(423).json({ ok: false, mustChangePassword: true,
                error: 'Password change required before continuing' });
        }
        req.session = sess;
        next();
    } catch (e) {
        console.error('[requireAuth]', e.message);
        res.status(500).json({ ok: false, error: 'Auth check failed' });
    }
}

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

// ── OpenAI ─────────────────────────────────────────────────
const HAS_API_KEY = !!(
    process.env.OPENAI_API_KEY &&
    !process.env.OPENAI_API_KEY.startsWith('sk-xxx')
);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// Model-compatibility knobs. Newer models (gpt-5.5, o-series) reject a custom
// `temperature` (only the default is allowed) and require `max_completion_tokens`
// instead of `max_tokens`. OPENAI_TEMPERATURE: a number = use it; empty = omit
// it; unset = 0.4 (fine for gpt-4o). If a model rejects it at runtime we flip
// _tempUnsupported so we stop sending it (avoids a failed call every message).
const OAI_TEMPERATURE = (process.env.OPENAI_TEMPERATURE !== undefined)
    ? (process.env.OPENAI_TEMPERATURE.trim() === '' ? null : Number(process.env.OPENAI_TEMPERATURE))
    : 0.4;
let _tempUnsupported = false;

// Phase 34: model registry — which models the picker exposes, and which OpenAI
// API each one uses. The gpt-5.6 family (sol/terra/luna) runs on the Responses
// API (/v1/responses) with reasoning.effort; gpt-5.5 stays on the existing Chat
// Completions loop (dual-path, safe rollback). Single source for request-side
// validation. Per-model pricing lives in tbl_pricing (phase27-001). The bare
// `gpt-5.6` alias resolves to sol (see resolveModel below).
const ALLOWED_MODELS = {
    'gpt-5.6-sol':   { path: 'responses', label: 'GPT-5.6 Sol',   supportsEffort: true },
    'gpt-5.6-terra': { path: 'responses', label: 'GPT-5.6 Terra', supportsEffort: true },
    'gpt-5.6-luna':  { path: 'responses', label: 'GPT-5.6 Luna',  supportsEffort: true },
    'gpt-5.5':       { path: 'chat',      label: 'GPT-5.5',       supportsEffort: false },
};
const MODEL_ALIASES = { 'gpt-5.6': 'gpt-5.6-sol' };
const VALID_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT = 'medium';

// Resolve the client-supplied model to { model, path }. An EXPLICIT, known
// model from the request is honored (with its API path); anything else falls
// back to the env default MODEL on whichever path it belongs to — so if the
// request omits a model, behavior is unchanged from today (e.g. gpt-4o/gpt-5.5
// keep running on the Chat Completions loop). This keeps the rollout safe:
// only an explicit gpt-5.6-* request ever reaches the Responses API path.
function resolveModel(requested) {
    const aliased = MODEL_ALIASES[requested] || requested;
    if (aliased && ALLOWED_MODELS[aliased]) {
        return { model: aliased, path: ALLOWED_MODELS[aliased].path };
    }
    const dflt = MODEL_ALIASES[MODEL] || MODEL;
    return { model: dflt, path: ALLOWED_MODELS[dflt]?.path || 'chat' };
}
function resolveEffort(requested) {
    return VALID_EFFORTS.includes(requested) ? requested : DEFAULT_EFFORT;
}
let openai = null;
let OpenAI = null;
// Optional corporate egress proxy + fail-fast timeout for OpenAI calls.
// On a locked-down company network the server often cannot reach
// api.openai.com directly (blocked or proxy-only). openai v4 uses a
// node-fetch shim and does NOT auto-honor HTTPS_PROXY — the agent must be
// wired in explicitly. The timeout makes a blocked egress fail fast (and the
// chat UI shows a real error) instead of hanging silently on the SDK default.
const _OAI_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
let _oaiAgent = undefined;
if (_OAI_PROXY) {
    try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        _oaiAgent = new HttpsProxyAgent(_OAI_PROXY);
        console.log(`🌐 OpenAI egress via proxy: ${_OAI_PROXY}`);
    } catch (e) {
        console.warn('[openai] HTTPS_PROXY is set but `https-proxy-agent` is not installed — run `npm i https-proxy-agent` in server/. Continuing WITHOUT proxy.');
    }
}
// timeout = time to start getting a response (does not cut a flowing stream);
// maxRetries 0 so a hard egress block fails once, fast, and surfaces clearly.
const OAI_OPTS = { timeout: 60000, maxRetries: 0, ...(_oaiAgent ? { httpAgent: _oaiAgent } : {}) };

if (HAS_API_KEY) {
    OpenAI = require('openai');
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, ...OAI_OPTS });
    console.log(`✅ OpenAI ready — model: ${MODEL}`);
} else {
    console.log('⚠️  No OpenAI API Key — MOCK mode');
}

// ── Phase 17.2 + 17.2.1: per-project OpenAI client routing ───
// Phase 17.2.1 adds an "invalidation" path so a project whose stored key
// turns out to be 401 (revoked/expired/wrong) doesn't break chat forever —
// the chat path catches the 401 once, marks the project, and from then on
// `getProjectOpenAI` short-circuits to the global client. Cleared via
// invalidateProjectClient() when an admin saves a new key.
// When a user makes a chat request we look up their project's
// `project_api_key` (decrypted) and use that key for the OpenAI call.
// This gives us:
//   - Per-project cost separation in OpenAI's billing dashboard
//   - Per-project quota isolation (one runaway project doesn't burn org quota)
//   - Per-project audit trail (usage tagged with the project's SA)
//
// Fallback strategy: any case where we don't have a usable per-project key
// (user has no project / project has no key / decrypt failed / key looks
// invalid) returns the GLOBAL `openai` client. This keeps backward
// compatibility — nothing breaks during the rollout while admins are still
// pasting in keys per project.
//
// Cache: clients are cached by project_id so we don't re-construct one on
// every request. Cache is invalidated when admin saves a new key on the
// project (PUT /api/projects/:id) — see invalidateProjectClient() call sites.
const _projectClientCache = new Map();      // projectId -> { client, decryptedKeyTail }
const _invalidProjectKeys = new Set();       // project_ids whose stored key returned 401 — see chatWithFallback

async function getProjectOpenAI(userId) {
    if (!openai) return openai;                        // no key configured at all
    if (!userId) return openai;                        // no auth context

    // Resolve the user's current project. (Cached fetchUsersFromDB on client
    // is great for UI, but here we read fresh from DB so a project change
    // takes effect on the very next request.)
    const u = await pool.query(
        'SELECT project_id FROM tbl_user WHERE user_id = $1 AND is_deleted = FALSE',
        [userId]);
    const projectId = u.rows[0]?.project_id;
    if (!projectId) return openai;

    // Phase 17.2.1: short-circuit projects we've already proven have a bad
    // key — we caught a 401 on a previous chat call and marked them. Admin
    // saving a new key clears the flag via invalidateProjectClient().
    if (_invalidProjectKeys.has(projectId)) return openai;

    // Check cache
    const cached = _projectClientCache.get(projectId);
    if (cached) return cached.client;

    // Pull encrypted key from DB, decrypt, build a new client.
    const p = await pool.query(
        'SELECT project_api_key FROM tbl_project WHERE project_id = $1 AND is_deleted = FALSE',
        [projectId]);
    const blob = p.rows[0]?.project_api_key;
    if (!blob) return openai;
    const key = cryptoStore.tryDecrypt(blob);
    if (!key || !/^sk-/i.test(key)) return openai;     // bad/placeholder — fallback

    const client = new OpenAI({ apiKey: key, ...OAI_OPTS });
    _projectClientCache.set(projectId, {
        client,
        decryptedKeyTail: key.slice(-4),               // for diagnostic logs only
    });
    return client;
}

/** Drop the cached client so the next request rebuilds with the latest key.
 *  Also clears the "known bad" flag so a freshly-saved key gets a clean retry. */
function invalidateProjectClient(projectId) {
    if (!projectId) return;
    _projectClientCache.delete(projectId);
    _invalidProjectKeys.delete(projectId);
}

/** Mark a project's stored key as invalid (401 detected mid-chat).
 *  Subsequent getProjectOpenAI() calls for this project will short-circuit
 *  to the global client until an admin saves a new key. */
async function markProjectKeyInvalid(userId, reason) {
    if (!userId) return null;
    try {
        const r = await pool.query(
            'SELECT project_id FROM tbl_user WHERE user_id = $1 AND is_deleted = FALSE',
            [userId]);
        const projectId = r.rows[0]?.project_id;
        if (!projectId) return null;
        _invalidProjectKeys.add(projectId);
        _projectClientCache.delete(projectId);
        console.warn('[chat] flagged', projectId, 'as having an invalid project_api_key — falling back to global. reason:', reason);
        // best-effort: record into action log so admin can see why
        try {
            await pool.query(
                `INSERT INTO tbl_action_admin (user_id, role_id, action_type, target_type, change_json)
                 VALUES (1, 1, 'project_key_invalid', 'project', $1)`,
                [JSON.stringify({ project_id: projectId, reason })]);
        } catch (_) { /* non-fatal */ }
        return projectId;
    } catch (e) {
        console.warn('[chat] markProjectKeyInvalid failed:', e.message);
        return null;
    }
}

/** Call openai.chat.completions.create with auto-fallback to the global
 *  client on 401. Use this in EVERY chat path so a bad per-project key
 *  never breaks a user-visible request — we just log + degrade gracefully. */
async function safeChatCompletion(oai, args, userId) {
    try { return await oai.chat.completions.create(args); }
    catch (e) {
        const status = e?.status || e?.statusCode;
        if (status === 401 && oai !== openai && openai) {
            await markProjectKeyInvalid(userId, 'chat.completions 401');
            return await openai.chat.completions.create(args);   // retry once with global
        }
        throw e;
    }
}

// ── Phase 4: Tool Definitions (Joule-style Function Calling) ──
const PHASE4_TOOLS = [
    { type: 'file_search' },
    {
        type: 'function',
        function: {
            name: 'find_bapi',
            description: 'ค้นหา BAPI หรือ Function Module ที่เหมาะสมสำหรับงาน SAP ที่ต้องการ',
            parameters: {
                type: 'object',
                properties: {
                    task:   { type: 'string', description: 'งานที่ต้องการทำ เช่น "post goods movement", "create sales order"' },
                    module: { type: 'string', description: 'SAP module เช่น MM, SD, FI, HR (optional)' },
                },
                required: ['task'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'check_abap_syntax',
            description: 'ตรวจสอบ syntax และ obsolete statements ใน ABAP code',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: 'ABAP source code ที่ต้องการตรวจสอบ' },
                },
                required: ['code'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_transaction_info',
            description: 'ดูข้อมูลและคำอธิบายของ SAP Transaction Code',
            parameters: {
                type: 'object',
                properties: {
                    tcode: { type: 'string', description: 'SAP Transaction Code เช่น SE38, SM30, ST22' },
                },
                required: ['tcode'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'search_s4_migration',
            description: 'ค้นหาข้อมูลการ migrate จาก SAP ECC ไป S/4HANA เช่น table changes, custom code adaptation',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'หัวข้อที่ต้องการ เช่น "BSEG", "custom code", "table changes", "HANA"' },
                },
                required: ['topic'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_best_practice',
            description: 'ดึง ABAP best practices สำหรับหัวข้อที่ต้องการ เช่น performance, naming, error handling',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: 'หัวข้อ เช่น "SELECT performance", "error handling", "naming convention", "OO"' },
                },
                required: ['topic'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'explain_abap_dump',
            description: 'วิเคราะห์ ABAP runtime error หรือ short dump จาก ST22',
            parameters: {
                type: 'object',
                properties: {
                    error_type: { type: 'string', description: 'ประเภท error เช่น "RAISE_EXCEPTION", "DBIF_RSQL_SQL_ERROR", "DYNPRO_SEND_IN_BACKGROUND"' },
                    context:    { type: 'string', description: 'code หรือ context ที่เกิด error (optional)' },
                },
                required: ['error_type'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'lookup_auth_object',
            description: 'ค้นหาข้อมูล SAP authorization object สำหรับการออกแบบ role ใน PFCG หรือใส่ AUTHORITY-CHECK ใน ABAP — บอก fields, ACTVT values และ use case',
            parameters: {
                type: 'object',
                properties: {
                    object: { type: 'string', description: 'ชื่อ authorization object เช่น "S_TABU_DIS", "S_DEVELOP", "S_TCODE", "S_RFC", "S_BTCH_JOB", "S_DATASET"' },
                    intent: { type: 'string', description: '(optional) สิ่งที่ต้องการทำ เช่น "protect custom table", "restrict program execution"' },
                },
                required: ['object'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'explain_tcode_config',
            description: 'อธิบายว่า T-code ของ SAP ทำงานที่ไหนใน SPRO, เกี่ยวข้องกับ config tables อะไร, และมี enhancement point (BAdI / User Exit) ที่แนะนำ',
            parameters: {
                type: 'object',
                properties: {
                    tcode:  { type: 'string', description: 'SAP Transaction Code เช่น "VA01", "ME21N", "MIGO", "FBN1", "OBYC"' },
                    module: { type: 'string', description: '(optional) SAP module เพื่อช่วย disambiguate เช่น "SD", "MM", "FI", "CO"' },
                },
                required: ['tcode'],
            },
        },
    },
];

// ── Phase 2: OpenAI Assistant (auto-create/load) ───────────
let ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || null;

const ASSISTANT_INSTRUCTIONS = `You are PipekAI, an Expert SAP/ABAP AI Assistant for the SAP S/4HANA system.
You have memory of the entire conversation in this thread — use it to give contextual, accurate answers.

## Your capabilities:
- ABAP Code Generation: reports, classes, function modules, BAPI calls
- Code Review & Best Practices: performance, obsolete syntax, error handling
- Obsolete Statement Detection: TABLES, LIKE, implicit SELECT
- Performance Optimization: SELECT-in-LOOP, full table scan, HANA pushdown
- Error Analysis: ABAP dumps, ST22, runtime exceptions
- Unit Testing: ABAP Unit Test classes
- CDS Views: Interface and Consumption views for Fiori
- RAP / Steampunk: CDS root + BDEF + behavior class + projection + service binding
- Fiori / SAPUI5: manifest.json, XML view, controller, Fiori Elements, OData V2/V4
- Basis & Authorization: PFCG roles, authorization objects, transports, background jobs, system monitoring
- Integration: IDoc (WE02/WE19/BD87), tRFC/qRFC, CPI / Integration Suite, BTP Event Mesh, API Mgmt
- Functional config: SPRO/IMG navigation for FI/MM/SD/CO, enterprise structure, number ranges, output
- Documentation: technical specs, functional specs, code comments
- BAPI/RFC Finder: suggest the most appropriate function module
- General SAP Q&A: modules, configurations, transactions

## Tools available (call them when they help the answer):
- file_search — retrieve from your SAP knowledge base (17 files covering ABAP, RAP, Basis, Integration, SPRO)
- find_bapi, check_abap_syntax, get_transaction_info
- search_s4_migration, get_best_practice, explain_abap_dump
- lookup_auth_object — canonical info for S_TCODE / S_DEVELOP / S_TABU_* / S_RFC etc.
- explain_tcode_config — SPRO path + config tables + recommended BAdI / User Exit for a T-code

## Instructions:
1. Remember all code and context from previous messages in this thread
2. When user says "fix line 5" or "add error handling" — refer to code from earlier in the conversation
3. Always respond in the same language the user used (Thai or English)
4. Format code blocks properly with language tags
5. Be concise but complete — never truncate important code`;

// ── Phase 2: Assistant ──────────────────────────────────────
const fs_mod   = require('fs');
const path_mod = require('path');

async function ensureAssistant(vectorStoreId = null) {
    if (!HAS_API_KEY) return null;
    if (ASSISTANT_ID) {
        // Phase 3: ถ้ามี vector store ใหม่ให้ patch assistant
        if (vectorStoreId) {
            try {
                await openai.beta.assistants.update(ASSISTANT_ID, {
                    tools: PHASE4_TOOLS,
                    tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } }
                });
                console.log(`✅ Assistant patched with vector store + Phase4 tools: ${vectorStoreId}`);
            } catch (e) { console.warn('[assistant] patch failed:', e.message); }
        }
        return ASSISTANT_ID;
    }
    try {
        const createParams = {
            name:         'PetabyteAi SAP Expert',
            instructions: ASSISTANT_INSTRUCTIONS,
            model:        MODEL,
            tools:        PHASE4_TOOLS,
        };
        if (vectorStoreId) {
            createParams.tool_resources = { file_search: { vector_store_ids: [vectorStoreId] } };
        }
        const assistant = await openai.beta.assistants.create(createParams);
        ASSISTANT_ID = assistant.id;
        const envPath = path_mod.join(__dirname, '.env');
        let envContent = fs_mod.readFileSync(envPath, 'utf8');
        if (!envContent.includes('OPENAI_ASSISTANT_ID')) {
            envContent += `\nOPENAI_ASSISTANT_ID=${ASSISTANT_ID}\n`;
            fs_mod.writeFileSync(envPath, envContent);
        }
        console.log(`✅ Assistant created: ${ASSISTANT_ID}`);
        return ASSISTANT_ID;
    } catch (e) {
        console.warn('[assistant] Failed to create:', e.message);
        return null;
    }
}

// ── Phase 3: Vector Store + File Search (RAG) ─────────────
let VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID || null;
const KNOWLEDGE_DIR = path_mod.join(__dirname, 'knowledge');

async function ensureVectorStore() {
    if (!HAS_API_KEY) return null;
    try {
        // สร้าง Vector Store ใหม่ถ้ายังไม่มี
        if (!VECTOR_STORE_ID) {
            const vs = await openai.vectorStores.create({
                name: 'PetabyteAi SAP Knowledge Base',
            });
            VECTOR_STORE_ID = vs.id;
            const envPath = path_mod.join(__dirname, '.env');
            let envContent = fs_mod.readFileSync(envPath, 'utf8');
            if (!envContent.includes('OPENAI_VECTOR_STORE_ID')) {
                envContent += `\nOPENAI_VECTOR_STORE_ID=${VECTOR_STORE_ID}\n`;
                fs_mod.writeFileSync(envPath, envContent);
            }
            console.log(`✅ Vector Store created: ${VECTOR_STORE_ID}`);

            // อัปโหลด knowledge files ทั้งหมด
            await seedKnowledgeFiles();
        } else {
            console.log(`✅ Vector Store loaded: ${VECTOR_STORE_ID}`);
        }
        return VECTOR_STORE_ID;
    } catch (e) {
        console.warn('[vectorStore] Failed:', e.message);
        return null;
    }
}

async function seedKnowledgeFiles() {
    if (!fs_mod.existsSync(KNOWLEDGE_DIR)) return;
    const files = fs_mod.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.txt'));
    console.log(`[☁️ RAG] Uploading ${files.length} knowledge files...`);
    const fileIds = [];
    for (const filename of files) {
        try {
            const filePath = path_mod.join(KNOWLEDGE_DIR, filename);
            const uploaded = await openai.files.create({
                file:    fs_mod.createReadStream(filePath),
                purpose: 'assistants',
            });
            fileIds.push(uploaded.id);
            console.log(`  ✅ Uploaded: ${filename} (${uploaded.id})`);
        } catch (e) {
            console.warn(`  ⚠️  Failed: ${filename}:`, e.message);
        }
    }
    if (fileIds.length > 0) {
        await openai.vectorStores.fileBatches.createAndPoll(
            VECTOR_STORE_ID,
            { file_ids: fileIds }
        );
        console.log(`[☁️ RAG] ✅ All ${fileIds.length} files indexed in vector store`);
    }
}

/**
 * Sync ONLY new knowledge files into the existing vector store.
 * Reads current filenames from the vector store, diffs against local
 * knowledge/*.txt, and uploads whatever is missing. Safe to call on every
 * boot — it's a no-op if there are no new files. Phase 14 extension.
 */
async function syncNewKnowledgeFiles() {
    if (!HAS_API_KEY || !VECTOR_STORE_ID) return;
    if (!fs_mod.existsSync(KNOWLEDGE_DIR)) return;
    try {
        const localFiles = fs_mod.readdirSync(KNOWLEDGE_DIR).filter(f => f.endsWith('.txt'));
        // Enumerate vector store → resolve filenames
        const vsList     = await openai.vectorStores.files.list(VECTOR_STORE_ID);
        const existing   = new Set();
        for (const vf of (vsList?.data || [])) {
            try {
                const meta = await openai.files.retrieve(vf.id);
                if (meta?.filename) existing.add(meta.filename);
            } catch (_) { /* ignore single-file hiccup */ }
        }
        const missing = localFiles.filter(f => !existing.has(f));
        if (missing.length === 0) {
            console.log(`[☁️ RAG] Knowledge base up to date (${localFiles.length} files)`);
            return;
        }
        console.log(`[☁️ RAG] Found ${missing.length} new knowledge file(s): ${missing.join(', ')}`);
        const newIds = [];
        for (const filename of missing) {
            try {
                const uploaded = await openai.files.create({
                    file:    fs_mod.createReadStream(path_mod.join(KNOWLEDGE_DIR, filename)),
                    purpose: 'assistants',
                });
                newIds.push(uploaded.id);
                console.log(`  ✅ Uploaded: ${filename} (${uploaded.id})`);
            } catch (e) {
                console.warn(`  ⚠️  Upload failed for ${filename}:`, e.message);
            }
        }
        if (newIds.length > 0) {
            await openai.vectorStores.fileBatches.createAndPoll(
                VECTOR_STORE_ID,
                { file_ids: newIds }
            );
            console.log(`[☁️ RAG] ✅ Indexed ${newIds.length} new file(s)`);
        }
    } catch (e) {
        console.warn('[syncNewKnowledgeFiles]', e.message);
    }
}

// Startup: init Vector Store → Assistant (async, non-blocking)
if (HAS_API_KEY) {
    ensureVectorStore()
        .then(vsId => ensureAssistant(vsId))
        .then(id  => { if (id) console.log(`✅ System ready: assistant=${id} vs=${VECTOR_STORE_ID}`); })
        .then(()  => syncNewKnowledgeFiles())  // Phase 14: pick up any new knowledge files
        .catch(e  => console.error('[startup]', e.message));
}

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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
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
// key by Bearer token if present, otherwise by IP. Applied to expensive AI endpoints.
const chatRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      CHAT_RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders:   false,
    keyGenerator: (req, res) => {
        // Phase 7: rate-limit keys by token prefix when present (no DB lookup
        // needed in the hot path), otherwise IP. Endpoints that need the real
        // user id are already gated by requireAuth, which populates req.session.
        const tok = (req.headers['authorization'] || '').replace('Bearer ', '');
        if (tok) return `t:${tok.slice(0, 16)}`;
        return `ip:${ipKeyGenerator(req, res)}`;
    },
    handler: (req, res) => {
        const tok = (req.headers['authorization'] || '').replace('Bearer ', '');
        console.warn(`[rate-limit] blocked — token=${tok.slice(0, 8)} ip=${req.ip}`);
        res.status(429).json({ ok: false, error: `Rate limit exceeded. Max ${CHAT_RATE_LIMIT_PER_MIN} requests/min.` });
    },
});

// ══════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════

// Phase 7: brute-force protection on login. Per IP+username so an attacker
// can't burn one user's rate budget for another.
const LOGIN_MAX_PER_15MIN = parseInt(process.env.LOGIN_MAX_PER_15MIN) || 10;
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
        return `${ipKeyGenerator(req, res)}:${u}`;
    },
    handler: (req, res) => {
        console.warn(`[login-rate-limit] blocked ip=${req.ip} user=${req.body?.username}`);
        res.status(429).json({ ok: false, error: 'Too many login attempts. Try again in 15 minutes.' });
    },
});

// POST /api/auth/login
app.post('/api/auth/login', loginRateLimiter, validate(schemas.login), async (req, res) => {
    const { username, password } = req.body;
    try {
        const r = await pool.query(`
            SELECT u.user_id AS id, u.username, u.name, u.surname,
                   u.password AS pw, u.project_id, u.acc_status_id,
                   u.failed_attempts, u.locked_until, u.must_change_password,
                   ro.role_des AS role, ro.role_id,
                   COALESCE(cr.user_credits, 0) AS balance
            FROM tbl_user u
            JOIN tbl_user_role ro ON u.role_id = ro.role_id
            LEFT JOIN tbl_credits cr ON u.user_id = cr.user_id
            WHERE u.username = $1 AND u.is_deleted = FALSE`, [username]);
        // Phase 7: bad-cred / inactive responses use 401 so the
        // rate-limiter (skipSuccessfulRequests:true) actually counts them.
        if (r.rows.length === 0) {
            // Phase 14: log unknown username — no user_id since it doesn't exist.
            logAuthEvent('login_fail', null, req, { reason: 'unknown_user', username });
            return res.status(401).json({ ok: false, error: 'Invalid credentials' });
        }
        const u = r.rows[0];

        // Phase 8: account lockout check (before bcrypt — saves CPU on locked accounts)
        if (u.locked_until && new Date(u.locked_until) > new Date()) {
            const minsLeft = Math.ceil((new Date(u.locked_until) - new Date()) / 60000);
            logAuthEvent('login_blocked', u.id, req, { reason: 'still_locked', mins_left: minsLeft });
            return res.status(423).json({
                ok: false, locked: true,
                error: `Account locked. Try again in ${minsLeft} minute(s).`,
            });
        }

        if (u.acc_status_id !== 1) {
            logAuthEvent('login_blocked', u.id, req, { reason: 'inactive_account', acc_status_id: u.acc_status_id });
            return res.status(403).json({ ok: false, error: 'Account is inactive or locked' });
        }
        const valid = await bcrypt.compare(password, u.pw);

        if (!valid) {
            // Phase 8: increment failed_attempts, lock if over threshold.
            // Single UPDATE so it's atomic; CASE handles the threshold inside SQL.
            const upd = await pool.query(
                `UPDATE tbl_user
                    SET failed_attempts = failed_attempts + 1,
                        locked_until = CASE
                            WHEN failed_attempts + 1 >= $2 THEN NOW() + ($3 || ' minutes')::INTERVAL
                            ELSE locked_until
                        END
                  WHERE user_id = $1
                  RETURNING failed_attempts, locked_until`,
                [u.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES]);
            const row = upd.rows[0];
            if (row.locked_until && new Date(row.locked_until) > new Date()) {
                console.warn(`[lockout] user_id=${u.id} username=${u.username} locked for ${LOCKOUT_MINUTES}min after ${row.failed_attempts} failed attempts`);
                logAuthEvent('lockout', u.id, req, {
                    reason: 'threshold_exceeded',
                    failed_attempts: row.failed_attempts,
                    locked_minutes: LOCKOUT_MINUTES,
                });
                return res.status(423).json({
                    ok: false, locked: true,
                    error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minute(s).`,
                });
            }
            logAuthEvent('login_fail', u.id, req, {
                reason: 'wrong_password',
                failed_attempts: row.failed_attempts,
            });
            return res.status(401).json({ ok: false, error: 'Invalid credentials' });
        }

        // Success — reset counters
        await pool.query(
            `UPDATE tbl_user SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
            [u.id]);

        // Phase 20.3: close any "zombie" login_ok rows for this user.
        //
        // Background: log_out_time gets stamped by POST /api/logout. If a
        // session ended any other way — server crash, browser close, network
        // drop, token natural expiry — the audit row stays with
        // log_out_time = NULL forever, which makes the Login History show
        // "—" instead of the duration.
        //
        // Fix: every time the user logs in, sweep their previous open rows
        // and stamp them at the most plausible end-time:
        //   1) the row's matching tbl_session.last_seen_at  (most accurate)
        //   2) tbl_session.expires_at                       (if still alive but stale)
        //   3) NOW()                                        (last-resort)
        // The COALESCE picks the first non-null candidate.
        await pool.query(`
            UPDATE tbl_audit_log a
            SET log_out_time = COALESCE(
                    (SELECT s.last_seen_at FROM tbl_session s
                     WHERE s.user_id = a.user_id
                     ORDER BY s.last_seen_at DESC LIMIT 1),
                    (SELECT s.expires_at   FROM tbl_session s
                     WHERE s.user_id = a.user_id
                     ORDER BY s.expires_at DESC LIMIT 1),
                    NOW()
                ),
                log_out_date = (COALESCE(
                    (SELECT s.last_seen_at FROM tbl_session s
                     WHERE s.user_id = a.user_id
                     ORDER BY s.last_seen_at DESC LIMIT 1),
                    NOW()
                ))::date
            WHERE a.user_id = $1
              AND a.event_type = 'login_ok'
              AND a.log_out_time IS NULL`,
            [u.id]);

        // Audit log (Phase 14: tagged with event_type='login_ok' via the new column)
        // Phase 16.10.1: log_out_date/time MUST stay NULL until the user really
        // logs out. The legacy INSERT pre-filled them with NOW() — which made it
        // look like every session ended at the same instant it started AND
        // broke the /api/logout UPDATE (which now filters for log_out_time IS
        // NULL to find the row to stamp). Leaving them NULL is the correct
        // semantic: "no logout recorded yet".
        const ipAddr = (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 45);
        await pool.query(`INSERT INTO tbl_audit_log
                (user_id, log_in_date, log_in_time, event_type, detail, ip)
            VALUES ($1, CURRENT_DATE, NOW(), 'login_ok', $2, $3)`,
            [u.id, JSON.stringify({ must_change_password: !!u.must_change_password }), ipAddr]);
        const role = normalizeRole(u.role);
        // Phase 9: createSession returns both session token + per-session CSRF token
        const { token, csrf } = await createSession({ id: u.id, username: u.username, role });
        // Phase 9: HttpOnly cookie. JS cannot read it → safe from XSS theft.
        // Phase 24: session-scoped (no maxAge) so it dies when the browser closes
        // ("close browser = logout"). The server session (tbl_session) keeps its
        // own 24h expiry as a backstop. A readable marker cookie rides alongside
        // so the frontend knows the browser session is still alive.
        res.cookie(SESSION_COOKIE, token, _sessionCookieOpts());
        res.cookie(ACTIVE_COOKIE, '1', _markerCookieOpts());
        res.json({
            ok: true,
            token,                      // Bearer token kept for backward-compat (curl, smoke tests, legacy clients)
            csrfToken: csrf,            // Phase 9: client must echo this in X-CSRF-Token on POST/PUT/DELETE
            mustChangePassword: !!u.must_change_password,    // Phase 8: client redirects to pw-change page
            user: { id: u.id, username: u.username, displayName: `${u.name} ${u.surname}`.trim(),
                    role, plan: role === 'admin' ? 'enterprise' : 'pro',
                    balance: parseFloat(u.balance), projectId: u.project_id,
                    mustChangePassword: !!u.must_change_password },
        });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Helper: บันทึก admin/user action (Phase 14 extended) ─────
// tbl_action_admin.project_id was NOT NULL in older schemas; phase11-003
// relaxes it, and we pass the admin's project_id (may be NULL) so rows
// with a project still record it for reporting.
//
// Phase 14 adds structured detail: action_type, target_type, target_id,
// and a before/after change snapshot (JSONB). All detail params are
// optional for back-compat — the two-arg form `logAdminAction(req)` is
// still valid. Prefer the object form:
//
//   logAdminAction(req, {
//     action: 'update_balance',
//     targetType: 'user', targetId: 42,
//     before: { balance: 100 },
//     after:  { balance: 500 },
//   });
//
// SECURITY: never pass `password`, `password_hash`, CSRF tokens,
// or session tokens inside before/after. The redactor below strips
// them defensively, but the caller is the primary gate.
const REDACT_KEYS = new Set([
    'password', 'password_hash', 'pw', 'pw_hash',
    'csrf_token', 'csrf', 'token', 'bearer', 'session_token',
]);
function _redactSecrets(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (REDACT_KEYS.has(String(k).toLowerCase())) continue;
        out[k] = v;
    }
    return out;
}

async function logAdminAction(req, detail = {}) {
    const sess = req.session;     // populated by requireAuth/requireAdmin
    if (!sess) return;
    try {
        const uRow = await pool.query(
            'SELECT role_id, project_id FROM tbl_user WHERE user_id=$1', [sess.userId]);
        const roleId    = uRow.rows[0]?.role_id    || 1;
        const projectId = uRow.rows[0]?.project_id || null;

        const actionType = detail.action     ? String(detail.action).slice(0, 40)     : null;
        const targetType = detail.targetType ? String(detail.targetType).slice(0, 20) : null;
        const targetId   = Number.isInteger(detail.targetId) ? detail.targetId : null;

        // Build change_json only if either before or after was provided.
        let changeJson = null;
        if (detail.before || detail.after) {
            changeJson = {};
            if (detail.before) changeJson.before = _redactSecrets(detail.before);
            if (detail.after)  changeJson.after  = _redactSecrets(detail.after);
            // Optional free-form extras (e.g. reason, notes)
            if (detail.extra && typeof detail.extra === 'object') {
                changeJson.extra = _redactSecrets(detail.extra);
            }
        } else if (detail.extra && typeof detail.extra === 'object') {
            changeJson = { extra: _redactSecrets(detail.extra) };
        }

        await pool.query(
            `INSERT INTO tbl_action_admin
                (user_id, project_id, role_id, edit_date, edit_time,
                 action_type, target_type, target_id, change_json)
             VALUES ($1, $2, $3, CURRENT_DATE, NOW(), $4, $5, $6, $7)`,
            [sess.userId, projectId, roleId,
             actionType, targetType, targetId,
             changeJson ? JSON.stringify(changeJson) : null]);
    } catch (e) { console.error('[action-log]', e.message); }
}

// ── Helper: audit-log event (Phase 14) ──────────────────────
// Records non-action events (failed login, lockout, logout) in
// tbl_audit_log. user_id may be NULL when the username was unknown.
async function logAuthEvent(eventType, userId, req, detail = {}) {
    try {
        const ip = (req?.headers?.['x-forwarded-for'] || req?.ip || '').toString().slice(0, 45);
        await pool.query(
            `INSERT INTO tbl_audit_log
                (user_id, log_in_date, log_in_time, event_type, detail, ip)
             VALUES ($1, CURRENT_DATE, NOW(), $2, $3, $4)`,
            [userId || null, String(eventType).slice(0, 20),
             detail ? JSON.stringify(_redactSecrets(detail)) : null, ip]);
    } catch (e) { console.error('[audit-log]', e.message); }
}

// POST /api/logout
// Phase 16.6: defensive wrap — every DB call in this handler is best-effort.
// A transient EHOSTUNREACH on tbl_session/tbl_audit_log used to throw an
// unhandled promise rejection from the bare `await getSession(token)` path,
// which Node 24 turns into a process exit. Logout must never crash the server.
app.post('/api/logout', async (req, res) => {
    const token = _extractToken(req);
    let sess = null;
    if (token) {
        try { sess = await getSession(token); }
        catch (e) { console.error('[logout] getSession failed (non-fatal):', e.message); }
    }
    const userId = sess?.userId || req.body.userId;
    if (token) {
        try { await deleteSession(token); }
        catch (e) { console.error('[logout] deleteSession failed (non-fatal):', e.message); }
    }
    // Phase 9: clear the HttpOnly cookie too — browsers won't auto-clear it.
    // Options must match what was set (path/sameSite/secure) or some browsers ignore.
    res.clearCookie(SESSION_COOKIE, _sessionCookieOpts());
    res.clearCookie(ACTIVE_COOKIE, _markerCookieOpts());
    if (userId) {
        try {
            // Phase 16.10: target the exact most-recent login_ok row that
            // hasn't been stamped yet. The legacy query matched on
            // log_in_date (DATE) which mis-targeted when a user logged in
            // multiple times in one day, and didn't filter by event_type so
            // it could stamp a login_fail/lockout row by mistake. As a result
            // the UI showed "still online" for users who'd actually logged
            // out. We now address the single intended row via its PK `id`.
            await pool.query(`
                UPDATE tbl_audit_log
                   SET log_out_date = CURRENT_DATE, log_out_time = NOW()
                 WHERE id = (
                     SELECT id FROM tbl_audit_log
                      WHERE user_id    = $1
                        AND event_type = 'login_ok'
                        AND log_out_time IS NULL
                      ORDER BY log_in_time DESC
                      LIMIT 1
                 )`, [userId]);
        } catch (e) { console.error('[logout] audit-log update failed (non-fatal):', e.message); }
        // Phase 14: also record logout as its own event row for clean history.
        try { logAuthEvent('logout', userId, req, { via: token ? 'token' : 'body' }); }
        catch (e) { console.error('[logout] logAuthEvent failed (non-fatal):', e.message); }
    }
    res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
//  USERS
// ══════════════════════════════════════════════════════════

// GET /api/users — admin only (user list is sensitive). Phase 7: hide soft-deleted.
app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        // Phase 16.10: auto-lock from failed-login attempts only flips
        // `locked_until` — it doesn't change `acc_status_id`. To keep the
        // admin UI honest we expose an `effective_status` derived from BOTH
        // columns: if locked_until is in the future, the user IS effectively
        // locked regardless of their admin-set status. The raw acc_status is
        // still returned so the Edit User modal can show the underlying state.
        const r = await pool.query(`
            SELECT u.user_id AS id, u.username, u.name, u.surname,
                   (u.name || ' ' || u.surname) AS display_name,
                   ro.role_des AS role, ro.role_id,
                   u.project_id, u.created_date AS created_at,
                   u.acc_status_id, a.acc_status,
                   CASE
                       WHEN u.locked_until IS NOT NULL AND u.locked_until > NOW()
                            THEN 'locked'
                       ELSE a.acc_status
                   END AS effective_status,
                   u.locked_until,
                   u.failed_attempts,
                   u.daily_cap,
                   COALESCE(cr.user_credits, 0) AS balance
            FROM tbl_user u
            JOIN tbl_user_role ro ON u.role_id = ro.role_id
            JOIN tbl_acc_status a ON u.acc_status_id = a.acc_status_id
            LEFT JOIN tbl_credits cr ON u.user_id = cr.user_id
            WHERE u.is_deleted = FALSE
            ORDER BY u.user_id ASC`);
        const users = r.rows.map(u => ({ ...u, role: normalizeRole(u.role) }));
        res.json({ ok: true, users });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/users/:id  — single user with balance. Phase 7: hide soft-deleted.
app.get('/api/users/:id', requireAuth, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT u.user_id AS id, u.username, u.name, u.surname,
                   (u.name || ' ' || u.surname) AS display_name,
                   ro.role_des AS role, ro.role_id,
                   u.project_id, u.created_date AS created_at,
                   u.acc_status_id, a.acc_status,
                   u.daily_cap,
                   COALESCE(cr.user_credits, 0) AS balance
            FROM tbl_user u
            JOIN tbl_user_role ro ON u.role_id = ro.role_id
            JOIN tbl_acc_status a ON u.acc_status_id = a.acc_status_id
            LEFT JOIN tbl_credits cr ON u.user_id = cr.user_id
            WHERE u.user_id = $1 AND u.is_deleted = FALSE`, [req.params.id]);
        if (r.rows.length === 0) return res.json({ ok: false, error: 'User not found' });
        const user = { ...r.rows[0], role: normalizeRole(r.rows[0].role) };
        res.json({ ok: true, user });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/users  — create user. Phase 7: enforce password policy on create.
app.post('/api/users', requireAdmin, validate(schemas.createUser), async (req, res) => {
    const { username, password, displayName, role, balance, projectId } = req.body;
    // Strength check is still separate — schema only enforces length range
    const pwErr = validatePasswordStrength(password);
    if (pwErr) return res.status(400).json({ ok: false, error: pwErr });
    const balanceNum = (balance === undefined) ? 0 : balance;
    // Concept B: per-user daily spending limit. null/'' = no cap (unlimited,
    // bounded only by the project pool). Validated by createUserSchema.
    const dailyCap = (req.body.dailyCap === undefined
                       || req.body.dailyCap === null
                       || req.body.dailyCap === '')
        ? null : Number(req.body.dailyCap);

    const roleId = (role === 'admin') ? 1 : 2;
    const [name, ...rest] = (displayName || req.body.name || username).split(' ');
    const surname = req.body.surname || rest.join(' ') || '';
    const projId = projectId || 'proj_sap_dev';
    try {
        const hash = await bcrypt.hash(password, 10);
        // Phase 8: any password an admin chose for a user is "temporary" —
        // force the user to set their own on first login.
        const r = await pool.query(`
            INSERT INTO tbl_user (project_id, role_id, username, password, name, surname, created_date, acc_status_id, must_change_password, daily_cap)
            VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,1,TRUE,$7) RETURNING user_id`,
            [projId, roleId, username, hash, name, surname, dailyCap]);
        const userId = r.rows[0].user_id;
        // Keep a (legacy) tbl_credits row at 0 — not used for billing under
        // Concept B, but some joins still expect one row per user.
        await pool.query(`INSERT INTO tbl_credits (user_id, project_id, user_credits) VALUES ($1,$2,0)
            ON CONFLICT (user_id) DO NOTHING`,
            [userId, projId]);
        logAdminAction(req, {
            action: 'create_user',
            targetType: 'user',
            targetId: userId,
            after: { username, name, surname, role, projectId: projId, daily_cap: dailyCap },
        });
        res.json({ ok: true, id: userId });
    } catch (e) {
        if (e.code === '23505') return res.json({ ok: false, error: 'Username already exists' });
        res.status(500).json({ ok: false, error: e.message });
    }
});

// PUT /api/users/:id  — edit user
app.put('/api/users/:id', requireAdmin, validate(schemas.updateUser), async (req, res) => {
    // Phase 14.2 fix — PARTIAL update. Previously this route rewrote every
    // column with defaults when a field was missing (e.g. sending just
    // {projectId:null} would blank out name/surname/role). Now we only touch
    // columns whose keys actually appear in req.body.
    const b = req.body;
    const has = k => Object.prototype.hasOwnProperty.call(b, k);

    // Derive name/surname only if the caller sent them (or displayName).
    let name, surname, nameChanged = false;
    if (has('name') || has('surname')) {
        name    = has('name')    ? (b.name    || '') : undefined;
        surname = has('surname') ? (b.surname || '') : undefined;
        nameChanged = true;
    } else if (has('displayName')) {
        const parts = (b.displayName || '').split(' ');
        name    = parts[0] || '';
        surname = parts.slice(1).join(' ') || '';
        nameChanged = true;
    }

    // Enforce password policy when admin sets a new password
    if (b.password) {
        const pwErr = validatePasswordStrength(b.password);
        if (pwErr) return res.json({ ok: false, error: pwErr });
    }

    const roleId = has('role') ? (b.role === 'admin' ? 1 : 2) : undefined;
    // projectId: null = unassign, string = assign, undefined = no change
    const projValue = has('projectId')
        ? (b.projectId === null ? null : b.projectId)
        : undefined;
    const balanceNum = has('balance') ? b.balance : undefined;
    const accStatusId = has('accStatusId') ? b.accStatusId : undefined;

    try {
        // Snapshot current values before UPDATE so the audit row records
        // exactly which fields changed (and from what).
        const beforeRows = await pool.query(
            `SELECT u.name, u.surname, u.role_id, u.project_id, u.acc_status_id,
                    COALESCE(cr.user_credits, 0) AS balance
               FROM tbl_user u
               LEFT JOIN tbl_credits cr ON cr.user_id = u.user_id
              WHERE u.user_id = $1 AND u.is_deleted = FALSE`, [req.params.id]);
        const before = beforeRows.rows[0] || null;
        if (!before) return res.json({ ok: false, error: 'User not found' });

        // Build dynamic SET clause — only columns that were actually provided.
        const sets = [], params = [];
        const addSet = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
        if (nameChanged && name    !== undefined) addSet('name',    name);
        if (nameChanged && surname !== undefined) addSet('surname', surname);
        if (roleId      !== undefined) addSet('role_id',       roleId);
        if (projValue   !== undefined) addSet('project_id',    projValue);
        if (accStatusId !== undefined) {
            addSet('acc_status_id', accStatusId);
            // Phase 16.10: switching the account back to active also clears
            // auto-lock state (locked_until + failed_attempts). Without this,
            // an admin who flips the badge from "Locked" → "Active" would still
            // see Locked because `locked_until > NOW()` overrides acc_status.
            if (accStatusId === 1) {
                addSet('locked_until',    null);
                addSet('failed_attempts', 0);
            }
        }
        if (b.password) {
            const hash = await bcrypt.hash(b.password, 10);
            addSet('password', hash);
            // Phase 8: force the target user to pick their own pw next login,
            // unless admin is editing their own row (avoids self-lockout).
            const flipFlag = req.session.userId !== parseInt(req.params.id, 10);
            addSet('must_change_password', flipFlag);
        }

        if (sets.length > 0) {
            params.push(req.params.id);
            await pool.query(
                `UPDATE tbl_user SET ${sets.join(', ')}
                 WHERE user_id = $${params.length} AND is_deleted = FALSE`, params);
        }

        if (balanceNum !== undefined && balanceNum !== null) {
            // Use the project_id the user will have AFTER this update (projValue
            // if provided, else the current value from `before`) so the credits
            // row doesn't orphan to a stale project.
            const credProjId = (projValue !== undefined ? projValue : before.project_id) || 'proj_sap_dev';
            await pool.query(`INSERT INTO tbl_credits (user_id, project_id, user_credits) VALUES ($1,$2,$3)
                ON CONFLICT (user_id) DO UPDATE SET user_credits=$3`,
                [req.params.id, credProjId, balanceNum]);
        }

        // Compose diff — only consider fields that were provided this call
        // AND actually changed. Everything else stays off the audit row.
        const afterSubset = {};
        if (nameChanged && name    !== undefined) afterSubset.name    = name;
        if (nameChanged && surname !== undefined) afterSubset.surname = surname;
        if (roleId      !== undefined) afterSubset.role_id       = roleId;
        if (projValue   !== undefined) afterSubset.project_id    = projValue;
        if (accStatusId !== undefined) afterSubset.acc_status_id = accStatusId;
        if (balanceNum  !== undefined && balanceNum !== null) afterSubset.balance = balanceNum;
        if (b.password) afterSubset.password_reset = true;

        const diffBefore = {}, diffAfter = {};
        for (const k of Object.keys(afterSubset)) {
            const bv = before[k];
            const av = afterSubset[k];
            const norm = v => (v == null ? null : (typeof v === 'number' ? v : String(v)));
            if (norm(bv) !== norm(av)) {
                diffBefore[k] = bv ?? null;
                diffAfter[k]  = av;
            }
        }
        logAdminAction(req, {
            action: 'update_user',
            targetType: 'user',
            targetId: parseInt(req.params.id, 10),
            before: Object.keys(diffBefore).length ? diffBefore : undefined,
            after:  Object.keys(diffAfter).length  ? diffAfter  : undefined,
        });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT /api/users/:id/password  — change own password (auth + self-only)
// Phase 6.1: lets non-admin users change their own password without admin rights.
app.put('/api/users/:id/password', requireAuth, validate(schemas.changePassword), async (req, res) => {
    const targetId = parseInt(req.params.id);
    if (req.session.userId !== targetId && req.session.role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Can only change own password' });
    }
    const { password } = req.body;
    // Phase 7: stronger password policy applied here too
    const pwErr = validatePasswordStrength(password);
    if (pwErr) return res.status(400).json({ ok: false, error: pwErr });
    try {
        const hash = await bcrypt.hash(password, 10);
        // Phase 8: when the user changes THEIR OWN password, clear the
        // must_change_password flag — they've now chosen their own.
        // When an admin resets someone else's password through this route,
        // keep must_change_password as-is (so the target still gets prompted).
        const isSelf = req.session.userId === targetId;
        const r = await pool.query(
            `UPDATE tbl_user
                SET password = $1,
                    must_change_password = CASE WHEN $3::boolean THEN FALSE ELSE must_change_password END
              WHERE user_id = $2 AND is_deleted = FALSE`,
            [hash, targetId, isSelf]);
        if (r.rowCount === 0) return res.json({ ok: false, error: 'User not found' });
        // Phase 14: record every password change — self or admin-reset.
        // Never log the hash or plaintext; REDACT_KEYS strips these
        // defensively, but we don't include them here either.
        logAdminAction(req, {
            action: isSelf ? 'change_own_password' : 'admin_reset_password',
            targetType: 'user',
            targetId,
            extra: { self: isSelf, must_change_password_cleared: isSelf },
        });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT /api/users/:id/balance  — set user's credit allocation.
//
// Phase 16.11: DELTA model.
//   Setting a user's credit moves money between the project pool and the
//   user's wallet. delta = newCredit - oldCredit:
//     delta > 0  ── allocate FROM project pool TO user      (decreases tbl_balance)
//     delta < 0  ── return     FROM user      TO project    (increases tbl_balance)
//     delta = 0  ── no-op (still returns ok)
//
// Rejects (HTTP 200, ok:false, code:'INSUFFICIENT_POOL') when the project
// pool can't cover an increase. We never auto-cap — money operations
// must be explicit. The frontend renders this as a custom modal.
//
// Wrapped in a transaction with SELECT … FOR UPDATE on both rows so two
// admins editing concurrently can't double-spend the pool.
app.put('/api/users/:id/balance', requireAdmin, validate(schemas.setBalance), async (req, res) => {
    const balanceNum = parseFloat(req.body.balance);
    if (isNaN(balanceNum) || balanceNum < 0) {
        return res.json({ ok: false, error: 'balance must be a non-negative number' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Lock the user row only. Postgres rejects `FOR UPDATE` on the
        // nullable side of an outer join (tbl_credits may have no row for
        // a user that's never had credit set), so we restrict the lock to
        // `u`. The upsert on tbl_credits below will acquire its own row
        // lock implicitly when it runs.
        const u = await client.query(
            `SELECT u.user_id, u.project_id, COALESCE(cr.user_credits, 0) AS user_credits
               FROM tbl_user u
               LEFT JOIN tbl_credits cr ON cr.user_id = u.user_id
              WHERE u.user_id = $1 AND u.is_deleted = FALSE
              FOR UPDATE OF u`, [req.params.id]);
        if (u.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, error: 'User not found' });
        }
        const projId  = u.rows[0].project_id;
        const prevBal = parseFloat(u.rows[0].user_credits) || 0;
        const delta   = balanceNum - prevBal;

        // User must be on a project; we have nowhere to debit/credit from otherwise.
        if (!projId) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, error: 'User is not assigned to a project — assign first then set credit' });
        }

        // Lock project pool. LEFT JOIN-style fallback: a project with no top-up
        // history yet has no tbl_balance row → treat pool as 0.
        const pb = await client.query(
            `SELECT project_credits FROM tbl_balance
              WHERE project_id = $1 FOR UPDATE`, [projId]);
        const poolBefore = pb.rows.length ? parseFloat(pb.rows[0].project_credits) : 0;

        // Insufficient pool check (only matters when allocating MORE to user).
        if (delta > 0 && poolBefore < delta) {
            await client.query('ROLLBACK');
            return res.json({
                ok: false,
                code: 'INSUFFICIENT_POOL',
                error: `Project pool only has ฿${poolBefore.toFixed(2)} — cannot allocate ฿${delta.toFixed(2)} more. Top up the project first.`,
                poolAvailable: poolBefore,
                requested:     delta,
            });
        }

        // 1) Upsert user_credits to new value
        await client.query(`
            INSERT INTO tbl_credits (user_id, project_id, user_credits)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE SET user_credits = EXCLUDED.user_credits`,
            [req.params.id, projId, balanceNum]);

        // Phase 21.5 — log every admin balance change as a transaction.
        // Inside the same BEGIN/COMMIT block so the log + balance change
        // land together (or roll back together). delta > 0 → 'topup',
        // delta < 0 → 'adjustment' (admin reducing credit, e.g. correction).
        if (delta !== 0) {
            const txType = delta > 0 ? 'topup' : 'adjustment';
            await client.query(`
                INSERT INTO tbl_user_credit_transaction
                    (user_id, project_id, transaction_type, amount,
                     balance_before, balance_after,
                     ref_type, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, 'admin_edit', $7)`,
                [req.params.id, projId, txType, delta,
                 prevBal, balanceNum, req.session.userId]);
        }

        // 2) Adjust project pool by -delta (if user gets more, pool drops)
        let poolAfter = poolBefore;
        if (delta !== 0) {
            if (pb.rows.length) {
                const r = await client.query(
                    `UPDATE tbl_balance SET project_credits = project_credits - $1,
                                            top_up_date = top_up_date,
                                            top_up_time = top_up_time
                      WHERE project_id = $2
                      RETURNING project_credits`,
                    [delta, projId]);
                poolAfter = parseFloat(r.rows[0].project_credits);
            } else if (delta < 0) {
                // No balance row yet, but user is returning credit → create one with the credit returned
                await client.query(
                    `INSERT INTO tbl_balance (project_id, project_credits, top_up_date, top_up_time, user_id)
                     VALUES ($1, $2, CURRENT_DATE, NOW(), $3)`,
                    [projId, -delta, req.session.userId]);
                poolAfter = -delta;
            }
            // delta > 0 with no pool row already hit the INSUFFICIENT_POOL guard above
        }

        await client.query('COMMIT');

        logAdminAction(req, {
            action: 'update_balance',
            targetType: 'user',
            targetId: parseInt(req.params.id, 10),
            before: { user_credits: prevBal, project_pool: poolBefore },
            after:  { user_credits: balanceNum, project_pool: poolAfter },
            extra:  { delta, project_id: projId },
        });
        res.json({
            ok: true,
            balance: balanceNum,             // new user credit
            projectId: projId,
            projectBalance: poolAfter,       // for UI to refresh project rows
            delta,
        });
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        client.release();
    }
});

// GET /api/credits — Phase 16.11
// Combined view used by the Credit Management table:
//   { username, displayName, projectId, projectName,
//     projectBalance, userCredits, dailyCap }
// One row per non-admin, non-deleted user. The project balance is duplicated
// across users in the same project — that's intentional; the UI needs
// per-row context so we don't N+1 client-side.
app.get('/api/credits', requireAdmin, async (req, res) => {
    try {
        // Phase 21.10 (Concept B): also return today's spend + today's
        // cap bonus so the Cap Management page can show real-time
        // "used today / effective cap" per user. Both are scoped to the
        // Asia/Bangkok calendar day so they reset at local midnight.
        const r = await pool.query(`
            SELECT u.user_id                                      AS "userId",
                   u.username,
                   (u.name || ' ' || u.surname)                   AS "displayName",
                   u.project_id                                   AS "projectId",
                   p.project_name                                 AS "projectName",
                   COALESCE(b.project_credits, 0)                 AS "projectBalance",
                   COALESCE(cr.user_credits, 0)                   AS "userCredits",
                   u.daily_cap                                    AS "dailyCap",
                   COALESCE((SELECT SUM(du.total_price)
                               FROM tbl_daily_usage du
                              WHERE du.user_id = u.user_id
                                AND du.usage_date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date), 0)
                                                                  AS "spentToday",
                   COALESCE(u.bonus_balance, 0)                   AS "bonusBalance",
                   -- Phase 21.11 (Dashboard): lifetime per-user rollups from
                   -- tbl_daily_usage (kept live by the chat handler upsert).
                   COALESCE(lt.tokens,   0)                       AS "lifetimeTokens",
                   COALESCE(lt.spend,    0)                       AS "lifetimeSpend",
                   COALESCE(lt.requests, 0)                       AS "lifetimeRequests"
              FROM tbl_user u
              JOIN tbl_user_role ro ON ro.role_id = u.role_id
              LEFT JOIN tbl_project p  ON p.project_id = u.project_id
              LEFT JOIN tbl_balance b  ON b.project_id = u.project_id
              LEFT JOIN tbl_credits cr ON cr.user_id = u.user_id
              LEFT JOIN (SELECT du.user_id,
                                SUM(du.total_token)   AS tokens,
                                SUM(du.total_price)   AS spend,
                                SUM(du.request_count) AS requests
                           FROM tbl_daily_usage du
                          GROUP BY du.user_id) lt ON lt.user_id = u.user_id
             WHERE u.is_deleted = FALSE AND ro.role_des = 'general user'
             ORDER BY u.user_id ASC`);
        res.json({ ok: true, credits: r.rows });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── Phase 11 B3: daily spending cap ────────────────────────
// PUT /api/users/:id/daily-cap  { dailyCap: number | null }
//   number: hard ceiling in ฿/day; once today's spend reaches it the
//           next /api/chat returns 402 instead of calling OpenAI.
//   null:   no cap (default).
app.put('/api/users/:id/daily-cap', requireAdmin, validate(schemas.dailyCap), async (req, res) => {
    const cap = req.body.dailyCap;
    const capVal = (cap === undefined || cap === null) ? null : cap;
    try {
        // Snapshot previous cap for audit diff
        const prev = await pool.query(
            'SELECT daily_cap FROM tbl_user WHERE user_id=$1 AND is_deleted=FALSE',
            [req.params.id]);
        const prevCap = prev.rows[0]?.daily_cap ?? null;

        const r = await pool.query(
            `UPDATE tbl_user SET daily_cap = $1
             WHERE user_id = $2 AND is_deleted = FALSE
             RETURNING user_id, daily_cap`,
            [capVal, req.params.id]);
        if (r.rowCount === 0) return res.json({ ok: false, error: 'User not found' });
        logAdminAction(req, {
            action: 'update_daily_cap',
            targetType: 'user',
            targetId: parseInt(req.params.id, 10),
            before: { daily_cap: prevCap },
            after:  { daily_cap: capVal },
        });
        res.json({ ok: true, dailyCap: r.rows[0].daily_cap });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Phase 21 A2 — today's spend now reads from tbl_daily_usage, which is
// already pre-aggregated per (date, user, session, model). Replaces the
// older JOIN over tbl_response × tbl_project rates (slower; required
// re-computing cost on every read; missed turns that didn't write to
// tbl_response). The rollup table is updated atomically inside the chat
// transaction so it's always in sync with what user was actually charged.
async function spentToday(userId) {
    const r = await pool.query(`
        SELECT COALESCE(SUM(total_price), 0)::numeric(12,4) AS spent
        FROM tbl_daily_usage
        WHERE user_id = $1
          AND usage_date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date`,
        [userId]);
    return parseFloat(r.rows[0].spent) || 0;
}

// ════════════════════════════════════════════════════════════
// Phase 21.10 — Concept B credit gates
// ════════════════════════════════════════════════════════════
// One pool per project (`tbl_balance.project_credits`) is the only real
// money. Per-user `daily_cap` is a SPENDING LIMIT, not a wallet. A user
// can request a one-day bonus → admin approves → an entry in
// `tbl_daily_cap_bonus` raises today's effective cap.
//
//   effective_cap(user, today) = daily_cap + Σ today's approved bonuses
//
// `checkChatBudget` is the single gate; the chat endpoint calls it before
// touching OpenAI. It distinguishes two failure modes so the UX can show
// different messages (pool empty needs admin top-up; cap reached can be
// waited out or escalated to a quota request).

async function getEffectiveDailyCap(userId) {
    // Phase 21.12 — bonus is now a PERSISTENT balance (tbl_user.bonus_balance),
    // not a today-only sum. effective_cap = daily_cap + bonus_balance.
    // Returns null when the user has no daily_cap configured (unlimited).
    const r = await pool.query(
        `SELECT daily_cap AS base, COALESCE(bonus_balance, 0) AS bonus
           FROM tbl_user
          WHERE user_id = $1 AND is_deleted = FALSE`,
        [userId]);
    if (!r.rowCount) return null;
    const base = r.rows[0].base;
    if (base === null || base === undefined) return null;
    const baseNum  = parseFloat(base);
    const bonusNum = parseFloat(r.rows[0].bonus) || 0;
    return { base: baseNum, bonus: bonusNum, effective: baseNum + bonusNum };
}

async function getProjectPool(projectId) {
    if (!projectId) return 0;
    const r = await pool.query(
        `SELECT COALESCE(project_credits, 0)::numeric AS pool
           FROM tbl_balance WHERE project_id = $1`,
        [projectId]);
    return r.rowCount ? parseFloat(r.rows[0].pool) : 0;
}

async function checkChatBudget(userId) {
    // Returns { ok: true, pool, cap, projectId }  on success,
    //   or   { ok: false, error, message, ... }   on block.
    // Errors:
    //   'project_pool_empty'  — pool ≤ 0 → admin must top up.
    //   'daily_cap_exceeded'  — usage_today ≥ effective cap → wait/request more.
    const u = await pool.query(
        `SELECT project_id FROM tbl_user WHERE user_id=$1 AND is_deleted=FALSE`,
        [userId]);
    const projectId = u.rows[0]?.project_id || null;

    const pool_ = await getProjectPool(projectId);
    if (pool_ <= 0) {
        return {
            ok: false,
            error: 'project_pool_empty',
            message: '⛔ เครดิตโครงการหมด กรุณาติดต่อผู้ดูแลเติมเงิน',
            projectPool: pool_,
            projectId,
        };
    }

    const cap = await getEffectiveDailyCap(userId);
    if (cap !== null) {
        const spent = await spentToday(userId);
        if (spent >= cap.effective) {
            return {
                ok: false,
                error: 'daily_cap_exceeded',
                message: `⛔ คุณใช้ครบโควต้ารายวันแล้ว (฿${spent.toFixed(2)} / ฿${cap.effective.toFixed(2)}) — reset เที่ยงคืน หรือกด "ขอเพิ่มโควต้า"`,
                spentToday:   spent,
                dailyCap:     cap.base,
                bonusBalance: cap.bonus,
                effective:    cap.effective,
                canRequestMore: true,
                projectPool: pool_,
                projectId,
            };
        }
    }
    return { ok: true, projectPool: pool_, cap, projectId };
}

// Phase 21 A1 — active pricing lookup for a model.
// Returns the currently effective price row (input/cached/output) from
// tbl_pricing. Falls back to caller-provided defaults if no row exists
// (e.g. brand-new model not yet seeded). The fallback path also keeps
// older / unit-test callers working when the migration hasn't been
// applied yet. Cached: 30 s in-process map, plenty for a chat workload
// while keeping latency stable when admin edits a price.
const _pricingCache = new Map();   // model → { row, expiresAt }
const PRICING_TTL_MS = 30 * 1000;
async function getActivePricing(model, fallback = {}) {
    const now = Date.now();
    const c = _pricingCache.get(model);
    if (c && c.expiresAt > now) return c.row;

    let row = null;
    try {
        const r = await pool.query(
            `SELECT input_price, cached_price, output_price
             FROM tbl_pricing
             WHERE model = $1
               AND effective_from <= NOW()
               AND (effective_to IS NULL OR effective_to > NOW())
             ORDER BY effective_from DESC LIMIT 1`,
            [model]);
        row = r.rows[0] || null;
    } catch (e) {
        console.warn('[pricing] lookup failed for', model, '—', e.message);
    }
    const fallbackInput  = Number(fallback.inputRate  ?? 0.50);
    const fallbackOutput = Number(fallback.outputRate ?? 1.50);
    const active = {
        inputPrice:  Number(row?.input_price  ?? fallbackInput),
        cachedPrice: Number(row?.cached_price ?? fallbackInput * 0.5),
        outputPrice: Number(row?.output_price ?? fallbackOutput),
        fromDb: !!row,
    };
    _pricingCache.set(model, { row: active, expiresAt: now + PRICING_TTL_MS });
    return active;
}

// GET /api/users/:id/daily-cap-status
//   → { ok, dailyCap, spentToday, remaining, exhausted }
// User can check their own; admin can check anyone.
app.get('/api/users/:id/daily-cap-status', requireAuth, async (req, res) => {
    const uid = parseInt(req.params.id, 10);
    if (!Number.isFinite(uid)) return res.status(400).json({ ok: false, error: 'bad id' });
    if (req.session.role !== 'admin' && req.session.userId !== uid) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    try {
        const u = await pool.query(
            'SELECT daily_cap FROM tbl_user WHERE user_id=$1 AND is_deleted=FALSE',
            [uid]);
        if (u.rows.length === 0) return res.json({ ok: false, error: 'User not found' });
        const cap = u.rows[0].daily_cap === null ? null : parseFloat(u.rows[0].daily_cap);
        const spent = await spentToday(uid);
        const remaining  = cap === null ? null : Math.max(0, cap - spent);
        const exhausted  = cap !== null && spent >= cap;
        res.json({ ok: true, dailyCap: cap, spentToday: spent, remaining, exhausted });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/users/:id  — Phase 7: soft-delete + kill all sessions
// We keep the row for audit; user can no longer log in (login query has
// is_deleted=FALSE filter) and any active tokens are revoked immediately.
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
    const targetId = parseInt(req.params.id);
    if (!Number.isInteger(targetId)) return res.json({ ok: false, error: 'Invalid user id' });
    // Don't let an admin nuke themselves out of the running session
    if (req.session.userId === targetId) {
        return res.json({ ok: false, error: 'Cannot delete your own account' });
    }
    try {
        // Snapshot who's being deleted for audit
        const before = await pool.query(
            'SELECT username, name, surname, role_id, project_id FROM tbl_user WHERE user_id=$1',
            [targetId]);
        const r = await pool.query(
            `UPDATE tbl_user SET is_deleted = TRUE, deleted_at = NOW()
             WHERE user_id = $1 AND is_deleted = FALSE`,
            [targetId]);
        if (r.rowCount === 0) return res.json({ ok: false, error: 'User not found' });
        // Revoke any live sessions for this user
        const sessRows = await pool.query('DELETE FROM tbl_session WHERE user_id = $1', [targetId]);
        logAdminAction(req, {
            action: 'delete_user',
            targetType: 'user',
            targetId,
            before: before.rows[0] || { user_id: targetId },
            extra: { sessions_revoked: sessRows.rowCount || 0 },
        });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  PROJECTS
// ══════════════════════════════════════════════════════════

// GET /api/projects
app.get('/api/projects', requireAuth, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT p.project_id AS id, p.project_name AS name, p.project_api_key,
                   p.description, p.input_rate, p.output_rate, p.credit_limit,
                   p.created_date AS created_at,
                   COALESCE(b.project_credits,        0) AS balance,
                   COALESCE(b.project_credits_amount, 0) AS lifetime_amount
            FROM tbl_project p
            LEFT JOIN tbl_balance b ON p.project_id = b.project_id
            WHERE p.is_deleted = FALSE
            ORDER BY p.created_date ASC`);
        // Phase 16.5 / 17: never leak the full project_api_key to the browser.
        // The frontend only needs to know "does this project have a key?" plus
        // a short preview for the admin to confirm which key is set.
        // Phase 17: column may now be encrypted (`enc:v1:...`) — decrypt once
        // before sniffing prefix/suffix so the preview still shows the real
        // "sk-svcac…XXXX" pattern. Legacy plaintext rows decrypt() returns
        // unchanged so the same path covers both.
        const projects = r.rows.map(p => {
            const raw = cryptoStore.tryDecrypt(p.project_api_key);
            const looksReal = !!raw && /^sk-/i.test(raw);
            return {
                ...p,
                has_api_key: looksReal,
                api_key_preview: looksReal
                    ? raw.slice(0, 8) + '…' + raw.slice(-4)
                    : null,
                project_api_key: undefined, // strip the secret (even encrypted blob)
            };
        });
        res.json({ ok: true, projects });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/projects
// Phase 15: also creates a matching project + service-account on OpenAI so
// every dashboard project owns its own API key. If admin key isn't configured
// or OpenAI rejects the call, the dashboard row still lands — admin can
// manually link it later — so a flaky OpenAI never blocks local provisioning.
app.post('/api/projects', requireAdmin, validate(schemas.createProject), async (req, res) => {
    const { name, projectId, apiKey, description, inputRate, outputRate, creditLimit } = req.body;
    const inRate  = inputRate  !== undefined ? inputRate  : 0.50;
    const outRate = outputRate !== undefined ? outputRate : 1.50;
    const credLim = creditLimit !== undefined ? creditLimit : 0;

    // Phase 16.2: provision the OpenAI project ONLY — do not auto-create a
    // service-account or API key. Rationale: many admins want the project
    // linked at OpenAI for usage tracking & quota isolation, but prefer to
    // generate the API key by hand in the OpenAI dashboard (e.g. user-owned
    // key with explicit "All" permissions, or a SA with custom name/scope).
    //
    // The SA-creation path is preserved in git history (see commit before
    // Phase 16.2) and can be re-enabled per-project later via a dedicated
    // "Generate API key" admin action if desired.
    //
    // Result of this block:
    //   openaiProjectId         → set when admin key is configured & API succeeded
    //   openaiServiceAccountId  → always null (no SA created here)
    //   openaiKey               → always null (admin pastes key later via Edit Project)
    //   openaiError             → message if the project create call failed (non-fatal —
    //                             the dashboard row still lands so admin can recover)
    let openaiProjectId = null;
    let openaiServiceAccountId = null;
    let openaiKey = null;
    let openaiError = null;

    if (openaiAdmin.isEnabled()) {
        try {
            const proj = await openaiAdmin.createProject(name.trim() + ' (dashboard)');
            openaiProjectId = proj.id;
        } catch (e) {
            openaiError = e.message;
            logger?.warn?.({ err: e.message, project: name }, 'openai-admin: project create failed');
        }
    }

    // Phase 15.2: prefer OpenAI's project id as the dashboard PK so
    // tbl_project.project_id == tbl_project.openai_project_id from day one.
    // Fallbacks (in order):
    //   1) the OpenAI id we just received    (preferred — DB and OpenAI agree)
    //   2) admin-supplied projectId          (back-compat for offline mode)
    //   3) generated 'proj_<slug>_<ts>' id   (last resort, e.g. admin key missing)
    const pid = openaiProjectId
        || projectId
        || ('proj_' + name.toLowerCase().replace(/\s+/g,'_').slice(0,20) + '_' + Date.now().toString(36));

    // Pick what to write into project_api_key:
    //   1) the freshly-minted service-account key  (Phase 16.2: never set here anymore)
    //   2) whatever the admin pasted in the form   (backwards-compat path — manual key)
    //   3) NULL                                    (Phase 16.2: prefer null over a fake
    //                                                placeholder. Admin can paste a real
    //                                                key later via Edit Project.)
    // Phase 17: encrypt at rest before INSERT.
    const rawKey = openaiKey || apiKey || null;
    const keyToStore = rawKey ? cryptoStore.encrypt(rawKey) : null;

    try {
        // openai_synced_at = NOW() if we got an id back, else NULL
        const syncedAtSql = openaiProjectId ? 'NOW()' : 'NULL';
        await pool.query(`INSERT INTO tbl_project
            (project_id, project_name, project_api_key, admin_api_key, created_date,
             description, input_rate, output_rate, credit_limit,
             openai_project_id, openai_service_account_id, openai_synced_at)
            VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,$9,$10, ${syncedAtSql})`,
            [pid, name.trim(), keyToStore, 'admin_key_001',
             description || '', inRate, outRate, credLim,
             openaiProjectId, openaiServiceAccountId]);
        await pool.query(`INSERT INTO tbl_balance (project_id, project_credits, top_up_date, top_up_time, user_id)
            VALUES ($1, 0, CURRENT_DATE, NOW(), 1) ON CONFLICT (project_id) DO NOTHING`, [pid]);
        logAdminAction(req, {
            action: 'create_project',
            targetType: 'project',
            // project_id is a string PK — we stash it in extra, not target_id
            after: {
                project_id: pid,
                name: name.trim(),
                input_rate: inRate,
                output_rate: outRate,
                credit_limit: credLim,
                description: description || '',
                ...(openaiProjectId ? {
                    openai_project_id: openaiProjectId,
                    openai_service_account_id: openaiServiceAccountId,
                    openai_synced: true,
                } : {}),
                ...(openaiError ? { openai_sync_error: openaiError } : {}),
            },
        });
        res.json({
            ok: true,
            id: pid,
            openai: openaiProjectId
                ? { project_id: openaiProjectId, service_account_id: openaiServiceAccountId, synced: true }
                : { synced: false, error: openaiError || 'admin key not configured' },
        });
    } catch (e) {
        if (e.code === '23505') return res.json({ ok: false, error: 'Project ID already exists' });
        res.status(500).json({ ok: false, error: e.message });
    }
});

// PUT /api/projects/:id
app.put('/api/projects/:id', requireAdmin, validate(schemas.updateProject), async (req, res) => {
    const { name, apiKey, credits, description, inputRate, outputRate, creditLimit } = req.body;
    const creditsNum = (credits === undefined) ? null : credits;
    // Phase 16.5: distinguish three states for apiKey:
    //   apiKey === undefined       → field omitted: keep existing (COALESCE)
    //   apiKey === null            → admin clicked "Clear": overwrite with NULL
    //   apiKey === 'sk-...'        → admin pasted new key: overwrite
    // The legacy code used `apiKey || null` which collapsed null and '' into
    // "keep existing", making clear-key impossible.
    const apiKeyAction =
        apiKey === undefined ? 'keep'
      : apiKey === null      ? 'clear'
      : (typeof apiKey === 'string' && apiKey.length > 0) ? 'set'
      : 'keep';
    try {
        // Snapshot for diff — also ensures the project exists before UPDATE
        const prev = await pool.query(
            `SELECT p.project_name, p.project_api_key, p.description,
                    p.input_rate, p.output_rate, p.credit_limit,
                    COALESCE(b.project_credits, 0) AS project_credits
               FROM tbl_project p
               LEFT JOIN tbl_balance b ON b.project_id = p.project_id
              WHERE p.project_id = $1`, [req.params.id]);
        const before = prev.rows[0] || null;

        // Build the api_key fragment dynamically so 'clear' can write NULL
        // while 'keep' leaves the column alone.
        // Phase 17: encrypt the new key before writing.
        const apiKeyFrag =
            apiKeyAction === 'set'   ? `project_api_key = $2`
          : apiKeyAction === 'clear' ? `project_api_key = NULL`
          : `project_api_key = project_api_key`;
        const apiKeyParam = apiKeyAction === 'set' ? cryptoStore.encrypt(apiKey) : null;

        const r = await pool.query(`UPDATE tbl_project SET
                project_name      = COALESCE($1, project_name),
                ${apiKeyFrag},
                description       = COALESCE($3, description),
                input_rate        = COALESCE($4, input_rate),
                output_rate       = COALESCE($5, output_rate),
                credit_limit      = COALESCE($6, credit_limit)
             WHERE project_id = $7`,
            [name || null, apiKeyParam, description ?? null,
             (inputRate  !== undefined ? parseFloat(inputRate)  : null),
             (outputRate !== undefined ? parseFloat(outputRate) : null),
             (creditLimit !== undefined ? parseFloat(creditLimit) : null),
             req.params.id]);
        if (r.rowCount === 0) return res.json({ ok: false, error: 'Project not found' });
        // Phase 17.2: drop any cached per-project OpenAI client so the next
        // chat request reads the new key (set or clear) from the DB.
        if (apiKeyAction !== 'keep') invalidateProjectClient(req.params.id);
        if (creditsNum !== null) {
            await pool.query(`INSERT INTO tbl_balance (project_id, project_credits, top_up_date, top_up_time, user_id)
                VALUES ($1, $2, CURRENT_DATE, NOW(), 1)
                ON CONFLICT (project_id) DO UPDATE SET project_credits = EXCLUDED.project_credits,
                    top_up_date = CURRENT_DATE, top_up_time = NOW()`, [req.params.id, creditsNum]);
        }

        // Compute the changed-only subset (api_key is redacted to a boolean)
        const afterFull = {
            project_name: name ?? before?.project_name,
            description:  description ?? before?.description,
            input_rate:   inputRate   !== undefined ? parseFloat(inputRate)   : before?.input_rate,
            output_rate:  outputRate  !== undefined ? parseFloat(outputRate)  : before?.output_rate,
            credit_limit: creditLimit !== undefined ? parseFloat(creditLimit) : before?.credit_limit,
            ...(creditsNum !== null ? { project_credits: creditsNum } : {}),
            ...(apiKeyAction === 'set'   ? { api_key_changed: true } : {}),
            ...(apiKeyAction === 'clear' ? { api_key_cleared: true } : {}),
        };
        const diffBefore = {}, diffAfter = {};
        if (before) {
            for (const k of Object.keys(afterFull)) {
                const bv = before[k];
                const av = afterFull[k];
                const norm = v => (v == null ? null : (typeof v === 'number' ? Number(v) : String(v)));
                if (norm(bv) !== norm(av)) { diffBefore[k] = bv ?? null; diffAfter[k] = av; }
            }
        }
        logAdminAction(req, {
            action: 'update_project',
            targetType: 'project',
            before: Object.keys(diffBefore).length ? diffBefore : undefined,
            after:  Object.keys(diffAfter).length  ? diffAfter  : undefined,
            extra:  { project_id: req.params.id },
        });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/projects/:id  — Phase 7: soft-delete
// Three FKs reference tbl_project: tbl_user.project_id (nullable),
// tbl_balance.project_id (NOT NULL), tbl_response.project_id (NOT NULL).
// We refuse delete if there is chat history (history is user data — never
// silently deleted), unassign users, drop the balance row so the credit
// pool doesn't leak, and mark the project row is_deleted=TRUE for audit.
app.delete('/api/projects/:id', requireAdmin, async (req, res) => {
    const pid = req.params.id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Project must exist and not already be soft-deleted
        const exists = await client.query(
            'SELECT 1 FROM tbl_project WHERE project_id=$1 AND is_deleted = FALSE', [pid]);
        if (exists.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, error: 'Project not found' });
        }
        // Reject if responses (history) reference this project
        const respCheck = await client.query(
            'SELECT COUNT(*)::int AS n FROM tbl_response WHERE project_id=$1', [pid]);
        if (respCheck.rows[0].n > 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: false,
                error: `Project has ${respCheck.rows[0].n} chat history record(s). ` +
                       `Reassign or delete those first.` });
        }
        // Unassign users so the dashboard doesn't show a ghost project
        await client.query('UPDATE tbl_user SET project_id=NULL WHERE project_id=$1', [pid]);
        // Drop per-user credits tied to this project BEFORE tbl_balance
        // because tbl_credits.project_id → tbl_balance.project_id (FK). The
        // project is going away so those credit allocations die with it;
        // users keep their accounts but need to be re-assigned to a project
        // (and re-funded) to spend again.
        await client.query('DELETE FROM tbl_credits WHERE project_id=$1', [pid]);
        // Drop balance row (otherwise credits are still "allocated" to a dead project)
        await client.query('DELETE FROM tbl_balance WHERE project_id=$1', [pid]);
        // Snapshot before soft-delete (also grab the OpenAI link so we can
        // archive on the OpenAI side after COMMIT).
        const beforeProj = await client.query(
            `SELECT project_name, description, openai_project_id
               FROM tbl_project WHERE project_id = $1`, [pid]);
        // Soft-delete the project row
        await client.query(
            `UPDATE tbl_project SET is_deleted = TRUE, deleted_at = NOW() WHERE project_id = $1`,
            [pid]);
        await client.query('COMMIT');

        // Phase 16.5: archive the linked OpenAI project so it doesn't keep
        // showing up on platform.openai.com after the admin "deleted" it.
        // Done AFTER commit — a flaky OpenAI shouldn't roll back the dashboard
        // delete; we just record the failure in the audit log so admin can
        // archive by hand later.
        let openaiArchiveStatus = 'skipped';
        const openaiPid = beforeProj.rows[0]?.openai_project_id;
        if (openaiPid && openaiAdmin.isEnabled()) {
            try {
                const r = await openaiAdmin.archiveProject(openaiPid);
                openaiArchiveStatus = r?.status || 'archived';
            } catch (e) {
                openaiArchiveStatus = 'failed: ' + e.message;
                logger?.warn?.({ err: e.message, project: pid, openaiPid },
                    'openai-admin: archiveProject on delete failed (non-fatal)');
            }
        }

        logAdminAction(req, {
            action: 'delete_project',
            targetType: 'project',
            before: beforeProj.rows[0] || null,
            extra:  { project_id: pid, openai_archive: openaiArchiveStatus },
        });
        res.json({ ok: true, openaiArchiveStatus });
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        client.release();
    }
});

// PUT /api/projects/:id/topup  — add credits to project pool
// Phase 16.1 / 21.2: top-up flow writes to BOTH tbl_balance (current) and
// tbl_topup_project (audit trail — renamed from tbl_topup_history),
// atomically inside a single transaction.
// Prior implementation used a non-transactional UPSERT plus a "revert if cap
// exceeded" UPDATE — fragile under concurrent top-ups (a 2nd request could
// observe an over-cap intermediate state, or the revert could fail leaving
// the cap silently breached). Now: row-locked check → conditional write,
// no revert path needed.
app.put('/api/projects/:id/topup', requireAdmin, validate(schemas.topup), async (req, res) => {
    const amountNum = req.body.amount;
    const note      = (req.body.note || '').toString().trim().slice(0, 500) || null;
    const pid       = req.params.id;
    const adminId   = req.session.userId;
    const client    = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1) Project must exist (and not be soft-deleted)
        const proj = await client.query(
            `SELECT 1 FROM tbl_project WHERE project_id=$1 AND is_deleted = FALSE`, [pid]);
        if (proj.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, error: 'Project not found' });
        }

        // 2) Lock the balance row (or fall through to insert path) so no
        //    concurrent top-up can race past the cap check.
        //    Also read project_credits_amount (Phase 20) so we can bump it
        //    inside the same transaction.
        const lock = await client.query(
            `SELECT project_credits, project_credits_amount
             FROM tbl_balance WHERE project_id=$1 FOR UPDATE`, [pid]);
        const prevBal      = lock.rowCount > 0 ? parseFloat(lock.rows[0].project_credits) : 0;
        const prevLifetime = lock.rowCount > 0 ? parseFloat(lock.rows[0].project_credits_amount || 0) : 0;
        const newBal       = prevBal      + parseFloat(amountNum);
        const newLifetime  = prevLifetime + parseFloat(amountNum);

        // 3) Cap check BEFORE write — cleaner than write-then-revert.
        //    Lifetime amount has NO upper cap (it's a historical accumulator).
        if (newBal > MAX_BALANCE) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, error: `Balance cap exceeded (max ${MAX_BALANCE})` });
        }

        // 4) UPSERT current balance + lifetime amount.
        //    Phase 20: project_credits_amount is monotonically non-decreasing —
        //    on conflict we ADD `amountNum` to the existing value rather than
        //    overwrite with newLifetime (defensive in case the locked row went
        //    out of sync; ADD is order-independent).
        await client.query(
            `INSERT INTO tbl_balance
                (project_id, project_credits, project_credits_amount,
                 top_up_date, top_up_time, user_id)
             VALUES ($1, $2, $3, CURRENT_DATE, NOW(), $4)
             ON CONFLICT (project_id) DO UPDATE SET
                project_credits        = EXCLUDED.project_credits,
                project_credits_amount = tbl_balance.project_credits_amount + $5,
                top_up_date            = CURRENT_DATE,
                top_up_time            = NOW(),
                user_id                = EXCLUDED.user_id`,
            [pid, newBal, newLifetime, adminId, parseFloat(amountNum)]
        );

        // 5) Append to history (one row per top-up event, never updated).
        // Phase 21.2: table renamed tbl_topup_history → tbl_topup_project
        // so the name matches the rest of the project-scoped tables.
        await client.query(
            `INSERT INTO tbl_topup_project
                (project_id, user_id, amount, balance_before, balance_after, note)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [pid, adminId, amountNum, prevBal, newBal, note]
        );

        await client.query('COMMIT');

        // Admin audit log (separate concern — written outside the txn so a
        // logger failure doesn't roll back the financial write)
        logAdminAction(req, {
            action: 'topup_project',
            targetType: 'project',
            before: { project_credits: prevBal,  project_credits_amount: prevLifetime },
            after:  { project_credits: newBal,   project_credits_amount: newLifetime  },
            extra:  { project_id: pid, amount: amountNum, note },
        });
        res.json({ ok: true, newBalance: newBal, lifetimeAmount: newLifetime });
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        client.release();
    }
});

// GET /api/topup-history  — Phase 16.1
//   ?projectId=...   filter to one project (optional)
//   ?limit=N         default 100, max 500
// Returns newest-first. Joins tbl_project + tbl_user so the UI doesn't N+1.
// Open to all admins (requireAdmin); regular users have no business reading
// other projects' financial events.
app.get('/api/topup-history', requireAdmin, async (req, res) => {
    const limit     = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const projectId = req.query.projectId ? String(req.query.projectId).slice(0, 64) : null;
    const where = [], params = [];
    if (projectId) { params.push(projectId); where.push(`h.project_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    try {
        const r = await pool.query(
            `SELECT h.id,
                    h.project_id                                 AS "projectId",
                    p.project_name                               AS "projectName",
                    h.user_id                                    AS "userId",
                    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.name, u.surname)), ''),
                             u.username, '—')                    AS "userName",
                    h.amount,
                    h.balance_before                             AS "balanceBefore",
                    h.balance_after                              AS "balanceAfter",
                    h.note,
                    h.created_at                                 AS "createdAt"
               FROM tbl_topup_project h     -- Phase 21.2: renamed from tbl_topup_history
               LEFT JOIN tbl_project p ON p.project_id = h.project_id
               LEFT JOIN tbl_user    u ON u.user_id    = h.user_id
               ${whereSql}
               ORDER BY h.created_at DESC, h.id DESC
               LIMIT $${params.length}`,
            params
        );
        res.json({ ok: true, data: r.rows });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ══════════════════════════════════════════════════════════
//  AUDIT LOGS
// ══════════════════════════════════════════════════════════

// GET /api/audit-log  — ประวัติ login/logout + failed attempts (Phase 14)
//   ?event=login_fail|login_ok|logout|lockout|login_blocked   filter by event_type
//   ?userId=N   filter by user (still returns NULL-user rows if event also matches)
//   ?limit=N    (default 200, max 1000)
// LEFT JOIN so login_fail rows with unknown username (user_id IS NULL) still show.
app.get('/api/audit-log', requireAdmin, async (req, res) => {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const ev = req.query.event ? String(req.query.event).slice(0, 20) : null;
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    const where = [], params = [];
    if (ev)     { params.push(ev);     where.push(`a.event_type = $${params.length}`); }
    if (userId) { params.push(userId); where.push(`a.user_id    = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    try {
        const r = await pool.query(`
            SELECT a.id, a.user_id,
                   a.log_in_date, a.log_in_time,
                   a.log_out_date, a.log_out_time,
                   a.event_type, a.detail, a.ip,
                   u.username, u.name, u.surname,
                   CASE WHEN u.user_id IS NULL THEN NULL
                        ELSE (u.name || ' ' || u.surname) END AS display_name
            FROM tbl_audit_log a
            LEFT JOIN tbl_user u ON a.user_id = u.user_id
            ${whereSql}
            ORDER BY a.log_in_date DESC, a.log_in_time DESC
            LIMIT $${params.length}`, params);
        res.json({ ok: true, logs: r.rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/action-log  — ประวัติ admin actions (Phase 14: filter + details)
//   ?action=create_user|update_user|...   filter by action_type
//   ?target=user|project                  filter by target_type
//   ?targetId=N                           filter by target_id
//   ?userId=N                             filter by admin user
//   ?limit=N                              default 200, max 1000
app.get('/api/action-log', requireAdmin, async (req, res) => {
    const limit  = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const action = req.query.action  ? String(req.query.action).slice(0, 40) : null;
    const target = req.query.target  ? String(req.query.target).slice(0, 20) : null;
    const targetId = req.query.targetId ? parseInt(req.query.targetId, 10) : null;
    const userId   = req.query.userId   ? parseInt(req.query.userId,   10) : null;
    const where = [], params = [];
    if (action)   { params.push(action);   where.push(`a.action_type = $${params.length}`); }
    if (target)   { params.push(target);   where.push(`a.target_type = $${params.length}`); }
    if (targetId) { params.push(targetId); where.push(`a.target_id   = $${params.length}`); }
    if (userId)   { params.push(userId);   where.push(`a.user_id     = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    try {
        const r = await pool.query(`
            SELECT a.id, a.user_id, a.project_id, a.role_id,
                   a.edit_date, a.edit_time,
                   a.action_type, a.target_type, a.target_id, a.change_json,
                   u.username, u.name, u.surname,
                   (u.name || ' ' || u.surname) AS display_name,
                   ro.role_des,
                   p.project_name
            FROM tbl_action_admin a
            JOIN tbl_user u ON a.user_id = u.user_id
            LEFT JOIN tbl_user_role ro ON a.role_id = ro.role_id
            LEFT JOIN tbl_project p ON u.project_id = p.project_id
            ${whereSql}
            ORDER BY a.edit_date DESC, a.edit_time DESC
            LIMIT $${params.length}`, params);
        res.json({ ok: true, logs: r.rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Phase 11 B4: /api/cost-by-day ───────────────────────────
// Day-level spend aggregate over tbl_response × tbl_project rates.
// Complements the per-user dashboard (renderUsage) — ops wants
// a date-range rollup for budgeting / invoicing.
//   ?days=30   window size (default 30, max 365)
//   ?userId=N  filter to one user (optional)
// Returns one row per day within the window (zero-fills gaps so a
// chart can render without holes).
// ══════════════════════════════════════════════════════════
//  OpenAI Usage Sync (Phase 17.3)
// ══════════════════════════════════════════════════════════
//
// Background job that pulls aggregated usage from OpenAI's Admin API every
// OPENAI_USAGE_SYNC_INTERVAL_MIN minutes and writes it into tbl_daily_token.
// Provides two HTTP endpoints:
//   GET  /api/sync-status   read current sync health + per-project drift
//   POST /api/sync-now      manually trigger one sync run (admin convenience)
//
// Design notes
// ────────────
//   * Date bucket: OpenAI returns UTC unix timestamps. We convert each
//     bucket's start_time to Asia/Bangkok local date (UTC+7) to match the
//     `usage_date_th` column semantics.
//   * UPSERT on (usage_date_th, project_id, model) — the table's new PK
//     after phase17-002. Re-running sync is safe.
//   * Skip rows where project_id from OpenAI is NULL (org-level usage with
//     no project tag — usually internal calls) or doesn't match any active
//     row in tbl_project (orphaned data from deleted projects).
//   * Status is tracked in tbl_sync_state (singleton row id=1). Two
//     dashboards reference it: the sync-status endpoint and an admin-only
//     "Sync Status" UI panel.
const BKK_OFFSET_SEC = 7 * 3600;

function _bkkDate(utcUnix) {
    // Convert UTC unix → Bangkok local "YYYY-MM-DD".
    const d = new Date((utcUnix + BKK_OFFSET_SEC) * 1000);
    return d.toISOString().slice(0, 10);   // already in Bangkok-aligned components
}

let _syncRunning = false;       // simple lock — only one run at a time
let _syncTimer   = null;

async function runUsageSync(reason = 'scheduled') {
    if (_syncRunning) {
        return { skipped: true, reason: 'previous run still in progress' };
    }
    if (!openaiAdmin.isEnabled()) {
        return { skipped: true, reason: 'OPENAI_ADMIN_KEY not configured' };
    }
    _syncRunning = true;
    const startedAt = Date.now();
    let rowsInserted = 0;
    let status = 'ok';
    let errorMsg = null;

    // Optimistic state update — show "running" in UI immediately.
    try {
        await pool.query(
            `UPDATE tbl_sync_state SET last_status='running', updated_at=NOW() WHERE id=1`);
    } catch (_) { /* not fatal */ }

    try {
        // Re-read the trailing 3 days every run — late buckets from "today"
        // can take 5-30 min to land. Idempotent UPSERT covers the overlap.
        const endTime   = Math.floor(Date.now() / 1000);
        const startTime = endTime - 3 * 86400;
        const buckets = await openaiAdmin.fetchUsageCompletions({ startTime, endTime });

        // Pre-fetch active project ids so we can filter out orphaned data.
        const projRows = await pool.query(
            `SELECT project_id FROM tbl_project WHERE is_deleted = FALSE`);
        const activeProj = new Set(projRows.rows.map(r => r.project_id));

        for (const b of buckets) {
            const bktStart = Number(b.start_time);
            const bktEnd   = Number(b.end_time);
            if (!Number.isFinite(bktStart) || !Number.isFinite(bktEnd)) continue;
            const dateStr = _bkkDate(bktStart);

            const results = Array.isArray(b.results) ? b.results : [];
            for (const r of results) {
                const projectId = r.project_id;
                const model     = r.model || 'unknown';
                if (!projectId) continue;                         // skip null project
                if (!activeProj.has(projectId)) continue;         // skip orphans

                // OpenAI uses snake_case fields; pull defensively (fields may be missing).
                const num = k => Number(r[k] || 0);
                await pool.query(`
                    INSERT INTO tbl_daily_token (
                        usage_date_th, project_id,
                        start_time_th, end_time_th, start_time_utc, end_time_utc,
                        model,
                        input_tokens, output_tokens,
                        input_cached_tokens, input_uncached_tokens,
                        input_text_tokens, output_text_tokens, input_cached_text_tokens,
                        input_audio_tokens, input_cached_audio_tokens, output_audio_tokens,
                        input_image_tokens, output_image_tokens
                    ) VALUES (
                        $1, $2,
                        $3, $4, $5, $6,
                        $7,
                        $8, $9,
                        $10, $11,
                        $12, $13, $14,
                        $15, $16, $17,
                        $18, $19
                    )
                    ON CONFLICT (usage_date_th, project_id, model) DO UPDATE SET
                        start_time_th = EXCLUDED.start_time_th,
                        end_time_th   = EXCLUDED.end_time_th,
                        start_time_utc= EXCLUDED.start_time_utc,
                        end_time_utc  = EXCLUDED.end_time_utc,
                        input_tokens  = EXCLUDED.input_tokens,
                        output_tokens = EXCLUDED.output_tokens,
                        input_cached_tokens   = EXCLUDED.input_cached_tokens,
                        input_uncached_tokens = EXCLUDED.input_uncached_tokens,
                        input_text_tokens     = EXCLUDED.input_text_tokens,
                        output_text_tokens    = EXCLUDED.output_text_tokens,
                        input_cached_text_tokens = EXCLUDED.input_cached_text_tokens,
                        input_audio_tokens         = EXCLUDED.input_audio_tokens,
                        input_cached_audio_tokens  = EXCLUDED.input_cached_audio_tokens,
                        output_audio_tokens        = EXCLUDED.output_audio_tokens,
                        input_image_tokens         = EXCLUDED.input_image_tokens,
                        output_image_tokens        = EXCLUDED.output_image_tokens
                `, [
                    dateStr, projectId,
                    bktStart + BKK_OFFSET_SEC, bktEnd + BKK_OFFSET_SEC,
                    bktStart, bktEnd,
                    String(model).slice(0, 20),
                    num('input_tokens'), num('output_tokens'),
                    num('input_cached_tokens'),
                    Math.max(0, num('input_tokens') - num('input_cached_tokens')),  // derived
                    num('input_text_tokens'), num('output_text_tokens'), num('input_cached_text_tokens'),
                    num('input_audio_tokens'), num('input_cached_audio_tokens'), num('output_audio_tokens'),
                    num('input_image_tokens'), num('output_image_tokens'),
                ]);
                rowsInserted++;
            }
            // Stamp openai_synced_at per project that had data in this run
            for (const r of results) {
                if (r.project_id && activeProj.has(r.project_id)) {
                    await pool.query(
                        `UPDATE tbl_project SET openai_synced_at = NOW() WHERE project_id = $1`,
                        [r.project_id]);
                }
            }
        }
    } catch (e) {
        status = 'error';
        errorMsg = String(e.message || e).slice(0, 500);
        logger?.warn?.({ err: errorMsg }, 'usage sync failed');
    } finally {
        _syncRunning = false;
    }

    const durationMs = Date.now() - startedAt;
    try {
        // Note: $4 is used in both an INTEGER column and a BIGINT expression.
        // PG can't infer one consistent type for the same param across those
        // contexts, so we cast it explicitly at each use.
        await pool.query(`
            UPDATE tbl_sync_state SET
                last_run_at        = NOW(),
                last_status        = $1,
                last_error         = $2,
                last_duration_ms   = $3,
                last_rows_inserted = $4::int,
                rows_synced_total  = COALESCE(rows_synced_total, 0) + $4::bigint,
                updated_at         = NOW()
             WHERE id = 1`,
            [status, errorMsg, durationMs, rowsInserted]);
    } catch (e) {
        // Don't crash the sync run for a state-update failure, but DO log
        // it — silent swallow was hiding the bug where state stuck at
        // 'running' forever.
        console.error('[sync] failed to update tbl_sync_state:', e.message);
    }

    console.log(`[sync] ${reason}: status=${status} rows=${rowsInserted} ${durationMs}ms`
        + (errorMsg ? ` err=${errorMsg}` : ''));
    return { status, rowsInserted, durationMs, errorMsg };
}

function startUsageSyncTimer() {
    if (_syncTimer) clearInterval(_syncTimer);
    const mins = Math.max(1, parseInt(process.env.OPENAI_USAGE_SYNC_INTERVAL_MIN, 10) || 15);
    if (!openaiAdmin.isEnabled()) {
        console.log('[sync] OPENAI_ADMIN_KEY not configured — usage sync disabled');
        return;
    }
    // Phase 19.9: auto-sync is opt-in via OPENAI_USAGE_SYNC_ENABLED=true.
    // Default = OFF. tbl_daily_token still exists and `POST /api/sync-now`
    // (admin manual trigger) still works — the timer just doesn't fire
    // by itself, so the app stays quiet until the team explicitly turns
    // automatic sync on. Set the env var to "true" / "1" / "yes" to enable.
    const enabled = /^(1|true|yes|on)$/i.test(String(process.env.OPENAI_USAGE_SYNC_ENABLED || ''));
    if (!enabled) {
        console.log('[sync] auto-sync disabled (set OPENAI_USAGE_SYNC_ENABLED=true to enable). Manual /api/sync-now still works.');
        return;
    }
    console.log(`[sync] usage sync will run every ${mins} min`);
    // First run shortly after boot (don't block startup)
    setTimeout(() => runUsageSync('boot'), 10_000);
    _syncTimer = setInterval(() => runUsageSync('scheduled'), mins * 60_000);
}

// GET /api/sync-status
// Returns the current sync state + per-project usage summary (drift report).
app.get('/api/sync-status', requireAdmin, async (req, res) => {
    try {
        const state = await pool.query(
            `SELECT * FROM tbl_sync_state WHERE id = 1`);
        const projects = await pool.query(`
            SELECT p.project_id, p.project_name,
                   p.openai_synced_at,
                   p.openai_project_id,
                   (SELECT COALESCE(SUM(input_tokens + output_tokens), 0)
                      FROM tbl_daily_token d
                     WHERE d.project_id = p.project_id
                       AND d.usage_date_th >= CURRENT_DATE - 7) AS tokens_7d,
                   (SELECT COALESCE(SUM(input_cached_tokens), 0)
                      FROM tbl_daily_token d
                     WHERE d.project_id = p.project_id
                       AND d.usage_date_th >= CURRENT_DATE - 7) AS cached_7d
              FROM tbl_project p
             WHERE p.is_deleted = FALSE
             ORDER BY p.openai_synced_at DESC NULLS LAST, p.project_name`);
        res.json({
            ok: true,
            state: state.rows[0] || null,
            running: _syncRunning,
            intervalMin: parseInt(process.env.OPENAI_USAGE_SYNC_INTERVAL_MIN, 10) || 15,
            adminKeyConfigured: openaiAdmin.isEnabled(),
            projects: projects.rows,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── Skill prompts registry (Phase 18) ─────────────────────
// GET  /api/skills          — list everything we know about (admin UI list)
// POST /api/skills/reload   — re-read skill-prompts.json from disk

/** Phase 19.3: stronger placeholder detector. Was: only matched content
 *  that started literally with "REPLACE WITH FULL CONTENT". That missed
 *  "TODO: fill in" / "PLACEHOLDER" / one-line stubs etc. Now also flags
 *  any content that's suspiciously short (<50 chars) OR contains known
 *  placeholder markers anywhere in the string. */
function isSkillPlaceholder(content) {
    const c = String(content || '');
    if (c.trim().length < 50) return true;
    if (/REPLACE WITH FULL CONTENT/i.test(c)) return true;
    if (/\bTODO\b.*\b(fill|paste|prompt)\b/i.test(c)) return true;
    if (/\bPLACEHOLDER\b/i.test(c)) return true;
    if (/\bFIXME\b.*\b(prompt|skill)\b/i.test(c)) return true;
    return false;
}

app.get('/api/skills', requireAdmin, (req, res) => {
    try {
        // Strip the full `content` field — could be many KB; admin UI list
        // only needs name/description/preview. Detail view (future) can
        // call a per-skill endpoint if needed.
        const status = skillPrompts.getStatus();
        const skills = skillPrompts.getSkills().map(s => ({
            id:             s.id,
            label:          s.label,
            description:    s.description,
            openaiPromptId: s.openaiPromptId,
            contentPreview: s.content.length > 200 ? s.content.slice(0, 200) + '…' : s.content,
            contentLength:  s.content.length,
            isPlaceholder:  isSkillPlaceholder(s.content),
        }));
        res.json({ ok: true, status, skills });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/skills/reload', requireAdmin, async (req, res) => {
    try {
        await skillPrompts.load();
        const status = skillPrompts.getStatus();
        logAdminAction(req, {
            action: 'reload_skill_prompts',
            targetType: 'system',
            extra: { count: status.count, error: status.error },
        });
        res.json({ ok: true, status });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/skills/:id — full record incl. content (admin edit modal needs it;
// the list endpoint deliberately strips content to keep the payload small).
app.get('/api/skills/:id', requireAdmin, (req, res) => {
    try {
        const s = skillPrompts.getSkill(req.params.id);
        if (!s) return res.status(404).json({ ok: false, error: 'skill not found' });
        res.json({ ok: true, skill: s });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/skills — create or update a skill (Phase 22 prompt management).
// Body: { id, label, description, content, openaiPromptId }. Writes
// skill-prompts.json atomically and hot-reloads the registry so the chat
// router uses the new prompt immediately.
app.post('/api/skills', requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const result = await skillPrompts.upsertSkill({
            id:             body.id,
            label:          body.label,
            description:    body.description,
            content:        body.content,
            openaiPromptId: body.openaiPromptId,
            updatedBy:      (req.session && (req.session.username || req.session.userId)) || 'admin',
        });
        if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
        logAdminAction(req, {
            action: result.created ? 'create_skill_prompt' : 'update_skill_prompt',
            targetType: 'skill',
            targetId: result.skill.id,
            extra: { label: result.skill.label, contentLength: result.skill.content.length },
        });
        res.json({ ok: true, created: result.created, status: skillPrompts.getStatus() });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// DELETE /api/skills/:id — remove a skill from the registry.
app.delete('/api/skills/:id', requireAdmin, async (req, res) => {
    try {
        const result = await skillPrompts.deleteSkill(req.params.id, {
            deletedBy: (req.session && (req.session.username || req.session.userId)) || 'admin',
        });
        if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
        logAdminAction(req, {
            action: 'delete_skill_prompt',
            targetType: 'skill',
            targetId: result.deleted,
        });
        res.json({ ok: true, status: skillPrompts.getStatus() });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/skills/:id/test — admin-only QA sandbox: run a test prompt
// against a skill's system prompt without touching the chat budget gate or
// persisting a tbl_chat_session row. Non-streaming (one-shot QA check, not
// a live chat UX). Supports a short tool-calling loop since some skills
// (find_bapi, lookup_auth_object, etc.) only produce a meaningful answer
// via tool results.
app.post('/api/skills/:id/test', requireAdmin, async (req, res) => {
    if (!HAS_API_KEY) return res.json({ ok: false, error: 'No API key configured' });
    const skill = skillPrompts.getSkill(req.params.id);
    if (!skill) return res.status(404).json({ ok: false, error: 'skill not found' });

    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });

    let systemPrompt = skill.content;
    let userPrompt   = prompt;
    if (systemPrompt.includes('{code}')) {
        systemPrompt = systemPrompt.replace('{code}', prompt);
        userPrompt   = 'Please analyze the ABAP code provided above and apply the corrections.';
    }

    // Phase 34: pick model + effort from the request (validated allowlist),
    // defaulting to the env model. The gpt-5.6 family runs on the Responses API
    // path — reuse runResponsesTurn with a no-op sendEvent to collect the full
    // answer non-streamed; other models use the Chat Completions tool loop.
    const { model: reqModel, path: modelPath } = resolveModel(req.body.model);
    const reqEffort = resolveEffort(req.body.effort);

    const chatTools = PHASE4_TOOLS.filter(t => t.type === 'function');

    let inputTokens = 0, outputTokens = 0, answer = '';
    try {
        if (modelPath === 'responses') {
            const acc = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, fullText: '' };
            await runResponsesTurn({
                oai: openai, userId: req.session.userId, model: reqModel, effort: reqEffort,
                instructions: systemPrompt, userPrompt, tools: chatTools,
                sendEvent: () => {}, acc, isAborted: () => false, setStream: () => {},
            });
            answer = acc.fullText; inputTokens = acc.inputTokens; outputTokens = acc.outputTokens;
        } else {
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt },
            ];
            const MAX_TEST_TOOL_TURNS = 2;
            for (let turn = 0; turn < MAX_TEST_TOOL_TURNS; turn++) {
                const completion = await openai.chat.completions.create({
                    model: reqModel,
                    stream: false,
                    max_completion_tokens: 3000,
                    messages,
                    tools: chatTools,
                    tool_choice: 'auto',
                });
                const choice = completion.choices[0];
                const usage  = completion.usage || {};
                inputTokens  += usage.prompt_tokens     || 0;
                outputTokens += usage.completion_tokens || 0;

                if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
                    messages.push(choice.message);
                    for (const tc of choice.message.tool_calls) {
                        const args   = JSON.parse(tc.function.arguments || '{}');
                        const result = await executeTool(tc.function.name, args);
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
                    }
                    continue;
                }
                answer = choice.message.content || '';
                break;
            }
        }

        logAdminAction(req, {
            action: 'test_skill_prompt',
            targetType: 'skill',
            extra: { skillId: skill.id, model: reqModel, effort: reqEffort, promptPreview: prompt.slice(0, 100), inputTokens, outputTokens },
        });

        res.json({ ok: true, answer, model: reqModel, effort: reqEffort, inputTokens, outputTokens });
    } catch (e) {
        console.error('[skills/test]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/sync-now — manual trigger. Returns the result of THIS run.
app.post('/api/sync-now', requireAdmin, async (req, res) => {
    try {
        const result = await runUsageSync('manual:' + (req.session?.username || 'admin'));
        res.json({ ok: true, ...result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get('/api/cost-by-day', requireAdmin, async (req, res) => {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    try {
        const params = [days];
        let filter = '';
        if (userId) { params.push(userId); filter = 'AND r.user_id = $2'; }
        const q = `
            WITH days AS (
                SELECT generate_series(
                    CURRENT_DATE - ($1::int - 1),
                    CURRENT_DATE,
                    INTERVAL '1 day'
                )::date AS d
            ),
            agg AS (
                SELECT r.created_at::date AS d,
                       COUNT(*)                                                    AS requests,
                       COALESCE(SUM(r.input_tokens),         0)                    AS input_tokens,
                       COALESCE(SUM(r.input_cached_tokens),  0)                    AS cached_tokens,
                       COALESCE(SUM(r.output_tokens),        0)                    AS output_tokens,
                       -- Phase 30: price from tbl_pricing (was tbl_project.input_rate/
                       -- output_rate — the legacy per-project columns, which could
                       -- disagree with tbl_daily_usage / what was actually charged).
                       ROUND(COALESCE(SUM(${PRICING_PRICE_EXPR_RAW}), 0)::numeric, 2) AS cost
                FROM tbl_response r
                JOIN tbl_project  p ON p.project_id = r.project_id
                ${PRICING_LATERAL_JOIN}
                WHERE r.created_at::date >= CURRENT_DATE - ($1::int - 1)
                  ${filter}
                GROUP BY r.created_at::date
            )
            SELECT d.d AS date,
                   COALESCE(a.requests,      0) AS requests,
                   COALESCE(a.input_tokens,  0) AS input_tokens,
                   COALESCE(a.cached_tokens, 0) AS cached_tokens,
                   COALESCE(a.output_tokens, 0) AS output_tokens,
                   COALESCE(a.cost,          0) AS cost
            FROM days d LEFT JOIN agg a ON a.d = d.d
            ORDER BY d.d ASC`;
        const r = await pool.query(q, params);
        const rows = r.rows.map(x => ({
            date:         x.date instanceof Date ? x.date.toISOString().slice(0, 10) : x.date,
            requests:     parseInt(x.requests, 10),
            inputTokens:  parseInt(x.input_tokens, 10),
            cachedTokens: parseInt(x.cached_tokens, 10),
            outputTokens: parseInt(x.output_tokens, 10),
            cost:         parseFloat(x.cost),
        }));
        const total = rows.reduce((s, x) => ({
            requests:     s.requests     + x.requests,
            inputTokens:  s.inputTokens  + x.inputTokens,
            cachedTokens: s.cachedTokens + x.cachedTokens,
            outputTokens: s.outputTokens + x.outputTokens,
            cost:         s.cost         + x.cost,
        }), { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 });
        res.json({ ok: true, days, userId, total, rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  USAGE HISTORY
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
//  TRANSACTION JOURNAL (Phase 21.5)
// ══════════════════════════════════════════════════════════
// GET /api/transactions
//   ?projectId=  filter by project (optional — admin only)
//   ?from=YYYY-MM-DD  inclusive start (default: today - 7 days for day mode)
//   ?to=YYYY-MM-DD    inclusive end   (default: today)
//   ?groupBy=day|month  default 'day'
//   ?limit=  cap rows (default 200, max 1000)
//
// Reads through v_user_credit_transaction so the JOINs to user/project
// already include display_name + project_name. day mode returns rows
// 1:1 with the underlying journal; month mode aggregates per
// (month, user, type).
app.get('/api/transactions', requireAdmin, async (req, res) => {
    const groupBy = (req.query.groupBy === 'month') ? 'month' : 'day';
    const limit   = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 1000);

    // Date defaults: keep it tight so the default load is fast.
    const today   = new Date();
    const tzShift = 7 * 60 * 60 * 1000;             // shift UTC → Bangkok for date math
    const todayBkk = new Date(today.getTime() + tzShift).toISOString().slice(0, 10);
    const dShift = (days) => new Date(today.getTime() + tzShift - days * 86400000)
                              .toISOString().slice(0, 10);
    const defaultFrom = groupBy === 'month' ? dShift(60) : dShift(6);
    const from = String(req.query.from || defaultFrom).slice(0, 10);
    const to   = String(req.query.to   || todayBkk).slice(0, 10);

    // Optional project filter
    const projFilter = (req.query.projectId || '').trim();
    const params = [from, to, limit];
    let projWhere = '';
    if (projFilter) {
        params.push(projFilter);
        projWhere = ` AND project_id = $${params.length}`;
    }

    // Hide smoke/throwaway test users by default. Pass ?includeTest=1
    // to bring them back (for debugging only).
    // Patterns matched (anchored prefixes, case-insensitive):
    //   smoke_*, p7_victim_*, delme_*, fix_*, om_*, pm_*, pm2_*,
    //   test1, test2, testuser, testuser2
    let testWhere = '';
    if (req.query.includeTest !== '1') {
        testWhere = `
            AND username !~* '^(smoke_|p7_victim_|delme_|fix_|om_|pm_|pm2_)'
            AND username NOT IN ('test1','test2','testuser','testuser2')
        `;
    }

    try {
        let rows;
        if (groupBy === 'month') {
            // Aggregate: (month, user, type) → sum amount, count events
            const sql = `
                SELECT
                    TO_CHAR(tx_month, 'FMMonth YYYY')    AS period_label,
                    tx_month                              AS period_key,
                    user_id,
                    username,
                    display_name,
                    project_id,
                    project_name,
                    type,
                    COUNT(*)::int                         AS event_count,
                    SUM(amount_display)::numeric(12, 2)   AS amount
                FROM v_user_credit_transaction
                WHERE tx_month >= $1::date
                  AND tx_month <= $2::date
                  ${projWhere}
                  ${testWhere}
                GROUP BY tx_month, user_id, username, display_name,
                         project_id, project_name, type
                ORDER BY tx_month DESC, amount DESC
                LIMIT $3`;
            const r = await pool.query(sql, params);
            rows = r.rows;
        } else {
            // Per-event detail
            const sql = `
                SELECT
                    transaction_id,
                    tx_date,
                    created_at,
                    user_id,
                    username,
                    display_name,
                    project_id,
                    project_name,
                    type,
                    amount_signed,
                    amount_display                        AS amount,
                    balance_before,
                    balance_after,
                    ref_type,
                    ref_id,
                    note,
                    created_by_username
                FROM v_user_credit_transaction
                WHERE tx_date >= $1::date
                  AND tx_date <= $2::date
                  ${projWhere}
                  ${testWhere}
                ORDER BY created_at DESC
                LIMIT $3`;
            const r = await pool.query(sql, params);
            rows = r.rows;
        }
        res.json({
            ok:       true,
            groupBy,
            from, to,
            projectId: projFilter || null,
            count:    rows.length,
            rows,
        });
    } catch (e) {
        console.error('[transactions]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/transactions/export?format=csv|xlsx&groupBy=day|month&from=&to=&projectId=
// Phase 21.7 — Download the same dataset shown in "Transaction by Date" as
// a CSV or Excel file. Reuses the v_user_credit_transaction view and the
// same test-user filter as /api/transactions so the export matches what
// the admin sees on screen.
app.get('/api/transactions/export', requireAdmin, async (req, res) => {
    const format  = (req.query.format === 'xlsx') ? 'xlsx' : 'csv';
    const groupBy = (req.query.groupBy === 'month') ? 'month' : 'day';

    // Date defaults — same logic as /api/transactions
    const today    = new Date();
    const tzShift  = 7 * 60 * 60 * 1000;
    const todayBkk = new Date(today.getTime() + tzShift).toISOString().slice(0, 10);
    const dShift   = (d) => new Date(today.getTime() + tzShift - d * 86400000)
                              .toISOString().slice(0, 10);
    const defaultFrom = groupBy === 'month' ? dShift(60) : dShift(6);
    const from = String(req.query.from || defaultFrom).slice(0, 10);
    const to   = String(req.query.to   || todayBkk).slice(0, 10);

    const projFilter = (req.query.projectId || '').trim();
    const params = [from, to];
    let projWhere = '';
    if (projFilter) {
        params.push(projFilter);
        projWhere = ` AND project_id = $${params.length}`;
    }
    let testWhere = '';
    if (req.query.includeTest !== '1') {
        testWhere = `
            AND username !~* '^(smoke_|p7_victim_|delme_|fix_|om_|pm_|pm2_)'
            AND username NOT IN ('test1','test2','testuser','testuser2')
        `;
    }

    try {
        let rows, columns, sheetName, fileBase;

        if (groupBy === 'month') {
            const sql = `
                SELECT
                    TO_CHAR(tx_month, 'YYYY-MM')         AS period,
                    username,
                    display_name                          AS name,
                    project_name                          AS project,
                    type,
                    COUNT(*)::int                         AS event_count,
                    SUM(amount_display)::numeric(12, 2)   AS amount
                FROM v_user_credit_transaction
                WHERE tx_month >= $1::date
                  AND tx_month <= $2::date
                  ${projWhere}
                  ${testWhere}
                GROUP BY tx_month, user_id, username, display_name,
                         project_id, project_name, type
                ORDER BY tx_month DESC, amount DESC`;
            rows = (await pool.query(sql, params)).rows;
            columns = [
                { header: 'Period',      key: 'period',      width: 12 },
                { header: 'Username',    key: 'username',    width: 22 },
                { header: 'Name',        key: 'name',        width: 24 },
                { header: 'Project',     key: 'project',     width: 22 },
                { header: 'Type',        key: 'type',        width: 12 },
                { header: 'Events',      key: 'event_count', width: 10 },
                { header: 'Amount',      key: 'amount',      width: 14 },
            ];
            sheetName = 'Monthly';
            fileBase  = `transactions-month-${from}-to-${to}`;
        } else {
            const sql = `
                SELECT
                    TO_CHAR(tx_date, 'YYYY-MM-DD')        AS date,
                    TO_CHAR(created_at AT TIME ZONE 'Asia/Bangkok',
                            'YYYY-MM-DD HH24:MI:SS')      AS created_at,
                    username,
                    display_name                          AS name,
                    project_name                          AS project,
                    type,
                    amount_signed                         AS amount,
                    balance_before,
                    balance_after,
                    ref_type,
                    ref_id,
                    note,
                    created_by_username                   AS created_by
                FROM v_user_credit_transaction
                WHERE tx_date >= $1::date
                  AND tx_date <= $2::date
                  ${projWhere}
                  ${testWhere}
                ORDER BY created_at DESC`;
            rows = (await pool.query(sql, params)).rows;
            columns = [
                { header: 'Date',         key: 'date',           width: 12 },
                { header: 'Time',         key: 'created_at',     width: 20 },
                { header: 'Username',     key: 'username',       width: 22 },
                { header: 'Name',         key: 'name',           width: 24 },
                { header: 'Project',      key: 'project',        width: 22 },
                { header: 'Type',         key: 'type',           width: 12 },
                { header: 'Amount',       key: 'amount',         width: 12 },
                { header: 'Balance Before', key: 'balance_before', width: 14 },
                { header: 'Balance After',  key: 'balance_after',  width: 14 },
                { header: 'Ref Type',     key: 'ref_type',       width: 14 },
                { header: 'Ref ID',       key: 'ref_id',         width: 10 },
                { header: 'Note',         key: 'note',           width: 30 },
                { header: 'Created By',   key: 'created_by',     width: 16 },
            ];
            sheetName = 'Day';
            fileBase  = `transactions-day-${from}-to-${to}`;
        }

        if (format === 'csv') {
            // Simple CSV writer — proper escaping for commas/quotes/newlines.
            // BOM prefix so Excel opens UTF-8 (Thai names) correctly.
            const esc = (v) => {
                if (v === null || v === undefined) return '';
                const s = String(v);
                return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const lines = [columns.map(c => esc(c.header)).join(',')];
            for (const r of rows) {
                lines.push(columns.map(c => esc(r[c.key])).join(','));
            }
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition',
                `attachment; filename="${fileBase}.csv"`);
            res.send('﻿' + lines.join('\r\n'));
            return;
        }

        // xlsx via exceljs
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        wb.creator = 'PetabyteAi';
        wb.created = new Date();
        const ws = wb.addWorksheet(sheetName, {
            views: [{ state: 'frozen', ySplit: 1 }],
        });
        ws.columns = columns;
        ws.addRows(rows);

        // Header styling — Petabyte accent
        const headerRow = ws.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = {
            type: 'pattern', pattern: 'solid',
            fgColor: { argb: 'FF2563EB' },
        };
        headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
        headerRow.height = 22;

        // Number formats for money columns
        if (groupBy === 'month') {
            ws.getColumn('amount').numFmt = '#,##0.00';
            ws.getColumn('event_count').alignment = { horizontal: 'right' };
        } else {
            ws.getColumn('amount').numFmt = '+#,##0.0000;-#,##0.0000;0';
            ws.getColumn('balance_before').numFmt = '#,##0.00';
            ws.getColumn('balance_after').numFmt  = '#,##0.00';
        }
        ws.autoFilter = {
            from: { row: 1, column: 1 },
            to:   { row: 1, column: columns.length },
        };

        res.setHeader('Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition',
            `attachment; filename="${fileBase}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) {
        console.error('[transactions/export]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ════════════════════════════════════════════════════════════
// Phase 21.10 — Quota request workflow (Concept B)
// ════════════════════════════════════════════════════════════
// Flow:
//   user hits daily cap → POST /api/quota-requests (creates pending row)
//   admin sees the list → POST /api/quota-requests/:id/resolve {action:'approve'|'deny'}
//   approve  → INSERT tbl_daily_cap_bonus for TODAY (Bangkok) → effective cap rises
//   deny     → just updates status; cap unchanged
// One pending request per (user, today). Re-asking on the same day after a
// deny is allowed (creates a new request).

// POST /api/quota-requests   — user requests a temporary cap increase
app.post('/api/quota-requests', requireAuth, async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const requestedExtra = parseFloat(req.body?.requestedExtra);
    const reason = String(req.body?.reason || '').slice(0, 500);
    if (!Number.isFinite(requestedExtra) || requestedExtra <= 0 || requestedExtra > 10000) {
        return res.status(400).json({ ok: false, error: 'invalid_amount',
            message: 'requestedExtra must be > 0 and ≤ 10000' });
    }
    try {
        // Prevent piling up pending requests for the same user today.
        const dup = await pool.query(`
            SELECT request_id FROM tbl_quota_request
             WHERE user_id = $1
               AND status   = 'pending'
               AND created_at::date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date`,
            [uid]);
        if (dup.rowCount) {
            return res.status(409).json({
                ok: false,
                error: 'pending_request_exists',
                message: 'You already have a pending request — wait for an admin to respond first',
                requestId: dup.rows[0].request_id,
            });
        }
        const u = await pool.query(
            `SELECT project_id FROM tbl_user WHERE user_id=$1 AND is_deleted=FALSE`, [uid]);
        const projectId = u.rows[0]?.project_id;
        if (!projectId) return res.status(400).json({ ok: false, error: 'no_project' });

        const r = await pool.query(`
            INSERT INTO tbl_quota_request (user_id, project_id, requested_extra, reason)
            VALUES ($1, $2, $3, $4)
            RETURNING request_id, status, created_at`,
            [uid, projectId, requestedExtra, reason || null]);
        res.json({ ok: true, request: r.rows[0] });
    } catch (e) {
        console.error('[quota-request:create]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/quota-requests        — list (admin sees all, user sees own)
//   ?status=pending|approved|denied   (default: all)
//   ?limit=50
app.get('/api/quota-requests', requireAuth, async (req, res) => {
    const uid = req.session?.userId;
    const role = req.session?.role;
    const isAdmin = role === 'admin' || role === 'superadmin';
    const status = ['pending','approved','denied','cancelled'].includes(req.query.status)
        ? req.query.status : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);

    const params = [];
    let where = '1=1';
    if (!isAdmin) { params.push(uid); where += ` AND q.user_id = $${params.length}`; }
    if (status)   { params.push(status); where += ` AND q.status = $${params.length}`; }
    params.push(limit);

    try {
        const r = await pool.query(`
            SELECT q.request_id, q.user_id, q.project_id, q.requested_extra,
                   q.reason, q.status, q.created_at, q.resolved_by, q.resolved_at, q.resolved_note,
                   COALESCE(NULLIF(TRIM(CONCAT(u.name,' ',u.surname)),''), u.username) AS user_display,
                   u.username, p.project_name,
                   COALESCE(NULLIF(TRIM(CONCAT(au.name,' ',au.surname)),''), au.username) AS resolved_by_display
              FROM tbl_quota_request q
              JOIN tbl_user u      ON u.user_id = q.user_id
              LEFT JOIN tbl_user au ON au.user_id = q.resolved_by
              LEFT JOIN tbl_project p ON p.project_id = q.project_id
             WHERE ${where}
             ORDER BY (q.status='pending') DESC, q.created_at DESC
             LIMIT $${params.length}`, params);
        res.json({ ok: true, requests: r.rows, count: r.rowCount });
    } catch (e) {
        console.error('[quota-request:list]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/quota-requests/:id/resolve   { action: 'approve' | 'deny', note?: '' }
//   admin-only.  approve → grant today-only bonus.
app.post('/api/quota-requests/:id/resolve', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const action = req.body?.action;
    const note   = String(req.body?.note || '').slice(0, 500) || null;
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_id' });
    }
    if (action !== 'approve' && action !== 'deny') {
        return res.status(400).json({ ok: false, error: 'invalid_action',
            message: "action must be 'approve' or 'deny'" });
    }
    const adminId = req.session?.userId;
    const client  = await pool.connect();
    try {
        await client.query('BEGIN');
        const r = await client.query(
            `SELECT request_id, user_id, project_id, requested_extra, status
               FROM tbl_quota_request WHERE request_id=$1 FOR UPDATE`, [id]);
        if (!r.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ ok: false, error: 'not_found' });
        }
        const q = r.rows[0];
        if (q.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(409).json({ ok: false, error: 'already_resolved',
                message: `This request was already ${q.status}` });
        }

        const newStatus = action === 'approve' ? 'approved' : 'denied';
        await client.query(
            `UPDATE tbl_quota_request
                SET status=$1, resolved_by=$2, resolved_at=NOW(), resolved_note=$3
              WHERE request_id=$4`,
            [newStatus, adminId, note, id]);

        let bonus = null;
        let newBalance = null;
        if (action === 'approve') {
            // Historical grant log (audit trail of every approval).
            const ins = await client.query(`
                INSERT INTO tbl_daily_cap_bonus
                    (user_id, bonus_date, extra_amount, granted_by, request_id, note)
                VALUES ($1, (NOW() AT TIME ZONE 'Asia/Bangkok')::date, $2, $3, $4, $5)
                ON CONFLICT (user_id, bonus_date, request_id) DO NOTHING
                RETURNING bonus_id, bonus_date, extra_amount`,
                [q.user_id, q.requested_extra, adminId, id, note]);
            bonus = ins.rows[0] || null;
            // Phase 21.12 — credit the PERSISTENT bonus balance. This is the
            // live spendable figure; it carries over until consumed.
            const bal = await client.query(
                `UPDATE tbl_user
                    SET bonus_balance = COALESCE(bonus_balance, 0) + $1
                  WHERE user_id = $2
                  RETURNING bonus_balance`,
                [q.requested_extra, q.user_id]);
            newBalance = bal.rows[0] ? parseFloat(bal.rows[0].bonus_balance) : null;
        }

        await client.query('COMMIT');
        logAdminAction(req, {
            action: action === 'approve' ? 'approve_quota_request' : 'deny_quota_request',
            targetType: 'quota_request',
            targetId: id,
            extra: { user_id: q.user_id, requested_extra: q.requested_extra, note },
        });
        res.json({ ok: true, requestId: id, status: newStatus, bonus, bonusBalance: newBalance });
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[quota-request:resolve]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    } finally { client.release(); }
});

// GET /api/quota-status     — current user's gate snapshot (for UI banners)
// Returns the same info checkChatBudget would, without consuming anything.
app.get('/api/quota-status', requireAuth, async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return res.status(401).json({ ok: false, error: 'unauthorized' });
    try {
        const cap = await getEffectiveDailyCap(uid);
        const u = await pool.query(`SELECT project_id FROM tbl_user WHERE user_id=$1`, [uid]);
        const projectId = u.rows[0]?.project_id;
        const pool_ = await getProjectPool(projectId);
        const spent = await spentToday(uid);
        const ratio = cap ? Math.min(1, spent / cap.effective) : null;
        res.json({
            ok: true,
            projectId,
            projectPool: pool_,
            poolEmpty:   pool_ <= 0,
            dailyCap:     cap ? cap.base : null,
            bonusBalance: cap ? cap.bonus : 0,
            effectiveCap: cap ? cap.effective : null,
            spentToday:  spent,
            remaining:   cap ? Math.max(0, cap.effective - spent) : null,
            usageRatio:  ratio,             // 0-1, null if no cap
            warning80:   cap ? ratio >= 0.8 : false,
            capExceeded: cap ? spent >= cap.effective : false,
        });
    } catch (e) {
        console.error('[quota-status]', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/history?userId=1
// Phase 6 fix: was joining r.project_id = u.project_id, which leaked history across
// users sharing a project. Now joins on r.user_id directly.
// Phase 30: shared LATERAL join that finds the tbl_pricing row active at
// r.created_at for r.model — same rate-resolution logic as
// fn_build_daily_usage() (the function that feeds tbl_daily_usage /
// spentToday(), i.e. the numbers actually deducted from the pool). Every
// endpoint that displays a cost to users now joins through this instead of
// the legacy tbl_project.input_rate/output_rate columns, so the numbers
// agree everywhere instead of drifting between two rate sources.
const PRICING_LATERAL_JOIN = `
    LEFT JOIN LATERAL (
        SELECT pr2.*
        FROM tbl_pricing pr2
        WHERE pr2.model = r.model
        ORDER BY
            (CASE WHEN pr2.effective_from <= (r.created_at AT TIME ZONE 'Asia/Bangkok')
                   AND (pr2.effective_to IS NULL OR pr2.effective_to > (r.created_at AT TIME ZONE 'Asia/Bangkok'))
                  THEN 0 ELSE 1 END),
            ABS(EXTRACT(EPOCH FROM (pr2.effective_from - (r.created_at AT TIME ZONE 'Asia/Bangkok'))))
        LIMIT 1
    ) pr ON TRUE`;
// Raw (unrounded) per-row price — for SUM(...) aggregates, round the total
// once at the end (matches fn_build_daily_usage's ROUND(SUM(...), n)
// pattern) rather than rounding each row first and compounding drift.
const PRICING_PRICE_EXPR_RAW = `
    (
        (GREATEST(r.input_tokens - COALESCE(r.input_cached_tokens, 0), 0) / 1000.0)
            * COALESCE(pr.input_price, 0.50)
      + (COALESCE(r.input_cached_tokens, 0) / 1000.0)
            * COALESCE(pr.cached_price, COALESCE(pr.input_price, 0.50) * 0.5)
      + (r.output_tokens / 1000.0)
            * COALESCE(pr.output_price, 1.50)
    )`;
// Per-row display value (e.g. one line in a history table) — rounded to 2dp.
const PRICING_COST_EXPR = `ROUND((${PRICING_PRICE_EXPR_RAW})::numeric, 2)`;

app.get('/api/history', requireAuth, async (req, res) => {
    // Phase 16.9: aliases so the legacy frontend (which reads h.prompt /
    // h.response / h.cost) keeps working despite tbl_response naming the
    // columns input_param / output_param and not storing cost at all.
    // Cost is COMPUTED here from token counts × tbl_pricing (Phase 30 —
    // was tbl_project.input_rate/output_rate, which could disagree with
    // what was actually charged).
    try {
        const { userId } = req.query;
        let r;
        if (userId) {
            r = await pool.query(`
                SELECT r.*,
                       r.input_param  AS prompt,
                       r.output_param AS response,
                       r.input_cached_tokens     AS cached_tokens,
                       r.output_reasoning_tokens AS reasoning_tokens,
                       ${PRICING_COST_EXPR} AS cost,
                       u.username, (u.name||' '||u.surname) AS display_name
                FROM tbl_response r
                LEFT JOIN tbl_user    u ON r.user_id    = u.user_id
                LEFT JOIN tbl_project p ON r.project_id = p.project_id
                ${PRICING_LATERAL_JOIN}
                WHERE r.user_id = $1
                ORDER BY r.created_at DESC LIMIT 100`, [userId]);
        } else {
            r = await pool.query(`
                SELECT r.*, p.project_name,
                       r.input_param  AS prompt,
                       r.output_param AS response,
                       r.input_cached_tokens     AS cached_tokens,
                       r.output_reasoning_tokens AS reasoning_tokens,
                       ${PRICING_COST_EXPR} AS cost,
                       u.username, (u.name||' '||u.surname) AS display_name
                FROM tbl_response r
                JOIN tbl_project p ON r.project_id = p.project_id
                LEFT JOIN tbl_user u ON r.user_id = u.user_id
                ${PRICING_LATERAL_JOIN}
                ORDER BY r.created_at DESC LIMIT 200`);
        }
        res.json({ ok: true, history: r.rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/history  — ล้าง log (admin)
app.delete('/api/history', requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM tbl_response');
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/history  — บันทึกหลังรัน skill
app.post('/api/history', requireAuth, async (req, res) => {
    // DEPRECATED — no-op kept only so older clients don't get a 404.
    //
    // /api/chat now persists tbl_response, deducts the project pool, AND writes
    // the credit ledger authoritatively in one place. This legacy endpoint used
    // to ALSO insert tbl_response and deduct the pool, which DOUBLE-CHARGED every
    // chat: the project pool was debited twice while the ledger recorded it once
    // (symptom: pool drops ~2× the logged usage). Neutralised so billing happens
    // in exactly one path. Returns ok without touching money or writing rows.
    res.json({ ok: true, deducted: false, deprecated: true });
});

// ══════════════════════════════════════════════════════════
//  CHAT SESSIONS  (Phase 12 — conversation history, IDOR-safe)
// ══════════════════════════════════════════════════════════
// Storage: tbl_chat_session (thread metadata) + tbl_chat_message (per-turn).
//
// All endpoints here filter by req.session.userId.  No query or body
// parameter is trusted to identify the owner — even if a frontend bug
// sends the wrong userId, the server anchors on the cookie/session.
// That closes the IDOR that existed in the legacy /api/sessions code.

/**
 * Verify the caller owns this session. Returns the row or sends a
 * response and returns null.  Note: sessions that are soft-deleted
 * return 404 (not 403) — we treat deletion as "does not exist" from
 * the user's perspective to avoid probing.
 */
async function loadOwnedSession(req, res, sessionId) {
    const uid = req.session && req.session.userId;
    if (!uid) { res.status(401).json({ ok: false, error: 'Not authenticated' }); return null; }
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ ok: false, error: 'Invalid session id' });
        return null;
    }
    const r = await pool.query(
        `SELECT session_id, user_id, title, created_at, updated_at,
                is_deleted, message_count, total_cost, is_favorite
         FROM tbl_chat_session WHERE session_id=$1`,
        [id]);
    const row = r.rows[0];
    if (!row || row.is_deleted) {
        res.status(404).json({ ok: false, error: 'Session not found' });
        return null;
    }
    if (row.user_id !== uid) {
        // Same 404 shape on purpose — don't confirm "exists but forbidden"
        res.status(404).json({ ok: false, error: 'Session not found' });
        return null;
    }
    return row;
}

// GET /api/chat/sessions
//  list the caller's own sessions, most recent first, soft-deleted hidden.
//  Optional ?q= filter — matches session title OR any message content
//  via ILIKE (case-insensitive, %-wrapped). The match is escaped so
//  user-supplied % / _ behave as literals, not wildcards.
app.get('/api/chat/sessions', requireAuth, async (req, res) => {
    const uid = req.session.userId;
    // Clamp to 80 chars — anything longer is almost certainly not a real
    // search, just a URL-inflation attempt.
    const rawQ = String(req.query.q || '').trim().slice(0, 80);
    try {
        if (rawQ.length > 0) {
            // Escape ILIKE metacharacters so they match literally
            const safe = rawQ.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
            const pat  = '%' + safe + '%';
            const r = await pool.query(
                `SELECT s.session_id AS id, s.title, s.message_count,
                        s.total_cost, s.created_at, s.updated_at, s.is_favorite
                 FROM tbl_chat_session s
                 WHERE s.user_id=$1 AND s.is_deleted=FALSE
                   AND (s.title ILIKE $2 ESCAPE '\\'
                        OR EXISTS (
                            SELECT 1 FROM tbl_chat_message m
                            WHERE m.session_id = s.session_id
                              AND m.content ILIKE $2 ESCAPE '\\'))
                 ORDER BY s.is_favorite DESC, s.updated_at DESC
                 LIMIT 100`,
                [uid, pat]);
            // Phase 19.7: snake_case → camelCase for the frontend.
            const rows = r.rows.map(r => ({
                id: r.id, title: r.title,
                message_count: r.message_count, total_cost: r.total_cost,
                created_at: r.created_at, updated_at: r.updated_at,
                isFavorite: !!r.is_favorite,
            }));
            return res.json({ ok: true, sessions: rows, q: rawQ });
        }
        const r = await pool.query(
            `SELECT session_id AS id, title, message_count,
                    total_cost, created_at, updated_at, is_favorite
             FROM tbl_chat_session
             WHERE user_id=$1 AND is_deleted=FALSE
             ORDER BY is_favorite DESC, updated_at DESC
             LIMIT 100`,
            [uid]);
        const rows = r.rows.map(r => ({
            id: r.id, title: r.title,
            message_count: r.message_count, total_cost: r.total_cost,
            created_at: r.created_at, updated_at: r.updated_at,
            isFavorite: !!r.is_favorite,
        }));
        res.json({ ok: true, sessions: rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/chat/sessions/:id   → { session, messages }
app.get('/api/chat/sessions/:id', requireAuth, async (req, res) => {
    const sess = await loadOwnedSession(req, res, req.params.id);
    if (!sess) return;
    try {
        const m = await pool.query(
            `SELECT message_id AS id, role, content, created_at,
                    input_tokens, output_tokens, cost, model, skill_id
             FROM tbl_chat_message
             WHERE session_id=$1
             ORDER BY created_at, message_id`,
            [sess.session_id]);
        res.json({
            ok: true,
            session: {
                id: sess.session_id, title: sess.title,
                messageCount: sess.message_count, totalCost: sess.total_cost,
                createdAt: sess.created_at, updatedAt: sess.updated_at,
                isFavorite: !!sess.is_favorite,
            },
            messages: m.rows,
        });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/chat/sessions   body: { title? }
app.post('/api/chat/sessions', requireAuth, async (req, res) => {
    const uid = req.session.userId;
    const raw = (req.body && typeof req.body.title === 'string') ? req.body.title.trim() : '';
    const title = raw ? raw.slice(0, 200) : 'New chat';
    try {
        const r = await pool.query(
            `INSERT INTO tbl_chat_session (user_id, title)
             VALUES ($1, $2)
             RETURNING session_id, title, created_at, updated_at`,
            [uid, title]);
        res.json({ ok: true, session: {
            id: r.rows[0].session_id, title: r.rows[0].title,
            messageCount: 0, totalCost: 0,
            createdAt: r.rows[0].created_at, updatedAt: r.rows[0].updated_at,
        } });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PATCH /api/chat/sessions/:id   body: { title? , favorite? }
//   Phase 19.7: now also accepts { favorite: bool } for star/unstar.
//   At least one of title / favorite must be provided.
//   Title change bumps updated_at; favorite toggle does NOT (we don't
//   want starring an old chat to make it jump to the top of the date
//   buckets — the favorite group is the "top" already).
app.patch('/api/chat/sessions/:id', requireAuth, async (req, res) => {
    const sess = await loadOwnedSession(req, res, req.params.id);
    if (!sess) return;
    const body = req.body || {};
    const t = typeof body.title === 'string' ? body.title.trim() : null;
    const hasFavorite = (typeof body.favorite === 'boolean');
    if (!t && !hasFavorite) {
        return res.status(400).json({ ok: false, error: 'title or favorite required' });
    }
    try {
        if (t && hasFavorite) {
            await pool.query(
                `UPDATE tbl_chat_session
                   SET title=$1, is_favorite=$2, updated_at=NOW()
                 WHERE session_id=$3`,
                [t.slice(0, 200), !!body.favorite, sess.session_id]);
        } else if (t) {
            await pool.query(
                `UPDATE tbl_chat_session SET title=$1, updated_at=NOW()
                 WHERE session_id=$2`,
                [t.slice(0, 200), sess.session_id]);
        } else {
            // favorite-only toggle — leave updated_at alone
            await pool.query(
                `UPDATE tbl_chat_session SET is_favorite=$1
                 WHERE session_id=$2`,
                [!!body.favorite, sess.session_id]);
        }
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/chat/sessions/:id   → soft delete
app.delete('/api/chat/sessions/:id', requireAuth, async (req, res) => {
    const sess = await loadOwnedSession(req, res, req.params.id);
    if (!sess) return;
    try {
        await pool.query(
            `UPDATE tbl_chat_session SET is_deleted=TRUE, updated_at=NOW()
             WHERE session_id=$1`,
            [sess.session_id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/chat/sessions/:id/export   → plain markdown file
app.get('/api/chat/sessions/:id/export', requireAuth, async (req, res) => {
    const sess = await loadOwnedSession(req, res, req.params.id);
    if (!sess) return;
    try {
        const m = await pool.query(
            `SELECT role, content, created_at, cost
             FROM tbl_chat_message WHERE session_id=$1
             ORDER BY created_at, message_id`,
            [sess.session_id]);
        let md = `# ${sess.title}\n\n`;
        md += `_Exported ${new Date().toISOString()} · ${m.rows.length} messages · ฿${Number(sess.total_cost).toFixed(4)}_\n\n---\n\n`;
        for (const row of m.rows) {
            const who = row.role === 'user' ? '👤 **You**'
                      : row.role === 'assistant' ? '🤖 **Assistant**'
                      : `_${row.role}_`;
            md += `### ${who}  \n*${new Date(row.created_at).toISOString()}*\n\n${row.content}\n\n`;
        }
        // Safe filename: strip anything that isn't alnum/underscore/hyphen
        const fname = (sess.title || 'chat').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'chat';
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="${fname}.md"`);
        res.send(md);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  PHASE 2: THREAD ENDPOINTS (Assistants API with Memory)
// ══════════════════════════════════════════════════════════

// POST /api/thread/create — สร้าง OpenAI thread ใหม่
app.post('/api/thread/create', requireAuth, async (req, res) => {
    if (!HAS_API_KEY) return res.json({ ok: false, error: 'No API key' });
    try {
        const thread = await openai.beta.threads.create();
        res.json({ ok: true, threadId: thread.id });
    } catch (e) {
        console.error('[thread/create]', e.message);
        res.json({ ok: false, error: e.message });
    }
});

// DELETE /api/thread/:threadId — ลบ thread เมื่อลบ session
app.delete('/api/thread/:threadId', requireAuth, async (req, res) => {
    if (!HAS_API_KEY) return res.json({ ok: false });
    try {
        await openai.beta.threads.del(req.params.threadId);
        res.json({ ok: true });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

// ══════════════════════════════════════════════════════════
//  PHASE 4: TOOL EXECUTION FUNCTIONS
// ══════════════════════════════════════════════════════════

/** ค้นหา BAPI/RFC จาก knowledge file */
function findBapi(task, module) {
    try {
        const content = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '02_common_bapi_catalog.txt'), 'utf8');
        const taskWords = task.toLowerCase().split(/\s+/);
        const moduleLower = (module || '').toLowerCase();

        // แบ่งเป็น section ตาม BAPI แต่ละตัว (split by ###)
        const sections = content.split('###').filter(s => s.trim());
        const scored = sections.map(s => {
            const lower = s.toLowerCase();
            let score = taskWords.filter(w => w.length > 2 && lower.includes(w)).length;
            if (moduleLower && lower.includes(moduleLower)) score += 2;
            return { score, text: s.trim() };
        }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

        if (scored.length === 0) return { found: false, message: `ไม่พบ BAPI สำหรับ: "${task}"` };

        return {
            found: true,
            results: scored.slice(0, 3).map(s => {
                const lines = s.text.split('\n');
                return { name: lines[0].trim(), detail: lines.slice(1, 4).join(' ').trim() };
            }),
        };
    } catch (e) {
        return { found: false, error: e.message };
    }
}

/** ตรวจสอบ ABAP syntax และ obsolete patterns */
function checkAbapSyntax(code) {
    const issues = [];
    const lines  = code.split('\n');

    const RULES = [
        { pattern: /^\s*TABLES[\s:]/i,       severity: 'error',   msg: 'Obsolete: TABLES statement — ใช้ DATA declaration แทน' },
        { pattern: /\bMOVE\s+.+\s+TO\s+/i,  severity: 'warning', msg: 'Obsolete: MOVE...TO — ใช้ = assignment แทน' },
        { pattern: /\bSELECT\s+\*/i,         severity: 'warning', msg: 'SELECT * ควร select เฉพาะ fields ที่ใช้จริงเพื่อ performance' },
        { pattern: /\bWRITE\s*:/i,            severity: 'info',    msg: 'WRITE: ใช้ได้สำหรับ classic report แต่ไม่รองรับ Fiori/ALV' },
        { pattern: /\bSELECT\b[\s\S]+?ENDSELECT/im, severity: 'error', msg: 'SELECT...ENDSELECT loop — ใช้ SELECT...INTO TABLE แทน' },
        { pattern: /\bCLEAR\s+\w+\.\s*REFRESH\s+\w+/i, severity: 'info', msg: 'ใช้ FREE แทน CLEAR+REFRESH เพื่อคืน memory' },
        { pattern: /\bAND\s+RETURN\b/i,       severity: 'warning', msg: 'AND RETURN เป็น obsolete — ใช้ CALL METHOD แทน' },
    ];

    lines.forEach((line, i) => {
        RULES.forEach(rule => {
            if (rule.pattern.test(line)) {
                issues.push({ line: i + 1, severity: rule.severity, message: rule.msg, code: line.trim() });
            }
        });
    });

    return {
        valid:      issues.filter(x => x.severity === 'error').length === 0,
        issueCount: issues.length,
        issues:     issues.slice(0, 10),
        summary:    issues.length === 0
            ? '✅ ไม่พบปัญหา syntax'
            : `พบ ${issues.length} ปัญหา (${issues.filter(x => x.severity === 'error').length} error, ${issues.filter(x => x.severity === 'warning').length} warning)`,
    };
}

/** ดูข้อมูล SAP Transaction Code */
function getTransactionInfo(tcode) {
    try {
        const content = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '03_sap_transactions.txt'), 'utf8');
        const pattern = new RegExp(`\\|\\s*${tcode.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|([^|\\n]+)\\|`, 'i');
        const match   = content.match(pattern);
        if (!match) return { found: false, tcode: tcode.toUpperCase(), message: `ไม่พบข้อมูลสำหรับ T-Code: ${tcode.toUpperCase()}` };
        return { found: true, tcode: tcode.toUpperCase(), description: match[1].trim() };
    } catch (e) {
        return { found: false, error: e.message };
    }
}

/** ค้นหาข้อมูล S/4HANA migration จาก knowledge file */
function searchS4Migration(topic) {
    try {
        const content = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '05_s4hana_migration_guide.txt'), 'utf8');
        const words   = topic.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const lines   = content.split('\n');
        const results = [];
        lines.forEach((line, i) => {
            if (words.some(w => line.toLowerCase().includes(w))) {
                const snippet = lines.slice(i, i + 6).join('\n').trim();
                if (!results.some(r => r.startsWith(snippet.slice(0, 30)))) results.push(snippet);
            }
        });
        if (results.length === 0) return { found: false, message: `ไม่พบข้อมูล migration สำหรับ: "${topic}"` };
        return { found: true, results: results.slice(0, 4) };
    } catch (e) { return { found: false, error: e.message }; }
}

/** ดึง ABAP best practice จาก knowledge file */
function getBestPractice(topic) {
    try {
        const content  = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '01_abap_best_practices.txt'), 'utf8');
        const words    = topic.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const sections = content.split(/\n#{2,3} /);
        const scored   = sections.map(s => ({
            score: words.filter(w => s.toLowerCase().includes(w)).length,
            text:  s.trim(),
        })).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
        if (scored.length === 0) return { found: false, message: `ไม่พบ best practice สำหรับ: "${topic}"` };
        return { found: true, practices: scored.slice(0, 3).map(s => s.text.slice(0, 600)) };
    } catch (e) { return { found: false, error: e.message }; }
}

/** อธิบาย ABAP dump จาก error_patterns knowledge file */
function explainAbapDump(errorType, context) {
    try {
        const content  = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '07_abap_error_patterns.txt'), 'utf8');
        const errorUp  = errorType.toUpperCase();
        const lines    = content.split('\n');
        const matchIdx = lines.findIndex(l => l.toUpperCase().includes(errorUp));
        if (matchIdx === -1) return { found: false, error_type: errorUp, message: `ไม่พบข้อมูลสำหรับ error: ${errorUp} — ลองค้นใน SAP note หรือ ST22 โดยตรง` };
        const explanation = lines.slice(matchIdx, matchIdx + 15).join('\n').trim();
        return { found: true, error_type: errorUp, explanation, has_context: !!context };
    } catch (e) { return { found: false, error: e.message }; }
}

/** ค้นหา SAP authorization object — อ่านจาก knowledge file basis_admin */
function lookupAuthObject(object, intent) {
    try {
        const content = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '13_basis_admin.txt'), 'utf8');
        const up      = String(object || '').toUpperCase().trim();
        if (!up) return { found: false, message: 'กรุณาระบุ authorization object' };

        // Common objects → canonical blurbs (fast-path, doesn't depend on file parse)
        const CATALOG = {
            'S_DEVELOP':   { fields: ['DEVCLASS','OBJTYPE','OBJNAME','P_GROUP','ACTVT'], actvt: ['01 create','02 change','03 display','06 delete','16 execute'], use: 'ABAP workbench access — ควบคุม class/program/table ตาม P_GROUP' },
            'S_TCODE':     { fields: ['TCD'],                                             actvt: ['(no ACTVT — ผ่านการเข้า tx เท่านั้น)'],                 use: 'อนุญาตให้เข้า transaction code; ต่อด้วย object อื่นใน tx นั้นอีกที' },
            'S_TABU_DIS':  { fields: ['DICBERCLS','ACTVT'],                                actvt: ['02 change','03 display'],                                use: 'เปิด/แก้ table ผ่าน authgroup (SM30/SM31/SE16)' },
            'S_TABU_NAM':  { fields: ['TABLE','ACTVT'],                                    actvt: ['02 change','03 display'],                                use: 'เปิด/แก้ table ตาม name — ละเอียดกว่า S_TABU_DIS' },
            'S_PROGRAM':   { fields: ['P_ACTION','P_GROUP'],                               actvt: ['SUBMIT','BTCSUBMIT','VARIANT','EDIT'],                  use: 'ควบคุมสิทธิ์รัน/แก้ ABAP program ตาม authgroup' },
            'S_RFC':       { fields: ['ACTVT','RFC_TYPE','RFC_NAME'],                      actvt: ['16 execute'],                                            use: 'จำกัดการเรียก RFC — ต่ำมากสุดควรกำหนดเป็น function group' },
            'S_BTCH_JOB':  { fields: ['JOBACTION','JOBGROUP'],                             actvt: ['RELE','SHOW','DELE','PLAN','PROT'],                     use: 'การจัดการ background job (SM36/SM37)' },
            'S_DATASET':   { fields: ['ACTVT','FILENAME','PROGRAM'],                       actvt: ['06 delete','33 read','34 write'],                       use: 'เข้าถึง application server file (OPEN DATASET)' },
            'S_TRANSPRT':  { fields: ['TTYPE','ACTVT'],                                    actvt: ['01 create','02 change','03 display','60 import','75 release'], use: 'จัดการ transport request' },
            'S_USER_GRP':  { fields: ['CLASS','ACTVT'],                                    actvt: ['01 create','02 change','03 display','05 lock','06 delete','24 assign'], use: 'สิทธิ์ใน SU01 ตาม user group' },
            'S_ADMI_FCD':  { fields: ['S_ADMI_FCD'],                                       actvt: ['(token-based)'],                                         use: 'admin functions เช่น SPAD, SP01, SM02' },
        };

        const cat = CATALOG[up];
        const authCheckSnippet = cat
            ? `AUTHORITY-CHECK OBJECT '${up}'\n  ID '${cat.fields[0] || 'X'}' FIELD lv_val${cat.fields.includes('ACTVT') ? "\n  ID 'ACTVT'     FIELD '03'" : ''}.\nIF sy-subrc <> 0.\n  MESSAGE 'No authorization' TYPE 'E'.\nENDIF.`
            : null;

        // Also fetch surrounding knowledge-file context if it mentions the object
        let kbContext = null;
        const idx = content.toUpperCase().indexOf(up);
        if (idx !== -1) {
            kbContext = content.substring(Math.max(0, idx - 80), idx + 400).trim();
        }

        if (cat) {
            return {
                found: true,
                object: up,
                fields: cat.fields,
                common_actvt_values: cat.actvt,
                use_case: cat.use,
                code_snippet: authCheckSnippet,
                intent_hint: intent || null,
                kb_context: kbContext,
                tip: 'หาก AUTHORITY-CHECK ล้มเหลว ให้ user รัน SU53 ทันทีเพื่อดู object/field ที่ขาด',
            };
        }

        if (kbContext) return { found: true, object: up, kb_context: kbContext, note: 'object นี้ไม่ได้อยู่ใน catalog หลัก — ข้อมูลจาก knowledge base' };
        return { found: false, object: up, message: `ไม่พบข้อมูล authorization object: ${up}` };
    } catch (e) { return { found: false, error: e.message }; }
}

/** อธิบาย T-code ในเชิง config + enhancement — อ่านจาก transactions + functional KB */
function explainTcodeConfig(tcode, module) {
    try {
        const up = String(tcode || '').toUpperCase().trim();
        if (!up) return { found: false, message: 'กรุณาระบุ T-code' };

        // 1) Base description from 03_sap_transactions.txt
        const base = getTransactionInfo(up);

        // 2) Scan functional KB for SPRO path + config table hints
        const funcContent = fs_mod.readFileSync(path_mod.join(KNOWLEDGE_DIR, '17_functional_config_spro.txt'), 'utf8');
        const lines = funcContent.split('\n');
        const matchIdx = lines.findIndex(l => l.toUpperCase().includes(up));
        let funcSnippet = null;
        if (matchIdx !== -1) {
            funcSnippet = lines.slice(Math.max(0, matchIdx - 2), matchIdx + 8).join('\n').trim();
        }

        // 3) Enhancement hints — quick heuristics by module
        const ENH_HINTS = {
            VA01: { badi: 'BADI_SD_SALES_ITEM', user_exit: 'USEREXIT_MOVE_FIELD_TO_VBAK (MV45AFZZ)', tables: ['VBAK','VBAP','VBKD'] },
            VA02: { badi: 'BADI_SD_SALES_ITEM', user_exit: 'USEREXIT_SAVE_DOCUMENT_PREPARE (MV45AFZZ)', tables: ['VBAK','VBAP'] },
            ME21N:{ badi: 'ME_PROCESS_PO_CUST', user_exit: '(no classic; use BAdI)', tables: ['EKKO','EKPO','EKET'] },
            ME22N:{ badi: 'ME_PROCESS_PO_CUST', user_exit: '(no classic; use BAdI)', tables: ['EKKO','EKPO'] },
            MIGO: { badi: 'MB_DOCUMENT_BADI', user_exit: 'EXIT_SAPMM07M_001', tables: ['MATDOC','MKPF','MSEG'] },
            MIRO: { badi: 'INVOICE_UPDATE', user_exit: 'EXIT_SAPLMRMH_001', tables: ['RBKP','RSEG'] },
            FB01: { badi: 'BADI_FDCB_SUBBAS01', user_exit: 'USEREXIT_* (SAPLF040)', tables: ['BKPF','BSEG'] },
            FB60: { badi: 'BADI_FDCB_SUBBAS01', user_exit: 'USEREXIT_*', tables: ['BKPF','BSEG'] },
            F110: { badi: 'FI_F110', user_exit: 'FEDI0003 / FEDI0005', tables: ['REGUH','REGUP'] },
            FBN1: { badi: '(number range — use SNRO BAdI NUMBER_RANGE_OBJECT)', tables: ['NRIV','T003'] },
            OBYC: { badi: '(customizing — no enhancement; is configuration)', tables: ['T030'] },
            OB13: { badi: '(customizing)', tables: ['T004','SKA1','SKB1'] },
            VOV8: { badi: '(customizing)', tables: ['TVAK','TVAKT'] },
            OMS2: { badi: '(customizing)', tables: ['T134'] },
            PFCG: { badi: '(not applicable — admin tx)', tables: ['AGR_*','USR*'] },
            SU01: { badi: 'BBP_SEARCH_SHLP_USER', tables: ['USR02','USR04','USER_ADDR'] },
            BP:   { badi: 'BUPA_FURTHER_CHECKS', tables: ['BUT000','BUT020','BUT100','CVI_*'] },
        };
        const enh = ENH_HINTS[up] || null;

        return {
            found: !!(base?.found || funcSnippet || enh),
            tcode: up,
            module: module || null,
            description: base?.description || null,
            spro_or_config_snippet: funcSnippet,
            enhancements: enh,
            recommendation: enh
                ? `ใช้ ${enh.badi} สำหรับ custom logic, แก้ FS เฉพาะกรณีไม่มีตัวเลือกอื่น`
                : 'ตรวจสอบ enhancement ผ่าน SE84 → Business Add-Ins ค้นคำสำคัญของ tx',
        };
    } catch (e) { return { found: false, error: e.message }; }
}

/** Dispatcher — เรียก tool function ที่ถูกต้อง */
async function executeTool(name, args) {
    console.log(`[🔧 tool] ${name}(${JSON.stringify(args).slice(0, 120)})`);
    switch (name) {
        case 'find_bapi':            return findBapi(args.task, args.module);
        case 'check_abap_syntax':    return checkAbapSyntax(args.code || '');
        case 'get_transaction_info': return getTransactionInfo(args.tcode || '');
        case 'search_s4_migration':  return searchS4Migration(args.topic || '');
        case 'get_best_practice':    return getBestPractice(args.topic || '');
        case 'explain_abap_dump':    return explainAbapDump(args.error_type || '', args.context || '');
        case 'lookup_auth_object':   return lookupAuthObject(args.object || '', args.intent || '');
        case 'explain_tcode_config': return explainTcodeConfig(args.tcode || '', args.module || '');
        default: return { error: `Unknown tool: ${name}` };
    }
}

// ── Phase 34: Responses API path (gpt-5.6 family) ──────────────────────────
// The Responses API (/v1/responses) uses a different request/stream shape than
// Chat Completions. This helper mirrors the Chat Completions tool loop but on
// Responses, emitting the SAME SSE vocabulary ({type:'chunk'|'tool_call'}) so
// the frontend + billing/persist tail are unchanged. Event/usage field names
// were verified live against gpt-5.6 before writing this.

// Chat Completions tool = {type:'function', function:{name,description,parameters}}
// Responses tool        = {type:'function', name, description, parameters}  (flat)
function toResponsesTools(tools) {
    return tools.map(t => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
    }));
}

async function runResponsesTurn({ oai, userId, model, effort, instructions, userPrompt, tools, sendEvent, acc, isAborted, setStream }) {
    const MAX_TOOL_TURNS = 3;
    const MAX_LENGTH_CONTINUATIONS = 4;   // Phase 32 analog for Responses
    const rTools = toResponsesTools(tools);
    let previousResponseId = null;
    let input = userPrompt;               // first turn: plain string prompt
    let toolTurn = 0;
    let lengthContinuations = 0;

    // One streaming Responses call. Accumulates text + tool calls, updates acc
    // usage/text, returns { calls, incomplete, respId }.
    async function once(args) {
        let stream;
        try {
            stream = await oai.responses.create(args);
        } catch (e) {
            // Mirror the chat path's project-key 401 → global-key fallback.
            if (e?.status === 401 && oai !== openai && openai) {
                await markProjectKeyInvalid(userId, 'responses stream 401');
                stream = await openai.responses.create(args);
            } else { throw e; }
        }
        setStream(stream);
        const fcalls = {};   // item_id → { call_id, name, args }
        let respId = null, usage = null, incomplete = null;
        try {
            for await (const ev of stream) {
                if (isAborted()) break;
                switch (ev.type) {
                    case 'response.output_text.delta':
                        acc.fullText += ev.delta;
                        sendEvent({ type: 'chunk', text: ev.delta });
                        break;
                    case 'response.output_item.added':
                        if (ev.item?.type === 'function_call') {
                            fcalls[ev.item.id] = { call_id: ev.item.call_id, name: ev.item.name, args: '' };
                        }
                        break;
                    case 'response.function_call_arguments.delta':
                        if (fcalls[ev.item_id]) fcalls[ev.item_id].args += ev.delta;
                        break;
                    case 'response.completed':
                        respId = ev.response?.id;
                        usage = ev.response?.usage;
                        incomplete = ev.response?.incomplete_details;
                        break;
                    case 'response.failed':
                    case 'error':
                        throw new Error(ev.response?.error?.message || ev.message || 'Responses API stream error');
                }
            }
        } catch (streamErr) {
            if (isAborted()) return { calls: [], incomplete: null, respId };
            throw streamErr;
        } finally {
            setStream(null);
        }
        if (usage) {
            acc.inputTokens     += usage.input_tokens  || 0;
            acc.outputTokens    += usage.output_tokens || 0;
            acc.cachedTokens    += usage.input_tokens_details?.cached_tokens     || 0;
            acc.reasoningTokens += usage.output_tokens_details?.reasoning_tokens || 0;
        }
        return { calls: Object.values(fcalls), incomplete, respId };
    }

    while (toolTurn < MAX_TOOL_TURNS) {
        if (isAborted()) break;
        const args = {
            model, stream: true, max_output_tokens: 4000,
            tools: rTools, reasoning: { effort }, store: true,
            input,
        };
        // instructions only seed the first turn; later turns carry context via
        // previous_response_id (server keeps the transcript — no resend needed).
        if (previousResponseId) args.previous_response_id = previousResponseId;
        else                    args.instructions = instructions;

        const { calls, incomplete, respId } = await once(args);
        if (respId) previousResponseId = respId;
        if (isAborted()) return;

        // Truncated by the output cap (no tool call pending) → ask to continue.
        if (calls.length === 0 && incomplete?.reason === 'max_output_tokens'
            && lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
            lengthContinuations++;
            console.warn(`[chat/responses] truncated — continuing (${lengthContinuations}/${MAX_LENGTH_CONTINUATIONS})`);
            input = 'Continue exactly where you left off. Do not repeat any earlier text or restart the file.';
            continue;
        }

        if (calls.length === 0) return;   // plain answer → done

        // Tool calls → execute and feed outputs back on the next turn.
        sendEvent({ type: 'tool_call', tools: calls.map(c => c.name) });
        const outputs = [];
        for (const c of calls) {
            let parsed = {};
            try { parsed = JSON.parse(c.args || '{}'); } catch (_) {}
            const result = await executeTool(c.name, parsed);
            outputs.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(result) });
        }
        input = outputs;   // previous_response_id carries the function_call items
        toolTurn++;
    }

    // Hit the tool-turn cap with no answer yet → force one tools-off turn so the
    // user gets a summary instead of an empty reply (mirrors the chat path).
    if (!isAborted() && acc.fullText.length === 0 && previousResponseId) {
        console.warn(`[chat/responses] hit MAX_TOOL_TURNS — forcing a final answer turn`);
        await once({
            model, stream: true, max_output_tokens: 4000,
            reasoning: { effort }, store: true, tool_choice: 'none',
            previous_response_id: previousResponseId,
            input: 'Based on the tool results above, give the final answer now.',
        });
    }
}

/**
 * Process an AssistantStream — handle text deltas AND tool calls recursively.
 * เมื่อ Assistant ต้องการเรียก tool จะหยุด stream, execute, แล้ว submit ผลกลับ
 */
async function processAssistantStream(stream, threadId, sendEvent, state) {
    for await (const event of stream) {
        // ── Text delta ─────────────────────────────────────────
        if (event.event === 'thread.message.delta') {
            const delta = event.data?.delta?.content?.[0]?.text?.value || '';
            if (delta) { state.fullText += delta; sendEvent({ type: 'chunk', text: delta }); }
        }

        // ── Run completed — capture usage ────────────────────
        // Phase 16.9: also capture the *_details breakdowns the API exposes:
        //   prompt_tokens_details.cached_tokens     → tokens served from cache (discounted)
        //   completion_tokens_details.reasoning_tokens → o1/o3/o4 only; 0 for gpt-4o
        // If the field is missing (older models, beta versions) we default to 0.
        if (event.event === 'thread.run.completed') {
            const u = event.data?.usage || {};
            state.inputTokens     = u.prompt_tokens     || state.inputTokens;
            state.outputTokens    = u.completion_tokens || state.outputTokens;
            state.cachedTokens    = u.prompt_tokens_details?.cached_tokens || state.cachedTokens || 0;
            state.reasoningTokens = u.completion_tokens_details?.reasoning_tokens || state.reasoningTokens || 0;
        }

        // ── Tool calls required ───────────────────────────────
        if (event.event === 'thread.run.requires_action') {
            const run       = event.data;
            const toolCalls = run.required_action.submit_tool_outputs.tool_calls;

            // แจ้ง frontend ว่ากำลังเรียก tool
            sendEvent({ type: 'tool_call', tools: toolCalls.map(tc => tc.function.name) });

            // Execute tools concurrently
            const toolOutputs = await Promise.all(toolCalls.map(async (tc) => {
                const args   = JSON.parse(tc.function.arguments || '{}');
                const result = await executeTool(tc.function.name, args);
                return { tool_call_id: tc.id, output: JSON.stringify(result) };
            }));

            // Submit tool outputs → get new stream → process recursively
            const toolStream = openai.beta.threads.runs.submitToolOutputsStream(
                threadId, run.id, { tool_outputs: toolOutputs }
            );
            await processAssistantStream(toolStream, threadId, sendEvent, state);
        }
    }
}

// POST /api/thread/message — ส่งข้อความพร้อม Thread Memory (Streaming SSE)
app.post('/api/thread/message', requireAuth, chatRateLimiter, async (req, res) => {
    if (!HAS_API_KEY) { res.json({ ok: false, useMock: true }); return; }

    const { threadId, prompt, inputRate = 0.50, outputRate = 1.50, useRouter = true, userId } = req.body;
    if (!threadId || !prompt) { res.status(400).json({ ok: false, error: 'threadId and prompt required' }); return; }

    // Phase 21 C1 — daily cap enforcement (same guard as /api/chat).
    try {
        const uid = req.session?.userId;
        if (uid) {
            const cap = await pool.query(
                `SELECT daily_cap FROM tbl_user WHERE user_id=$1 AND is_deleted=FALSE`, [uid]);
            const capVal = cap.rows[0]?.daily_cap;
            if (capVal !== null && capVal !== undefined) {
                const spent = await spentToday(uid);
                if (spent >= Number(capVal)) {
                    return res.status(429).json({
                        ok: false,
                        error: 'daily_cap_exceeded',
                        message: `⛔ คุณใช้งานเกินวงเงินรายวันแล้ว (${spent.toFixed(2)}/${Number(capVal).toFixed(2)} บาท) — รอวันถัดไปหรือติดต่อ admin`,
                        spentToday: spent,
                        dailyCap: Number(capVal),
                    });
                }
            }
        }
    } catch (e) {
        console.warn('[thread] daily_cap check failed:', e.message);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    // no-transform stops Cloudflare/proxies from compressing the stream;
    // X-Accel-Buffering:no stops them from buffering it. Without these a tunnel
    // holds the whole response and delivers it at once (long silent pause → the
    // full answer pops in) instead of streaming token-by-token.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const startTime = Date.now();
    // Phase 16.9: track cached + reasoning breakdowns alongside the totals.
    let inputTokens = 0, outputTokens = 0, cachedTokens = 0, reasoningTokens = 0, fullText = '';

    try {
        // ── Phase 1 Router (ยังทำงานอยู่แม้ใน thread mode) ──
        let detectedSkill = null;
        let additionalInstructions = null;

        // Phase 17.2: for the ROUTER call we can safely use the per-project
        // key (chat.completions is stateless). For the Assistants/Threads
        // path below we DELIBERATELY stay on the global `openai` client —
        // assistants + vector stores are scoped to the project they live in
        // (Default project here) and per-project SA keys may not see them.
        const routerOai = await getProjectOpenAI(req.session.userId);

        if (useRouter) {
            // Phase 18: JSON-catalog router. High-confidence match → inject the
            // catalog's prompt content.
            // Phase 31: the catalog (tbl_prompt, 50+ skills) is authoritative —
            // if it says "none", trust that instead of burning a second
            // gpt-4o-mini call on the old hardcoded detectIntent() classifier.
            // (That fallback also read a `systemPrompts` field the client never
            // actually sends, so it never did anything but cost extra latency.)
            // additionalInstructions is left at its base SAP/ABAP default.
            const catalogPick = await pickSkillFromCatalog(prompt, routerOai);
            if (catalogPick.skillId && catalogPick.content) {
                detectedSkill = {
                    skillId:    catalogPick.skillId,
                    label:      catalogPick.label,
                    intent:     'catalog',
                    confidence: catalogPick.confidence,
                    reason:     catalogPick.reason,
                };
                additionalInstructions = catalogPick.content;
            } else {
                detectedSkill = {
                    skillId:    null,
                    label:      'General',
                    intent:     'general',
                    confidence: catalogPick.confidence,
                    reason:     catalogPick.reason,
                };
            }
            sendEvent({ type: 'routed', skillId: detectedSkill.skillId, skillLabel: detectedSkill.label, intent: detectedSkill.intent, confidence: detectedSkill.confidence });
        }

        // ── เพิ่ม message ใน thread ───────────────────────────
        let finalPrompt = prompt;
        if (additionalInstructions && additionalInstructions.includes('{code}')) {
            additionalInstructions = additionalInstructions.replace('{code}', prompt);
            finalPrompt = 'Please analyze the ABAP code provided in the instructions and apply the corrections.';
        }

        await openai.beta.threads.messages.create(threadId, {
            role: 'user',
            content: finalPrompt,
        });

        // ── Phase 4: รัน Assistant พร้อม Tool Use + Streaming ──
        const assistantId = await ensureAssistant();
        const runStream = openai.beta.threads.runs.stream(threadId, {
            assistant_id:            assistantId,
            additional_instructions: additionalInstructions || undefined,
            max_completion_tokens:   2000,
        });

        // state object ที่ processAssistantStream จะ mutate
        // Phase 16.9: include cached + reasoning breakdowns.
        const state = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, fullText: '' };
        await processAssistantStream(runStream, threadId, sendEvent, state);
        ({ inputTokens, outputTokens, cachedTokens, reasoningTokens, fullText } = state);

        if (inputTokens === 0) {
            inputTokens  = Math.ceil(prompt.length / 3.5);
            outputTokens = Math.ceil(fullText.length / 3.5);
        }

        const durationMs = Date.now() - startTime;
        // Phase 21 A1 — pricing from tbl_pricing (single source of truth);
        // req.body rates fall back if no row exists for this model yet.
        const pricing = await getActivePricing(MODEL, { inputRate, outputRate });
        const useInput  = pricing.inputPrice;
        const useOutput = pricing.outputPrice;
        const useCached = (typeof req.body.cachedInputRate === 'number')
            ? req.body.cachedInputRate
            : pricing.cachedPrice;
        const nonCachedInputTokens = Math.max(0, (inputTokens || 0) - (cachedTokens || 0));
        const cost = (nonCachedInputTokens / 1000) * useInput
                   + ((cachedTokens || 0) / 1000) * useCached
                   + ((outputTokens || 0) / 1000) * useOutput;
        console.log(`[thread] [${detectedSkill?.intent || 'general'}] ${inputTokens}in(${cachedTokens} cached)/${outputTokens}out(${reasoningTokens} reasoning) | ฿${cost.toFixed(4)} | rates ${pricing.fromDb?'from tbl_pricing':'fallback'} | ${durationMs}ms`);

        // ── บันทึก tbl_response + หัก tbl_credits ──────────────
        if (userId) {
            try {
                const uRow = await pool.query('SELECT project_id FROM tbl_user WHERE user_id=$1', [userId]);
                const projectId = uRow.rows[0]?.project_id || null;
                if (projectId) {
                    const responseId = require('crypto').randomBytes(16).toString('hex');
                    await pool.query(`
                        INSERT INTO tbl_response
                            (response_id, project_id, user_id, model, created_at, input_param, output_param,
                             input_tokens, input_cached_tokens, output_tokens, output_reasoning_tokens, total_tokens)
                        VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8,$9,$10,$11)`,
                        [responseId, projectId, userId, process.env.OPENAI_MODEL || 'gpt-4o',
                         prompt || '', fullText || '',
                         inputTokens || 0, cachedTokens || 0,
                         outputTokens || 0, reasoningTokens || 0,
                         (inputTokens || 0) + (outputTokens || 0)]);
                    // Phase 21.10 (Concept B) — atomic deduct from project pool.
                    // Phase 33: was missing the tbl_user_credit_transaction write
                    // that /api/chat does (see that handler for the pattern this
                    // mirrors) — deducting the pool with no ledger entry meant
                    // this endpoint's usage was invisible to the transaction
                    // journal / admin dashboards. Dormant today (no frontend
                    // caller) but fixing before thread mode is ever enabled.
                    const dedRes = await pool.query(
                        `UPDATE tbl_balance SET project_credits = project_credits - $1
                         WHERE project_id=$2 AND project_credits >= $1
                         RETURNING project_credits AS balance_after`,
                        [cost || 0, projectId]);
                    if (dedRes.rowCount === 0 && (cost || 0) > 0) {
                        console.warn(`[thread] ⚠ project pool insufficient — project:${projectId} cost:${cost}`);
                    } else if (dedRes.rowCount === 1 && (cost || 0) > 0) {
                        const balAfter  = parseFloat(dedRes.rows[0].balance_after);
                        const balBefore = balAfter + Number(cost);
                        try {
                            await pool.query(`
                                INSERT INTO tbl_user_credit_transaction
                                    (user_id, project_id, transaction_type, amount,
                                     balance_before, balance_after,
                                     ref_type, ref_id, note, created_by)
                                VALUES ($1, $2, 'usage', $3, $4, $5, 'thread', NULL, $6, NULL)`,
                                [userId, projectId, -Number(cost),
                                 balBefore, balAfter, 'thread:' + threadId]);
                        } catch (logErr) {
                            console.warn('[thread] credit log INSERT failed:', logErr.message);
                        }
                    }
                    console.log(`[thread] ✅ DB saved — user:${userId} project:${projectId} cost:฿${cost.toFixed(4)} deducted:${dedRes.rowCount > 0}`);
                }
            } catch (dbErr) {
                console.error('[thread/message] DB save error:', dbErr.message);
            }
        }

        sendEvent({ type: 'done', inputTokens, outputTokens, cost, durationMs, detectedSkill });
        res.end();

    } catch (err) {
        console.error('[thread/message] Error:', err.message);
        sendEvent({ type: 'error', error: err.message });
        res.end();
    }
});

// ══════════════════════════════════════════════════════════
//  PHASE 3: KNOWLEDGE BASE ENDPOINTS
// ══════════════════════════════════════════════════════════

// multer for file upload
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// GET /api/knowledge — list files in vector store
app.get('/api/knowledge', requireAuth, async (req, res) => {
    if (!HAS_API_KEY || !VECTOR_STORE_ID) return res.json({ ok: true, files: [], vectorStoreId: null });
    try {
        const list = await openai.vectorStores.files.list(VECTOR_STORE_ID);
        const files = await Promise.all(list.data.map(async f => {
            try {
                const info = await openai.files.retrieve(f.id);
                return { id: f.id, name: info.filename, size: info.bytes, status: f.status, created: f.created_at };
            } catch { return { id: f.id, name: f.id, status: f.status }; }
        }));
        res.json({ ok: true, vectorStoreId: VECTOR_STORE_ID, files });
    } catch (e) {
        res.json({ ok: false, error: e.message, files: [] });
    }
});

// POST /api/knowledge/upload — upload doc to vector store
app.post('/api/knowledge/upload', requireAdmin, upload.single('file'), async (req, res) => {
    if (!HAS_API_KEY) return res.json({ ok: false, error: 'No API key' });
    if (!req.file) return res.json({ ok: false, error: 'No file provided' });
    try {
        const vsId = VECTOR_STORE_ID || await ensureVectorStore();
        // upload file to OpenAI
        const { Readable } = require('stream');
        const stream = Readable.from(req.file.buffer);
        stream.path = req.file.originalname;  // OpenAI needs filename
        const uploaded = await openai.files.create({ file: stream, purpose: 'assistants' });
        // add to vector store
        await openai.vectorStores.files.createAndPoll(vsId, { file_id: uploaded.id });
        // save copy locally for reference
        const localPath = path_mod.join(KNOWLEDGE_DIR, req.file.originalname);
        fs_mod.writeFileSync(localPath, req.file.buffer);
        console.log(`[☁️ RAG] Uploaded: ${req.file.originalname}`);
        res.json({ ok: true, fileId: uploaded.id, name: req.file.originalname });
    } catch (e) {
        console.error('[knowledge/upload]', e.message);
        res.json({ ok: false, error: e.message });
    }
});

// DELETE /api/knowledge/:fileId — remove file from vector store
app.delete('/api/knowledge/:fileId', requireAdmin, async (req, res) => {
    if (!HAS_API_KEY || !VECTOR_STORE_ID) return res.json({ ok: false });
    try {
        await openai.vectorStores.files.del(VECTOR_STORE_ID, req.params.fileId);
        await openai.files.del(req.params.fileId);
        res.json({ ok: true });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

// ══════════════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        mode:          HAS_API_KEY ? 'openai' : 'mock',
        model:         HAS_API_KEY ? MODEL : null,
        assistantId:   ASSISTANT_ID,
        vectorStoreId: VECTOR_STORE_ID,
        rag:           !!VECTOR_STORE_ID,
    });
});

// Phase 11 B2: /api/version — admin-only deployment fingerprint.
// Exposes version, uptime, node version, migration state. Used by
// ops to verify which build is live and whether any migrations are
// pending/modified. Admin-gated because migration state is
// deployment-sensitive info.
const _BOOT_TIME = Date.now();
app.get('/api/version', requireAdmin, async (req, res) => {
    let migrations = null;
    try {
        const s = await migrationStatus(pool);
        migrations = {
            applied:  s.applied.length,
            pending:  s.pending.length,
            modified: s.modified.length,
            // only list the problematic ones explicitly — applied list
            // can be long and noisy
            pendingFiles:  s.pending,
            modifiedFiles: s.modified,
        };
    } catch (e) {
        migrations = { error: e.message };
    }
    res.json({
        ok:          true,
        name:        pkg.name,
        version:     pkg.version,
        node:        process.version,
        platform:    `${process.platform}/${process.arch}`,
        mode:        HAS_API_KEY ? 'openai' : 'mock',
        model:       HAS_API_KEY ? MODEL : null,
        bootTime:    new Date(_BOOT_TIME).toISOString(),
        uptimeSec:   Math.round(process.uptime()),
        migrations,
    });
});


// ══════════════════════════════════════════════════════════
//  SKILL ROUTER — picks a system prompt from the tbl_prompt catalog
// ══════════════════════════════════════════════════════════

// Phase 18: picks a skill from the DB-backed catalog (skill-prompts.js).
// Phase 31: this is now the ONLY router — the old hardcoded
// INTENT_SKILL_MAP/detectIntent() classifier was removed. It was a second
// gpt-4o-mini call that only ran when this catalog said "none", and its own
// fallback (a `systemPrompts` field from the client) was never actually
// sent by the frontend — so it added cost/latency without ever changing
// the outcome. Chat endpoints now trust "none" from here directly.
//
// Behaviour
// ─────────
//   - Builds a fresh system prompt from skill-prompts.json on each call
//     (cheap — the catalog is small and already in memory).
//   - Asks gpt-4o-mini to pick ONE skill id OR "none" if no clear match.
//   - Returns { skillId, label, confidence, reason, content }.
//     `content` is the prompt body to inject as additional_instructions
//     when confidence ≥ 0.7. Below the threshold we return content=null
//     and the chat path skips injection (Assistant + vector store handle
//     the question themselves — Phase 1 fallback the user approved).
async function pickSkillFromCatalog(userMessage, oai) {
    const catalog = skillPrompts.buildRouterCatalog();
    if (catalog.length === 0) {
        // No catalog loaded (file missing or parse error) — caller falls
        // through to the base SAP/ABAP system prompt.
        return { skillId: null, label: null, confidence: 0, reason: 'catalog empty', content: null, fromCatalog: false };
    }

    // Render the catalog as a numbered list for the LLM. We include id +
    // label + description; the LLM must echo back the id exactly.
    const catalogText = catalog.map(s =>
        `- id: "${s.id}"\n    label: ${s.label}\n    description: ${s.description}`
    ).join('\n');

    const sys = `You are a router for an SAP/ABAP code-review assistant. Pick exactly ONE skill from the list below that best fits the user's question — or return id "none" if nothing clearly matches.

Available skills:
${catalogText}

Rules:
  - Return ONLY a JSON object — no prose, no markdown.
  - "id" must be one of the ids above, or "none".
  - "confidence" is between 0 and 1.
  - If the question is generic, ambiguous, or off-topic, return "none".

Schema: {"id": "<skill_id or 'none'>", "confidence": 0.0-1.0, "reason": "<one short sentence>"}`;

    try {
        const client = oai || openai;
        // safeChatCompletion handles the 401-fallback to global, but we don't
        // have the userId here — pass undefined so it just rethrows instead
        // (caller's outer try/catch in /api/chat will catch it).
        // Phase 19.3: force JSON output. gpt-4o-mini occasionally wraps its
        // answer in prose ("Sure! Here's the JSON: ...") which then breaks
        // JSON.parse and we'd silently miss-classify the request. Adding
        // response_format guarantees the body is a parseable JSON object.
        const routerArgs = {
            model:           'gpt-4o-mini',
            max_tokens:      120,
            temperature:     0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: sys },
                { role: 'user',   content: String(userMessage).substring(0, 800) },
            ],
        };
        const resp = await client.chat.completions.create(routerArgs).catch(async (e) => {
            // Auto-fallback for the router specifically: chat works only if
            // the router survives, so trade attribution for availability.
            if ((e?.status === 401) && client !== openai && openai) {
                console.warn('[router] catalog: 401 from project key — retrying with global');
                return await openai.chat.completions.create(routerArgs);
            }
            throw e;
        });
        const raw = resp.choices[0]?.message?.content || '{}';
        const parsed = JSON.parse(raw);
        const id   = String(parsed.id || 'none');
        const conf = Number(parsed.confidence || 0);
        const reason = String(parsed.reason || '');
        if (id === 'none' || conf < 0.7) {
            console.log(`[router] catalog: id="${id}" conf=${conf} → no prompt injected (reason: ${reason})`);
            return { skillId: null, label: null, confidence: conf, reason, content: null, fromCatalog: true };
        }
        const skill = skillPrompts.getSkill(id);
        if (!skill) {
            // Hallucinated id that doesn't exist in our catalog
            console.warn(`[router] catalog: returned unknown id "${id}", treating as no-match`);
            return { skillId: null, label: null, confidence: conf, reason, content: null, fromCatalog: true };
        }
        // Phase 18 / 19.3 guard: skip skills whose content is still the
        // placeholder. The check is now isSkillPlaceholder() — covers
        // REPLACE-prefixed stubs, "TODO: fill in", short content, etc. —
        // so half-finished prompts won't get used as if they were ready.
        if (isSkillPlaceholder(skill.content)) {
            console.warn(`[router] catalog: "${skill.id}" still placeholder — skipping`);
            return { skillId: null, label: null, confidence: conf, reason: 'skill not yet configured', content: null, fromCatalog: true };
        }
        console.log(`[router] catalog: picked "${skill.id}" (${skill.label}) conf=${conf}`);
        return {
            skillId:    skill.id,
            label:      skill.label,
            confidence: conf,
            reason,
            content:    skill.content,
            fromCatalog: true,
        };
    } catch (e) {
        console.warn('[router] pickSkillFromCatalog failed:', e.message);
        return { skillId: null, label: null, confidence: 0, reason: 'router error: ' + e.message, content: null, fromCatalog: true };
    }
}

app.post('/api/chat', requireAuth, chatRateLimiter, async (req, res) => {
    if (!HAS_API_KEY) { res.json({ ok: false, useMock: true, reason: 'no_api_key' }); return; }

    const { prompt, systemPrompt, inputRate = 0.50, outputRate = 1.50, useRouter = true, sessionId, skillId, model: bodyModel, effort: bodyEffort } = req.body;
    if (!prompt) { res.status(400).json({ ok: false, error: 'prompt required' }); return; }

    // Phase 21.10 — Concept B gate (project pool AND daily cap).
    // Single helper does both checks; returns clear error codes so the UI
    // can show distinct messages for "pool empty" vs "personal cap hit".
    // Fail-OPEN on infra hiccup — we'd rather serve a request than wedge
    // the whole chat path on a DB blip. Post-hoc deduction is atomic and
    // refuses the spend if it would overshoot, so this is safe.
    try {
        const uid = req.session?.userId;
        if (uid) {
            const gate = await checkChatBudget(uid);
            if (!gate.ok) {
                const status = gate.error === 'project_pool_empty' ? 402 : 429;
                return res.status(status).json({ ok: false, ...gate });
            }
        }
    } catch (e) {
        console.warn('[chat] budget gate failed (fail-open):', e.message);
    }

    // ── Phase 12: resolve / create conversation session ──────
    //   If the caller supplied a sessionId, verify ownership BEFORE
    //   we start streaming — otherwise we'd have to 401/403 mid-SSE.
    //   If no sessionId, we create a fresh one tied to req.session.userId.
    //   The new id comes back to the client in the final `done` event.
    let chatSessionId = null;
    try {
        const uid = req.session && req.session.userId;
        if (uid) {
            if (sessionId) {
                const n = Number(sessionId);
                if (!Number.isInteger(n) || n <= 0) {
                    return res.status(400).json({ ok: false, error: 'Invalid sessionId' });
                }
                const own = await pool.query(
                    `SELECT user_id, is_deleted FROM tbl_chat_session WHERE session_id=$1`, [n]);
                const row = own.rows[0];
                if (!row || row.is_deleted || row.user_id !== uid) {
                    return res.status(404).json({ ok: false, error: 'Session not found' });
                }
                chatSessionId = n;
            } else {
                const title = String(prompt).replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
                const ins = await pool.query(
                    `INSERT INTO tbl_chat_session (user_id, title)
                     VALUES ($1, $2) RETURNING session_id`,
                    [uid, title]);
                chatSessionId = ins.rows[0].session_id;
            }
        }
    } catch (sessErr) {
        // Don't block the chat on a session-setup hiccup — just log and
        // continue without persistence.
        console.warn('[chat] session setup skipped:', sessErr.message);
    }

    // (Phase 21.10) — duplicate cap check removed; the single
    // checkChatBudget() gate above covers both pool + cap.

    res.setHeader('Content-Type', 'text/event-stream');
    // no-transform stops Cloudflare/proxies from compressing the stream;
    // X-Accel-Buffering:no stops them from buffering it. Without these a tunnel
    // holds the whole response and delivers it at once (long silent pause → the
    // full answer pops in) instead of streaming token-by-token.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (data) => {
        // If the client already hung up (e.g. pressed Stop), writing to
        // the socket throws ERR_STREAM_WRITE_AFTER_END. Guard silently.
        if (res.writableEnded) return;
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };
    const startTime = Date.now();
    // Phase 16.9: track cached + reasoning breakdowns alongside the totals.
    let inputTokens = 0, outputTokens = 0, cachedTokens = 0, reasoningTokens = 0, fullText = '';

    // ── Stop generation support (Tier 1 upgrade) ──────────────
    // When the client closes the fetch (AIClient.cancel()), abort the
    // live OpenAI stream so we stop consuming tokens, then still persist
    // whatever partial response we got so the user sees it in history.
    let clientAborted = false;
    let currentOpenAIStream = null;
    // res.on('close') is the Express-idiomatic signal for "client went
    // away before we finished" — req.on('close') is unreliable when the
    // socket is HTTP/1.1 keep-alive pooled. Listen on both to be safe.
    const onClientGone = () => {
        if (clientAborted) return;
        if (res.writableEnded) return;
        clientAborted = true;
        console.log(`[chat] client aborted mid-stream (outTokens so far=${outputTokens}, fullText=${fullText.length} chars)`);
        if (currentOpenAIStream?.controller?.abort) {
            try { currentOpenAIStream.controller.abort(); } catch (_) {}
        }
    };
    res.on('close', onClientGone);
    req.on('close', onClientGone);
    req.on('aborted', onClientGone);

    try {
        // ── Step 1: Intent Detection (Phase 1 — Router) ──────────────
        let detectedSkill = null;
        let finalSystemPrompt = systemPrompt || 'คุณเป็น AI assistant ที่ช่วยงาน SAP ABAP';
        let finalUserPrompt   = prompt;

        // Phase 17.2: resolve project-routed OpenAI client up front so the
        // router + main chat call share the same key (consistent billing
        // attribution for both turns).
        const oai = await getProjectOpenAI(req.session.userId);

        // เรียก router เฉพาะเมื่อ: useRouter=true และ ใช้ auto/PetabyteAi skill (ไม่ได้เลือก skill เฉพาะ)
        // Phase 19.3: prefer explicit skillId from frontend over string-matching
        // the systemPrompt. The string check was brittle — any user-written
        // prompt that happened to mention "PetabyteAi" got mis-classified as
        // auto-mode. skillId === 'auto' (or absent) is the authoritative signal.
        const isAutoMode = (!skillId || skillId === 'auto')
            || !systemPrompt
            || systemPrompt.includes('automatically detect')
            || systemPrompt.includes('PetabyteAi');
        if (useRouter && isAutoMode) {
            // Phase 18: JSON-catalog router (same logic as /api/thread/message).
            // High-confidence match → use catalog content.
            // Phase 31: the catalog (tbl_prompt, 50+ skills) is authoritative —
            // if it says "none", trust that instead of burning a second
            // gpt-4o-mini call on the old hardcoded detectIntent() classifier.
            // (That fallback also read a `systemPrompts` field the client never
            // actually sends, so it never did anything but cost extra latency.)
            // finalSystemPrompt is left at its base SAP/ABAP default.
            const catalogPick = await pickSkillFromCatalog(prompt, oai);
            if (catalogPick.skillId && catalogPick.content) {
                detectedSkill = {
                    skillId:    catalogPick.skillId,
                    label:      catalogPick.label,
                    intent:     'catalog',
                    confidence: catalogPick.confidence,
                    reason:     catalogPick.reason,
                };
                finalSystemPrompt = catalogPick.content;
            } else {
                detectedSkill = {
                    skillId:    null,
                    label:      'General',
                    intent:     'general',
                    confidence: catalogPick.confidence,
                    reason:     catalogPick.reason,
                };
            }
            sendEvent({ type: 'routed', skillId: detectedSkill.skillId, skillLabel: detectedSkill.label, intent: detectedSkill.intent, confidence: detectedSkill.confidence });
        }

        // ── Step 2: {code} placeholder ───────────────────────────────
        if (finalSystemPrompt.includes('{code}')) {
            finalSystemPrompt = finalSystemPrompt.replace('{code}', prompt);
            finalUserPrompt   = 'Please analyze the ABAP code provided above and apply the corrections.';
        }

        // Phase 33: language-matching rule. Skill prompts from tbl_prompt
        // don't all specify this, and the default fallback above is
        // Thai-only — so without this, a pure-English question could still
        // get a Thai-mixed reply. Appended to whatever system prompt was
        // chosen (default / skill / catalog) so it always applies.
        finalSystemPrompt += `

## Language rule
- If the user's message is written entirely in English, respond entirely in English — no Thai words mixed in.
- If the user's message mixes Thai and English (common for Thai SAP/ABAP developers), respond in Thai with English technical terms mixed in naturally.
- Match the user's language per message, not the conversation's earlier language.`;

        // ── Step 3: Phase 4 — Chat with Tool Use (multi-turn) ────────
        // Tools สำหรับ chat completions (ไม่มี file_search — ใช้เฉพาะ function tools)
        const chatTools = PHASE4_TOOLS.filter(t => t.type === 'function');

        // Phase 34: route by model. gpt-5.6 family → Responses API path (reasoning
        // effort); everything else → the existing Chat Completions loop below.
        // reqModel/reqEffort resolved from the request (validated allowlist), with
        // the env default MODEL as fallback so omitted-model requests are unchanged.
        const { model: reqModel, path: modelPath } = resolveModel(bodyModel);
        const reqEffort = resolveEffort(bodyEffort);
        const acc = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, fullText: '' };

        if (modelPath === 'responses') {
            await runResponsesTurn({
                oai, userId: req.session.userId, model: reqModel, effort: reqEffort,
                instructions: finalSystemPrompt, userPrompt: finalUserPrompt,
                tools: chatTools, sendEvent, acc,
                isAborted: () => clientAborted,
                setStream: (s) => { currentOpenAIStream = s; },
            });
            inputTokens = acc.inputTokens; outputTokens = acc.outputTokens;
            cachedTokens = acc.cachedTokens; reasoningTokens = acc.reasoningTokens;
            fullText = acc.fullText;
        } else {

        const messages = [
            { role: 'system', content: finalSystemPrompt },
            { role: 'user',   content: finalUserPrompt },
        ];

        // (oai resolved above — shared between router + main chat call)

        const MAX_TOOL_TURNS = 3;
        // Phase 32: if a response gets cut off by the token cap (finish_reason
        // "length" — e.g. AI is generating a full ABAP file that runs long),
        // automatically ask it to continue instead of silently handing the
        // user a truncated file. Capped separately from MAX_TOOL_TURNS so a
        // long file doesn't eat into the tool-calling budget.
        const MAX_LENGTH_CONTINUATIONS = 4;
        let lastFinishReason = null;
        let lengthContinuations = 0;
        let toolTurn = 0;
        while (toolTurn < MAX_TOOL_TURNS) {
            if (clientAborted) break;
            const streamArgs = {
                model: reqModel, stream: true, max_completion_tokens: 3000,
                messages,
                tools:        chatTools,
                tool_choice:  'auto',
            };
            // Only send temperature for models that accept a custom value.
            if (OAI_TEMPERATURE !== null && !_tempUnsupported) {
                streamArgs.temperature = OAI_TEMPERATURE;
            }
            // Phase 17.2.1: auto-fallback to global key on 401 from project key.
            // Also auto-drop temperature if the model rejects it (gpt-5.5, o-series).
            let stream;
            try {
                stream = await oai.chat.completions.create(streamArgs);
            } catch (e) {
                if ((e?.status === 400) && /temperature/i.test(e?.message || '') && ('temperature' in streamArgs)) {
                    _tempUnsupported = true;                 // remember → stop sending it next time
                    delete streamArgs.temperature;
                    console.warn(`[chat] model ${reqModel} rejects custom temperature — retrying without it`);
                    stream = await oai.chat.completions.create(streamArgs);
                } else if ((e?.status === 401) && oai !== openai && openai) {
                    await markProjectKeyInvalid(req.session.userId, 'chat stream 401');
                    console.warn('[chat] stream: project key 401 — retrying with global');
                    stream = await openai.chat.completions.create(streamArgs);
                } else {
                    throw e;
                }
            }
            currentOpenAIStream = stream;

            let pendingToolCalls = [];
            let finishReason    = null;
            let turnText        = '';   // only THIS API call's text (for continuation re-prompts)

            try {
                for await (const chunk of stream) {
                    if (clientAborted) break;
                    const delta = chunk.choices[0]?.delta;
                    finishReason = chunk.choices[0]?.finish_reason || finishReason;

                    // text content
                    if (delta?.content) {
                        fullText += delta.content;
                        turnText += delta.content;
                        sendEvent({ type: 'chunk', text: delta.content });
                    }

                    // accumulate tool call deltas
                    if (delta?.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index ?? 0;
                            if (!pendingToolCalls[idx]) pendingToolCalls[idx] = { id: '', function: { name: '', arguments: '' } };
                            if (tc.id)                     pendingToolCalls[idx].id                    += tc.id;
                            if (tc.function?.name)         pendingToolCalls[idx].function.name         += tc.function.name;
                            if (tc.function?.arguments)    pendingToolCalls[idx].function.arguments    += tc.function.arguments;
                        }
                    }

                    if (chunk.usage) {
                        inputTokens     += chunk.usage.prompt_tokens     || 0;
                        outputTokens    += chunk.usage.completion_tokens || 0;
                        // Phase 16.9: capture cached + reasoning sub-totals.
                        // Chat Completions API has exposed these since Oct 2024.
                        cachedTokens    += chunk.usage.prompt_tokens_details?.cached_tokens         || 0;
                        reasoningTokens += chunk.usage.completion_tokens_details?.reasoning_tokens   || 0;
                    }
                }
            } catch (streamErr) {
                // OpenAI stream throws APIUserAbortError on controller.abort().
                // That's a clean exit for user-initiated Stop — not a failure.
                if (clientAborted) break;
                throw streamErr;
            } finally {
                currentOpenAIStream = null;
            }
            lastFinishReason = finishReason;

            // User stopped mid-stream → don't loop into another tool turn
            if (clientAborted) break;

            // Phase 32: hit the token cap mid-generation (e.g. a long ABAP
            // file) — ask the model to continue instead of handing back a
            // truncated file. Doesn't consume the tool-turn budget; capped
            // separately by MAX_LENGTH_CONTINUATIONS so this can't loop forever.
            if (finishReason === 'length' && lengthContinuations < MAX_LENGTH_CONTINUATIONS) {
                lengthContinuations++;
                console.warn(`[chat] response truncated (length) — continuing (${lengthContinuations}/${MAX_LENGTH_CONTINUATIONS})`);
                messages.push({ role: 'assistant', content: turnText });
                messages.push({ role: 'user', content: 'Continue exactly where you left off. Do not repeat any earlier text or restart the file.' });
                continue;
            }

            // ถ้าไม่มี tool calls → จบ
            if (finishReason !== 'tool_calls' || pendingToolCalls.length === 0) break;

            // มี tool calls → execute แล้ว loop ต่อ
            sendEvent({ type: 'tool_call', tools: pendingToolCalls.map(tc => tc.function.name) });

            messages.push({
                role:       'assistant',
                tool_calls: pendingToolCalls.map(tc => ({
                    id: tc.id, type: 'function',
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                })),
            });

            for (const tc of pendingToolCalls) {
                const args   = JSON.parse(tc.function.arguments || '{}');
                const result = await executeTool(tc.function.name, args);
                messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
            }
            toolTurn++;
        }

        // ครบ MAX_TOOL_TURNS แล้ว AI ยังอยากเรียก tool ต่อ (finishReason ยังเป็น
        // tool_calls) แต่ยังไม่เคยส่งข้อความตอบกลับเลย → บังคับยิงอีกครั้งแบบปิด
        // tool (tool_choice:'none') ให้ AI สรุปคำตอบจากข้อมูลที่ค้นมาได้แล้ว
        // แทนที่จะปล่อยให้ผู้ใช้เจอหน้าว่างเปล่า (ไม่มี fullText, 0 output tokens)
        if (!clientAborted && fullText.length === 0 && lastFinishReason === 'tool_calls') {
            console.warn(`[chat] hit MAX_TOOL_TURNS (${MAX_TOOL_TURNS}) with no answer yet — forcing a final turn`);
            const finalArgs = {
                model: reqModel, stream: true, max_completion_tokens: 3000,
                messages,
                tools:       chatTools,
                tool_choice: 'none',
            };
            if (OAI_TEMPERATURE !== null && !_tempUnsupported) {
                finalArgs.temperature = OAI_TEMPERATURE;
            }
            try {
                let finalStream;
                try {
                    finalStream = await oai.chat.completions.create(finalArgs);
                } catch (e) {
                    if ((e?.status === 400) && /temperature/i.test(e?.message || '') && ('temperature' in finalArgs)) {
                        _tempUnsupported = true;
                        delete finalArgs.temperature;
                        finalStream = await oai.chat.completions.create(finalArgs);
                    } else {
                        throw e;
                    }
                }
                currentOpenAIStream = finalStream;
                for await (const chunk of finalStream) {
                    if (clientAborted) break;
                    const delta = chunk.choices[0]?.delta;
                    if (delta?.content) {
                        fullText += delta.content;
                        sendEvent({ type: 'chunk', text: delta.content });
                    }
                    if (chunk.usage) {
                        inputTokens     += chunk.usage.prompt_tokens     || 0;
                        outputTokens    += chunk.usage.completion_tokens || 0;
                        cachedTokens    += chunk.usage.prompt_tokens_details?.cached_tokens         || 0;
                        reasoningTokens += chunk.usage.completion_tokens_details?.reasoning_tokens   || 0;
                    }
                }
            } catch (finalErr) {
                if (!clientAborted) console.error('[chat] forced final-turn call failed:', finalErr.message);
            } finally {
                currentOpenAIStream = null;
            }
        }
        }   // ── end else: Chat Completions path (Phase 34 router split) ──

        if (inputTokens === 0) {
            inputTokens  = Math.ceil((prompt.length + finalSystemPrompt.length) / 3.5);
            outputTokens = Math.ceil(fullText.length / 3.5);
        }

        const durationMs = Date.now() - startTime;
        // Phase 21 A1 — pricing now comes from tbl_pricing (single source of
        // truth) instead of whatever the client posted in req.body. The body
        // values still serve as fallback so an unseeded model degrades to
        // sensible defaults rather than 0. cachedInputRate defaults to half
        // of input_price (matches OpenAI gpt-4o public pricing).
        const pricing = await getActivePricing(reqModel, { inputRate, outputRate });
        const useInput  = pricing.inputPrice;
        const useOutput = pricing.outputPrice;
        const useCached = (typeof req.body.cachedInputRate === 'number')
            ? req.body.cachedInputRate
            : pricing.cachedPrice;
        const nonCachedInputTokens = Math.max(0, (inputTokens || 0) - (cachedTokens || 0));
        const cost = (nonCachedInputTokens / 1000) * useInput
                   + ((cachedTokens || 0) / 1000) * useCached
                   + ((outputTokens || 0) / 1000) * useOutput;
        console.log(`[chat] ${detectedSkill ? `[${detectedSkill.intent}] ` : ''}${inputTokens}in(${cachedTokens} cached)/${outputTokens}out(${reasoningTokens} reasoning) | ฿${cost.toFixed(4)} | rates ${pricing.fromDb?'from tbl_pricing':'fallback'} | ${durationMs}ms`);

        // ── Phase 6: server-side persistence + atomic balance deduction ──
        // Previously /api/chat skipped DB write entirely — relying on the client
        // to POST /api/history afterwards. A malicious client could skip that and
        // get free chat. Now we write authoritatively here from req.session.userId.
        //
        // Phase 12: also persists the conversation turn (user + assistant)
        // into tbl_chat_message so the sidebar history is accurate.
        const userId = req.session && req.session.userId;
        if (userId) {
            try {
                const uRow = await pool.query('SELECT project_id FROM tbl_user WHERE user_id=$1', [userId]);
                const projectId = uRow.rows[0]?.project_id || null;
                if (projectId) {
                    const responseId = require('crypto').randomBytes(16).toString('hex');
                    await pool.query(`
                        INSERT INTO tbl_response
                            (response_id, project_id, user_id, model, created_at, input_param, output_param,
                             input_tokens, input_cached_tokens, output_tokens, output_reasoning_tokens, total_tokens)
                        VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8,$9,$10,$11)`,
                        [responseId, projectId, userId, reqModel,
                         prompt || '', fullText || '',
                         inputTokens || 0, cachedTokens || 0,
                         outputTokens || 0, reasoningTokens || 0,
                         (inputTokens || 0) + (outputTokens || 0)]);
                    // Phase 21.10 (Concept B) — atomic deduct from PROJECT POOL,
                    // not the per-user wallet. The WHERE >= cost clause is the real
                    // enforcement: if the pool would go negative, rowCount=0 and
                    // we log a warning. balance_before/after now snapshot the
                    // project pool (the only real money under Concept B).
                    const dedRes = await pool.query(
                        `UPDATE tbl_balance SET project_credits = project_credits - $1
                         WHERE project_id=$2 AND project_credits >= $1
                         RETURNING project_credits AS balance_after`,
                        [cost || 0, projectId]);
                    if (dedRes.rowCount === 0 && (cost || 0) > 0) {
                        console.warn(`[chat] ⚠ project pool insufficient — project:${projectId} cost:${cost}`);
                    } else if (dedRes.rowCount === 1 && (cost || 0) > 0) {
                        // Phase 21.5 — write to credit transaction journal.
                        // Only log when the deduct actually happened (rowCount=1) AND
                        // cost > 0. balance_before is derived: after + cost. ref_id
                        // points back at the chat_session this charge belongs to so
                        // an admin can trace any debit back to the conversation.
                        const balAfter  = parseFloat(dedRes.rows[0].balance_after);
                        const balBefore = balAfter + Number(cost);
                        try {
                            await pool.query(`
                                INSERT INTO tbl_user_credit_transaction
                                    (user_id, project_id, transaction_type, amount,
                                     balance_before, balance_after,
                                     ref_type, ref_id, created_by)
                                VALUES ($1, $2, 'usage', $3, $4, $5, 'chat', $6, NULL)`,
                                [userId, projectId, -Number(cost),
                                 balBefore, balAfter, chatSessionId]);
                        } catch (logErr) {
                            // Logging failure shouldn't break the chat reply — the
                            // financial state (tbl_credits) is already correct.
                            console.warn('[chat] credit log INSERT failed:', logErr.message);
                        }
                    }
                }

                // Phase 12: persist the two-turn exchange into the
                // conversation store. Either BOTH inserts land (and the
                // session counters move by +2 / +cost) or we roll back.
                if (chatSessionId) {
                    const skillId = detectedSkill?.skillId || null;
                    const client = await pool.connect();
                    try {
                        await client.query('BEGIN');
                        await client.query(
                            `INSERT INTO tbl_chat_message
                                (session_id, role, content, input_tokens, output_tokens, cost, model, skill_id)
                             VALUES ($1, 'user',      $2, NULL, NULL, NULL, NULL, $3)`,
                            [chatSessionId, prompt || '', skillId]);
                        await client.query(
                            `INSERT INTO tbl_chat_message
                                (session_id, role, content, input_tokens, output_tokens, cost, model, skill_id)
                             VALUES ($1, 'assistant', $2, $3,   $4,   $5,   $6,  $7)`,
                            [chatSessionId, fullText || '',
                             inputTokens || null, outputTokens || null,
                             cost || null, reqModel, skillId]);
                        await client.query(
                            `UPDATE tbl_chat_session
                             SET message_count = message_count + 2,
                                 total_cost    = total_cost + $1,
                                 updated_at    = NOW()
                             WHERE session_id = $2`,
                            [cost || 0, chatSessionId]);

                        // ── Phase 21: real-time rollup into tbl_daily_usage ──
                        // Phase 21.3 — UPSERT 1 row per (date, user_id). All
                        // sessions and models of the same user on the same
                        // calendar day collapse into a single rollup row.
                        // Per-model / per-session detail stays in
                        // tbl_chat_message if you need to drill down.
                        if (projectId) {
                            // Bangkok-local date so a chat at 23:55+07 lands
                            // in "today" not "tomorrow UTC". The DB-side
                            // `(NOW() AT TIME ZONE 'Asia/Bangkok')::date` is
                            // the authoritative source — use that instead of
                            // building a JS-side ISO string (which is UTC).
                            const dateRow = await client.query(
                                `SELECT (NOW() AT TIME ZONE 'Asia/Bangkok')::date AS d`);
                            const usageDate = dateRow.rows[0].d;
                            // Compute cost-side (what we pay OpenAI) using the
                            // active pricing row. If no row exists for this
                            // model fall back to 0 — we never want a missing
                            // price to break the chat write.
                            const priceRow = await client.query(
                                `SELECT input_cost, output_cost, cached_cost
                                 FROM tbl_pricing
                                 WHERE model = $1
                                   AND effective_from <= NOW()
                                   AND (effective_to IS NULL OR effective_to > NOW())
                                 ORDER BY effective_from DESC LIMIT 1`,
                                [reqModel]);
                            const pr = priceRow.rows[0] || { input_cost: 0, output_cost: 0, cached_cost: 0 };
                            const inT = inputTokens || 0;
                            const outT = outputTokens || 0;
                            const cachedT = cachedTokens || 0;
                            const reasonT = reasoningTokens || 0;
                            const turnOpenAICost =
                                  ((inT - cachedT) / 1000) * Number(pr.input_cost  || 0)
                                + (cachedT          / 1000) * Number(pr.cached_cost || pr.input_cost || 0)
                                + (outT             / 1000) * Number(pr.output_cost || 0);

                            const upRes = await client.query(
                                `INSERT INTO tbl_daily_usage
                                    (usage_date, user_id, project_id,
                                     input_tokens, cached_tokens, output_tokens, reasoning_tokens,
                                     request_count, total_cost, total_price)
                                 VALUES ($1, $2, $3,
                                         $4, $5, $6, $7,
                                         1, $8, $9)
                                 ON CONFLICT (usage_date, user_id)
                                 DO UPDATE SET
                                     project_id       = EXCLUDED.project_id,
                                     input_tokens     = tbl_daily_usage.input_tokens     + EXCLUDED.input_tokens,
                                     cached_tokens    = tbl_daily_usage.cached_tokens    + EXCLUDED.cached_tokens,
                                     output_tokens    = tbl_daily_usage.output_tokens    + EXCLUDED.output_tokens,
                                     reasoning_tokens = tbl_daily_usage.reasoning_tokens + EXCLUDED.reasoning_tokens,
                                     request_count    = tbl_daily_usage.request_count    + 1,
                                     total_cost       = tbl_daily_usage.total_cost       + EXCLUDED.total_cost,
                                     total_price      = tbl_daily_usage.total_price      + EXCLUDED.total_price,
                                     last_updated_at  = NOW()
                                 RETURNING total_price AS spent_after`,
                                [usageDate, userId, projectId,
                                 inT, cachedT, outT, reasonT,
                                 turnOpenAICost, cost || 0]);

                            // ── Phase 21.12 — deplete persistent bonus balance ──
                            // The base daily_cap is "free" each day; only the
                            // portion of today's spend ABOVE the cap draws down
                            // the carried-over bonus balance. Computed from the
                            // incremental over-cap delta of THIS charge so it
                            // stays correct across the daily reset (spent_today
                            // resets, bonus_balance persists). No cron needed.
                            const turnCost = Number(cost || 0);
                            if (turnCost > 0) {
                                const capRow = await client.query(
                                    `SELECT daily_cap, COALESCE(bonus_balance,0) AS bonus_balance
                                       FROM tbl_user WHERE user_id = $1`, [userId]);
                                const capVal = capRow.rows[0]?.daily_cap;
                                const curBonus = parseFloat(capRow.rows[0]?.bonus_balance) || 0;
                                // Only meaningful when a cap exists AND bonus remains.
                                if (capVal !== null && capVal !== undefined && curBonus > 0) {
                                    const base = parseFloat(capVal);
                                    const spentAfter  = parseFloat(upRes.rows[0].spent_after) || 0;
                                    const spentBefore = Math.max(0, spentAfter - turnCost);
                                    const overBefore = Math.max(0, spentBefore - base);
                                    const overAfter  = Math.max(0, spentAfter  - base);
                                    const consume = Math.min(curBonus, overAfter - overBefore);
                                    if (consume > 0) {
                                        await client.query(
                                            `UPDATE tbl_user
                                                SET bonus_balance = GREATEST(0, COALESCE(bonus_balance,0) - $1)
                                              WHERE user_id = $2`,
                                            [consume, userId]);
                                    }
                                }
                            }
                        }

                        await client.query('COMMIT');
                    } catch (txErr) {
                        await client.query('ROLLBACK').catch(() => {});
                        console.error('[chat] session persist failed:', txErr.message);
                    } finally {
                        client.release();
                    }
                }
            } catch (dbErr) {
                console.error('[chat] DB persistence error:', dbErr.message);
            }
        }

        sendEvent({ type: 'done', inputTokens, outputTokens, cost, durationMs, detectedSkill, sessionId: chatSessionId, stopped: clientAborted });
        if (!res.writableEnded) res.end();

    } catch (err) {
        console.error('[chat] Error:', err.message);
        if (err.status === 401 || err.status === 429) {
            sendEvent({ type: 'use_mock', reason: err.status === 429 ? 'quota_exceeded' : 'invalid_key' });
        } else { sendEvent({ type: 'error', error: err.message }); }
        if (!res.writableEnded) res.end();
    }
});

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
    try { clearInterval(_sessionJanitor); } catch (_) {}
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
