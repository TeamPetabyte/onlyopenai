// auth.js — login (lockout + audit) และ logout
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const bcrypt = require('bcrypt');
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
            // Phase 39: `token` no longer returned in the body — the session
            // rides ONLY in the HttpOnly cookie above. Non-browser clients
            // read it from Set-Cookie (curl -c jar).
            csrfToken: csrf,            // Phase 9: client must echo this in X-CSRF-Token on POST/PUT/DELETE
            mustChangePassword: !!u.must_change_password,    // Phase 8: client redirects to pw-change page
            user: { id: u.id, username: u.username, displayName: `${u.name} ${u.surname}`.trim(),
                    role, plan: role === 'admin' ? 'enterprise' : 'pro',
                    balance: parseFloat(u.balance), projectId: u.project_id,
                    mustChangePassword: !!u.must_change_password },
        });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});


// POST /api/logout
// Phase 16.6: defensive wrap — every DB call in this handler is best-effort.
// A transient EHOSTUNREACH on tbl_session/tbl_audit_log used to throw an
// unhandled promise rejection from the bare `await getSession(token)` path,
// which Node 24 turns into a process exit. Logout must never crash the server.
router.post('/api/logout', async (req, res) => {
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


return router;
};
