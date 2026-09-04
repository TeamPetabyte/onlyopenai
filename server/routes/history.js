// history.js — ประวัติการใช้ (คิดราคาผ่าน lib/pricing-sql)
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const {
    pool,
    PRICING_COST_EXPR,
    PRICING_LATERAL_JOIN,
    requireAdmin,
    requireAuth,
    safeError,
} = ctx;
router.get('/api/history', requireAuth, async (req, res) => {
    // alias คอลัมน์ให้ frontend เดิม; cost คำนวณจาก token × tbl_pricing ไม่ใช่ rate เก่า
    try {
        // user ธรรมดาอ่านได้เฉพาะของตัวเอง — query userId เชื่อไม่ได้ และสาขา "ทุกแถว" เป็นของ admin
        const isAdmin = req.session.role === 'admin' || req.session.role === 'trainer';
        const userId = isAdmin ? req.query.userId : req.session.userId;
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
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// DELETE /api/history  — ล้าง log (admin)
router.delete('/api/history', requireAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM tbl_response');
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// POST /api/history  — บันทึกหลังรัน skill
router.post('/api/history', requireAuth, async (req, res) => {
    // DEPRECATED no-op — endpoint นี้เคยหักเงินซ้ำกับ /api/chat (pool ลด ~2×); เหลือไว้กัน 404
    res.json({ ok: true, deducted: false, deprecated: true });
});



return router;
};
