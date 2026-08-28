// skill-test-logs.js — ผลเทสต์ skill + verdict + eval case
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const {
    logAdminAction,
    pool,
    requireTrainer,
    safeError,
} = ctx;
const TEST_VERDICTS = ['correct', 'partial', 'incorrect'];

// POST /api/skill-test-logs/:logId/verdict — save (or overwrite) a judgement.
// Body: { verdict, correctedAnswer, note, category }. Re-judging is allowed:
// the latest judgement wins (judged_by/judged_at overwritten).
router.post('/api/skill-test-logs/:logId/verdict', requireTrainer, async (req, res) => {
    const logId = parseInt(req.params.logId, 10);
    if (!Number.isInteger(logId)) return res.status(400).json({ ok: false, error: 'bad logId' });

    const verdict = String(req.body?.verdict || '');
    if (!TEST_VERDICTS.includes(verdict)) {
        return res.status(400).json({ ok: false, error: 'verdict must be one of: ' + TEST_VERDICTS.join(', ') });
    }
    const correctedAnswer = String(req.body?.correctedAnswer || '').trim() || null;
    const note            = String(req.body?.note || '').trim() || null;
    const category        = String(req.body?.category || '').trim().slice(0, 40) || null;

    try {
        const upd = await pool.query(
            `UPDATE tbl_skill_test_log
                SET verdict=$1, corrected_answer=$2, verdict_note=$3, category=$4,
                    judged_by=$5, judged_at=NOW()
              WHERE log_id=$6
              RETURNING log_id, skill_id, verdict, judged_at`,
            [verdict, correctedAnswer, note, category, req.session.userId, logId]);
        if (!upd.rows.length) return res.status(404).json({ ok: false, error: 'log not found' });

        logAdminAction(req, {
            action: 'judge_skill_test',
            targetType: 'skill',
            extra: { logId, skillId: upd.rows[0].skill_id, verdict, hasCorrection: !!correctedAnswer, category },
        });
        res.json({ ok: true, logId, verdict, judgedAt: upd.rows[0].judged_at });
    } catch (e) {
        console.error('[skill-test-logs/verdict]', e.message);
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// POST /api/skill-test-logs/:logId/eval-case — Phase 30: promote/demote a
// judged case into the exam set (⭐). Promotion needs a golden reference:
// verdict='correct' (the answer itself is the reference) or a
// corrected_answer supplied by the senior.
router.post('/api/skill-test-logs/:logId/eval-case', requireTrainer, async (req, res) => {
    const logId = parseInt(req.params.logId, 10);
    if (!Number.isInteger(logId)) return res.status(400).json({ ok: false, error: 'bad logId' });
    const on = !!req.body?.on;
    try {
        const cur = await pool.query(
            'SELECT verdict, corrected_answer, skill_id FROM tbl_skill_test_log WHERE log_id=$1', [logId]);
        if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'log not found' });
        const row = cur.rows[0];
        if (on && !(row.verdict === 'correct' || (row.corrected_answer || '').trim())) {
            return res.status(400).json({
                ok: false,
                error: 'ต้องตัดสินเป็น "ถูกต้อง" หรือมีเฉลย (corrected answer) ก่อนถึงจะเข้าชุดข้อสอบได้',
            });
        }
        await pool.query('UPDATE tbl_skill_test_log SET is_eval_case=$1 WHERE log_id=$2', [on, logId]);
        logAdminAction(req, {
            action: on ? 'promote_eval_case' : 'demote_eval_case',
            targetType: 'skill',
            extra: { logId, skillId: row.skill_id },
        });
        res.json({ ok: true, logId, isEvalCase: on });
    } catch (e) {
        console.error('[skill-test-logs/eval-case]', e.message);
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// GET /api/skill-test-logs?skill=<id>&verdict=<correct|partial|incorrect|pending>&limit&offset
// List rows (question/answer previews only) + verdict stats for the same filter
// scope (skill), so the history modal renders header counts in one call.
router.get('/api/skill-test-logs', requireTrainer, async (req, res) => {
    const skillId = String(req.query.skill || '').trim();
    const verdict = String(req.query.verdict || '').trim();
    const limit   = Math.min(Math.max(parseInt(req.query.limit, 10)  || 50, 1), 200);
    const offset  = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where  = [];
    const params = [];
    if (skillId) { params.push(skillId); where.push(`skill_id=$${params.length}`); }
    if (verdict === 'pending')                 where.push('verdict IS NULL');
    else if (TEST_VERDICTS.includes(verdict)) { params.push(verdict); where.push(`verdict=$${params.length}`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    try {
        const rowsQ = pool.query(
            `SELECT log_id, skill_id, skill_label, model, effort, verdict, category,
                    is_eval_case,
                    LEFT(question, 160) AS question_preview,
                    LEFT(answer, 160)   AS answer_preview,
                    input_tokens, output_tokens, judged_at, created_at
               FROM tbl_skill_test_log ${whereSql}
              ORDER BY created_at DESC
              LIMIT ${limit} OFFSET ${offset}`, params);
        // Stats scope = the skill filter only (not the verdict filter), so the
        // header counts stay stable while the admin flips verdict filters.
        const statsQ = pool.query(
            `SELECT COUNT(*)::int                                        AS total,
                    COUNT(*) FILTER (WHERE verdict='correct')::int       AS correct,
                    COUNT(*) FILTER (WHERE verdict='partial')::int       AS partial,
                    COUNT(*) FILTER (WHERE verdict='incorrect')::int     AS incorrect,
                    COUNT(*) FILTER (WHERE verdict IS NULL)::int         AS pending,
                    COUNT(*) FILTER (WHERE is_eval_case)::int            AS eval_cases
               FROM tbl_skill_test_log ${skillId ? 'WHERE skill_id=$1' : ''}`,
            skillId ? [skillId] : []);
        const [rows, stats] = await Promise.all([rowsQ, statsQ]);
        res.json({ ok: true, rows: rows.rows, stats: stats.rows[0] });
    } catch (e) {
        console.error('[skill-test-logs]', e.message);
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// GET /api/skill-test-logs/:logId — full record for the detail view.
router.get('/api/skill-test-logs/:logId', requireTrainer, async (req, res) => {
    const logId = parseInt(req.params.logId, 10);
    if (!Number.isInteger(logId)) return res.status(400).json({ ok: false, error: 'bad logId' });
    try {
        const r = await pool.query('SELECT * FROM tbl_skill_test_log WHERE log_id=$1', [logId]);
        if (!r.rows.length) return res.status(404).json({ ok: false, error: 'log not found' });
        res.json({ ok: true, log: r.rows[0] });
    } catch (e) {
        console.error('[skill-test-logs/:id]', e.message);
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// ── Phase 30: eval harness — batch runner + AI judge ──────────────────────
// One exam sitting: take every ⭐ case of a skill, get a FRESH answer from
// the model under test (same pipeline as the Lab), then have a judge model
// compare it against the golden reference and emit a rubric JSON. Results
// stream into tbl_eval_result; tbl_eval_run carries live progress so the UI
// can poll. Only ONE run at a time (they're slow + cost real OpenAI money).


return router;
};
