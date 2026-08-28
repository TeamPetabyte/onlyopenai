// sync.js — สถานะ/สั่งรัน usage sync
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const {
    expensiveRateLimiter,
    getSyncState,
    openaiAdmin,
    pool,
    requireAdmin,
    runUsageSync,
    safeError,
} = ctx;
// GET /api/sync-status
// Returns the current sync state + per-project usage summary (drift report).
router.get('/api/sync-status', requireAdmin, async (req, res) => {
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
            running: getSyncState().running,
            intervalMin: parseInt(process.env.OPENAI_USAGE_SYNC_INTERVAL_MIN, 10) || 15,
            adminKeyConfigured: openaiAdmin.isEnabled(),
            projects: projects.rows,
        });
    } catch (e) {
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});


/** Phase 19.3: stronger placeholder detector — flags REPLACE-prefixed stubs,
 *  "TODO: fill in", "PLACEHOLDER", one-line stubs etc.
 *  Phase 40: the rule itself now lives in skill-prompts.js, because the
 *  registry needs it too (to keep stubs out of the router catalog) and two
 *  copies would eventually disagree about what counts as "not ready". */


// POST /api/sync-now — manual trigger. Returns the result of THIS run.
router.post('/api/sync-now', requireAdmin, expensiveRateLimiter, async (req, res) => {
    try {
        const result = await runUsageSync('manual:' + (req.session?.username || 'admin'));
        res.json({ ok: true, ...result });
    } catch (e) {
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});


return router;
};
