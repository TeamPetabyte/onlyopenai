// session-store.js — session ใน Postgres + cookie ที่คู่กัน
const crypto = require('crypto');
const { normalizeRole } = require('../lib/validators');

module.exports = function createSessionStore({ pool, isProd }) {
const IS_PROD = isProd;
// session อยู่ใน Postgres — รอด restart, scale หลาย instance ได้, admin เห็นว่าใครล็อกอินอยู่
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SESSION_COOKIE = 'petabyte_session';
// marker cookie อ่านได้จาก JS ไม่มี maxAge — ปิด browser = หาย = frontend รู้ว่า logout
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
    // role/สถานะอ่านสดจาก tbl_user — เก็บ snapshot ไว้ใน tbl_session แล้วการลดสิทธิ์/ปิดบัญชีไม่มีผลจนหมดอายุ
    const r = await pool.query(
        `SELECT s.token, s.user_id AS "userId", ro.role_des AS role, s.expires_at,
                s.csrf_token AS "csrfToken",
                u.username, u.must_change_password AS "mustChangePassword"
         FROM tbl_session s
         JOIN tbl_user u ON s.user_id = u.user_id
         JOIN tbl_user_role ro ON u.role_id = ro.role_id
         WHERE s.token = $1 AND s.expires_at > NOW() AND u.is_deleted = FALSE
           AND u.acc_status_id = 1
           AND (u.locked_until IS NULL OR u.locked_until <= NOW())`,
        [token]
    );
    if (r.rows.length === 0) return null;
    r.rows[0].role = normalizeRole(r.rows[0].role);
    // best-effort touch — not awaited
    pool.query('UPDATE tbl_session SET last_seen_at = NOW() WHERE token = $1', [token])
        .catch(() => {});
    return r.rows[0];
}

// cookie option helper — single source of truth so login/logout match
function _sessionCookieOpts(maxAge) {
    return {
        httpOnly: true,
        sameSite: 'strict',           // browser refuses to send on cross-site nav
        secure:   IS_PROD,            // dev = http://, prod = https://
        path:     '/',
        ...(maxAge !== undefined ? { maxAge } : {}),
    };
}

// options for the readable marker cookie — NOT HttpOnly (JS must read
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
// captured so graceful shutdown can clear it.
const _sessionJanitor = setInterval(() => {
    pool.query('DELETE FROM tbl_session WHERE expires_at <= NOW()')
        .then(r => { if (r.rowCount > 0) console.log(`[sessions] pruned ${r.rowCount} expired`); })
        .catch(e => console.warn('[sessions] janitor failed:', e.message));
}, 10 * 60 * 1000);
_sessionJanitor.unref();

function _extractToken(req) {
    // cookie คือทางเดียว (Bearer ถูกถอดแล้ว) — client นอก browser ส่ง Cookie header เอง
    return (req.cookies && req.cookies[SESSION_COOKIE]) || '';
}

return {
    SESSION_COOKIE, ACTIVE_COOKIE, CSRF_HEADER,
    createSession, getSession, deleteSession,
    _sessionCookieOpts, _markerCookieOpts, _extractToken,
    stopJanitor: () => clearInterval(_sessionJanitor),
};
};
