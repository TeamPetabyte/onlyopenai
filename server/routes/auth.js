// auth.js — login (lockout + audit) และ logout
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const bcrypt = require('bcrypt');
// hash ของค่าสุ่มที่ไม่มีใครรู้ ใช้เผาเวลาให้เท่ากันตอน username ไม่มีจริง (กัน user enumeration ด้วยเวลา)
const DUMMY_HASH = bcrypt.hashSync(require('crypto').randomBytes(24).toString('hex'), 10);
const {
    _extractToken,
    _markerCookieOpts,
    _sessionCookieOpts,
    ACTIVE_COOKIE,
    createSession,
    deleteSession,
    getSession,
    LOCKOUT_MINUTES,
    LOCKOUT_THRESHOLD,
    logAuthEvent,
    logger,
    loginRateLimiter,
    normalizeRole,
    pool,
    safeError,
    schemas,
    SESSION_COOKIE,
    validate,
} = ctx;
// POST /api/auth/login
router.post('/api/auth/login', loginRateLimiter, validate(schemas.login), async (req, res) => {
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
        // bad-cred / inactive responses use 401 so the
        // rate-limiter (skipSuccessfulRequests:true) actually counts them.
        if (r.rows.length === 0) {
            // เทียบกับ hash หลอกให้เสียเวลาเท่ากัน — ตอบทันทีจะบอกได้จากเวลาว่า username ไหนมีจริง
            await bcrypt.compare(password, DUMMY_HASH);
            // log unknown username — no user_id since it doesn't exist.
            logAuthEvent('login_fail', null, req, { reason: 'unknown_user', username });
            return res.status(401).json({ ok: false, error: 'Invalid credentials' });
        }
        const u = r.rows[0];

        // account lockout check (before bcrypt — saves CPU on locked accounts)
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
            // increment failed_attempts, lock if over threshold.
            // Single UPDATE so it's atomic; CASE handles the threshold inside SQL.
            // ตัวนับต้องเริ่มใหม่เมื่อ lock ก่อนหน้าหมดอายุ — ไม่งั้นผิดครั้งเดียวหลังปลดล็อกก็โดนล็อกอีก 15 นาที
            const upd = await pool.query(
                `UPDATE tbl_user
                    SET failed_attempts = CASE
                            WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 1
                            ELSE failed_attempts + 1
                        END,
                        locked_until = CASE
                            WHEN locked_until IS NOT NULL AND locked_until <= NOW()
                                THEN (CASE WHEN 1 >= $2 THEN NOW() + ($3 || ' minutes')::INTERVAL ELSE NULL END)
                            WHEN failed_attempts + 1 >= $2 THEN NOW() + ($3 || ' minutes')::INTERVAL
                            ELSE locked_until
                        END
                  WHERE user_id = $1
                  RETURNING failed_attempts, locked_until`,
                [u.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES]);
            const row = upd.rows[0];
            if (row.locked_until && new Date(row.locked_until) > new Date()) {
                logger.warn({ event: 'lockout', user_id: u.id, minutes: LOCKOUT_MINUTES,
                              failed_attempts: row.failed_attempts }, 'account locked');
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

        // ปิดแถว login_ok ที่ค้าง (crash/ปิด browser/หมดอายุ) — stamp เวลาที่น่าเชื่อสุด: last_seen_at → expires_at → NOW()
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

        // log_out_* ต้องเป็น NULL จนกว่าจะ logout จริง — เคย pre-fill แล้วประวัติเพี้ยนทั้งหน้า
        const ipAddr = (req.clientIp || req.ip || '').toString().slice(0, 45);
        await pool.query(`INSERT INTO tbl_audit_log
                (user_id, log_in_date, log_in_time, event_type, detail, ip)
            VALUES ($1, CURRENT_DATE, NOW(), 'login_ok', $2, $3)`,
            [u.id, JSON.stringify({ must_change_password: !!u.must_change_password }), ipAddr]);
        const role = normalizeRole(u.role);
        // createSession returns both session token + per-session CSRF token
        const { token, csrf } = await createSession({ id: u.id, username: u.username, role });
        // cookie HttpOnly + session-scoped (ปิด browser = logout); tbl_session กันอีกชั้นที่ 24h
        res.cookie(SESSION_COOKIE, token, _sessionCookieOpts());
        res.cookie(ACTIVE_COOKIE, '1', _markerCookieOpts());
        res.json({
            ok: true,
            // ไม่ส่ง token ใน body — session อยู่ใน HttpOnly cookie เท่านั้น
            csrfToken: csrf,            // client must echo this in X-CSRF-Token on POST/PUT/DELETE
            mustChangePassword: !!u.must_change_password,    // client redirects to pw-change page
            user: { id: u.id, username: u.username, displayName: `${u.name} ${u.surname}`.trim(),
                    role, plan: role === 'admin' ? 'enterprise' : 'pro',
                    balance: parseFloat(u.balance), projectId: u.project_id,
                    mustChangePassword: !!u.must_change_password },
        });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});


// POST /api/logout — ทุก DB call เป็น best-effort: logout ห้ามทำ server ตาย (เคยเจอ unhandled rejection ปิด process)
router.post('/api/logout', async (req, res) => {
    const token = _extractToken(req);
    let sess = null;
    if (token) {
        try { sess = await getSession(token); }
        catch (e) { console.error('[logout] getSession failed (non-fatal):', e.message); }
    }
    // เชื่อเฉพาะ session จริง — เคยรับ req.body.userId ทำให้คนนอกปิดแถว login_ok ของใครก็ได้
    const userId = sess?.userId || null;
    if (token) {
        try { await deleteSession(token); }
        catch (e) { console.error('[logout] deleteSession failed (non-fatal):', e.message); }
    }
    // clear the HttpOnly cookie too — browsers won't auto-clear it.
    // Options must match what was set (path/sameSite/secure) or some browsers ignore.
    res.clearCookie(SESSION_COOKIE, _sessionCookieOpts());
    res.clearCookie(ACTIVE_COOKIE, _markerCookieOpts());
    if (userId) {
        try {
            // stamp เฉพาะแถว login_ok ล่าสุดที่ยังไม่ปิด ผ่าน PK — เคย match ด้วยวันที่แล้วโดนแถวผิด
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
        // also record logout as its own event row for clean history.
        try { logAuthEvent('logout', userId, req, { via: token ? 'token' : 'body' }); }
        catch (e) { console.error('[logout] logAuthEvent failed (non-fatal):', e.message); }
    }
    res.json({ ok: true });
});



return router;
};
