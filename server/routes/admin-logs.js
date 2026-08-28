// admin-logs.js — audit log + action log (อ่านอย่างเดียว)
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const {
    pool,
    requireAdmin,
    safeError,
} = ctx;
// GET /api/audit-log ?event ?userId ?limit — LEFT JOIN ให้แถว user_id NULL ยังโชว์
router.get('/api/audit-log', requireAdmin, async (req, res) => {
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
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// GET /api/action-log ?action ?target ?targetId ?userId ?limit
router.get('/api/action-log', requireAdmin, async (req, res) => {
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
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});


return router;
};
