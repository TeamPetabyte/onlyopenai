// session-store.js — session ใน Postgres + cookie ที่คู่กัน
const crypto = require('crypto');
const { normalizeRole } = require('../lib/validators');

module.exports = function createSessionStore({ pool, isProd }) {
const IS_PROD = isProd;
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
    // Phase 9: HttpOnly cookie (can't be stolen by XSS).
    // Phase 39: Bearer fallback removed — the cookie is the ONLY auth path.
    // Non-browser clients (curl, smoke tests) authenticate by sending the
    // cookie explicitly:  curl -H "Cookie: petabyte_session=<token>" ...
    // (or use -c/-b cookie jars around /api/auth/login).
    return (req.cookies && req.cookies[SESSION_COOKIE]) || '';
}

return {
    SESSION_COOKIE, ACTIVE_COOKIE, CSRF_HEADER,
    createSession, getSession, deleteSession,
    _sessionCookieOpts, _markerCookieOpts, _extractToken,
    stopJanitor: () => clearInterval(_sessionJanitor),
};
};
