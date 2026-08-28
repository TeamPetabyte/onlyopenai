// quota.js — ขอโควต้าเพิ่ม + สถานะโควต้า
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const {
    getEffectiveDailyCap,
    getProjectPool,
    logAdminAction,
    pool,
    requireAdmin,
    requireAuth,
    safeError,
    spentToday,
} = ctx;

// flow: user ชน cap → POST ขอ → admin resolve; approve = bonus ของวันนี้ (Bangkok) ทำ cap ขยับ — pending ได้วันละหนึ่ง
// POST /api/quota-requests   — user requests a temporary cap increase
router.post('/api/quota-requests', requireAuth, async (req, res) => {
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
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// list: admin เห็นหมด user เห็นของตัวเอง — ?status ?limit
router.get('/api/quota-requests', requireAuth, async (req, res) => {
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
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// POST /api/quota-requests/:id/resolve   { action: 'approve' | 'deny', note?: '' }
//   admin-only.  approve → grant today-only bonus.
router.post('/api/quota-requests/:id/resolve', requireAdmin, async (req, res) => {
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
        res.status(500).json({ ok: false, ...safeError(e, req) });
    } finally { client.release(); }
});

// GET /api/quota-status     — current user's gate snapshot (for UI banners)
// Returns the same info checkChatBudget would, without consuming anything.
router.get('/api/quota-status', requireAuth, async (req, res) => {
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
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});


return router;
};
