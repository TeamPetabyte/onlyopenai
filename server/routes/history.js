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


return router;
};
