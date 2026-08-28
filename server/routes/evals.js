// evals.js — eval harness: run เดียวทั้งระบบ + judge
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const {
    expensiveRateLimiter,
    HAS_API_KEY,
    logAdminAction,
    pool,
    requireTrainer,
    resolveEffort,
    resolveModel,
    runSkillPromptOnce,
    safeError,
    skillPrompts,
} = ctx;
let EVAL_ACTIVE = false;               // process-wide single-run guard
const EVAL_CANCEL = new Set();         // runIds flagged for cancellation

const EVAL_JUDGE_SYSTEM = `You are a strict grader for an SAP ABAP AI assistant.
Compare the CANDIDATE ANSWER against the REFERENCE ANSWER (approved by a senior ABAP developer) for the given QUESTION.
Scoring rubric:
- "issues" (0-2): did the candidate identify the same problems as the reference?
- "fix" (0-2): is the candidate's corrected code / recommendation technically correct and equivalent to the reference? A candidate that REPORTS a behaviour-changing finding and asks about it, instead of rewriting the code, is following the assistant's rules — judge whether the finding is right, not whether code was rewritten.
- "overall" (0-10): holistic quality versus the reference.
- "pass": true only if overall >= 7 AND the candidate makes no incorrect technical claim.
Do NOT reward verbosity. Judge technical substance only.
Reply with ONLY one JSON object, no markdown, no commentary:
{"issues":n,"fix":n,"overall":n,"pass":true|false,"reason":"<one short sentence>"}`;

// judge ใช้ runSkillPromptOnce เส้นทางเดียวกับ Lab — prompt judge ไม่มี {code} เลยผ่านเฉย ๆ
async function judgeEvalAnswer({ userId, question, expected, candidate, judgeModel, judgeEffort }) {
    const payload =
        'QUESTION:\n' + question +
        '\n\nREFERENCE ANSWER (golden):\n' + expected +
        '\n\nCANDIDATE ANSWER:\n' + candidate;
    const r = await runSkillPromptOnce({
        userId, skillContent: EVAL_JUDGE_SYSTEM, question: payload,
        model: judgeModel, effort: judgeEffort,
    });
    let parsed = null;
    try {
        const m = String(r.answer || '').match(/\{[\s\S]*\}/);
        if (m) {
            const j = JSON.parse(m[0]);
            if (typeof j.pass === 'boolean' && j.overall !== undefined) parsed = j;
        }
    } catch (_) { /* parse failure handled by caller */ }
    return { parsed, raw: r.answer, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
}

// The background loop for one run. Never throws — every failure lands in
// tbl_eval_run.error / tbl_eval_result.error so the UI can show it.
async function executeEvalRun(runId, { userId, skillContent, model, effort, judgeModel, judgeEffort, cases }) {
    let done = 0, pass = 0, inTok = 0, outTok = 0;
    try {
        for (const c of cases) {
            if (EVAL_CANCEL.has(runId)) {
                await pool.query(
                    `UPDATE tbl_eval_run SET status='cancelled', finished_at=NOW() WHERE run_id=$1`, [runId]);
                return;
            }
            const r = { answer: '', passed: false, score: null, judgeJson: null, reason: null, error: null, it: 0, ot: 0 };
            try {
                const a = await runSkillPromptOnce({
                    userId, skillContent, question: c.question, model, effort,
                });
                r.answer = a.answer; r.it += a.inputTokens; r.ot += a.outputTokens;

                // Golden reference: senior's correction, else the approved answer.
                const expected = (c.corrected_answer || '').trim() || c.answer;
                const j = await judgeEvalAnswer({
                    userId, question: c.question, expected, candidate: r.answer, judgeModel, judgeEffort,
                });
                r.it += j.inputTokens; r.ot += j.outputTokens;
                if (j.parsed) {
                    r.passed    = !!j.parsed.pass;
                    r.score     = Math.max(0, Math.min(10, Number(j.parsed.overall) || 0));
                    r.reason    = String(j.parsed.reason || '').slice(0, 500);
                    r.judgeJson = JSON.stringify(j.parsed);
                } else {
                    r.error  = 'judge JSON parse failed';
                    r.reason = String(j.raw || '').slice(0, 200);
                }
            } catch (e) {
                r.error = e.message;
            }
            done++; if (r.passed) pass++;
            inTok += r.it; outTok += r.ot;
            await pool.query(
                `INSERT INTO tbl_eval_result
                     (run_id, log_id, category, answer, passed, score, judge_json, judge_reason, error,
                      input_tokens, output_tokens)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [runId, c.log_id, c.category, r.answer, r.passed, r.score, r.judgeJson, r.reason, r.error, r.it, r.ot]);
            await pool.query(
                `UPDATE tbl_eval_run
                    SET done_cases=$1, pass_cases=$2, input_tokens=$3, output_tokens=$4
                  WHERE run_id=$5`,
                [done, pass, inTok, outTok, runId]);
        }
        await pool.query(
            `UPDATE tbl_eval_run
                SET status='done', score_pct=$1, finished_at=NOW()
              WHERE run_id=$2`,
            [cases.length ? Math.round((pass / cases.length) * 1000) / 10 : 0, runId]);
    } catch (e) {
        console.error('[eval-run]', runId, e.message);
        try {
            await pool.query(
                `UPDATE tbl_eval_run SET status='failed', error=$1, finished_at=NOW() WHERE run_id=$2`,
                [e.message, runId]);
        } catch (_) {}
    } finally {
        EVAL_ACTIVE = false;
        EVAL_CANCEL.delete(runId);
    }
}

// POST /api/evals — start an exam. Body: { skill, model, effort, judgeModel, judgeEffort }.
router.post('/api/evals', requireTrainer, expensiveRateLimiter, async (req, res) => {
    if (!HAS_API_KEY) return res.json({ ok: false, error: 'No API key configured' });
    // จอง slot แบบ sync ก่อน await ใด ๆ — กัน TOCTOU จาก double-click; ทุก early-return ต้องคืน slot
    if (EVAL_ACTIVE) return res.status(409).json({ ok: false, error: 'มี eval กำลังรันอยู่ — รอให้จบก่อน' });
    EVAL_ACTIVE = true;

    const skill = skillPrompts.getSkill(String(req.body?.skill || ''));
    if (!skill) { EVAL_ACTIVE = false; return res.status(404).json({ ok: false, error: 'skill not found' }); }

    const { model: reqModel }  = resolveModel(req.body.model);
    const reqEffort            = resolveEffort(req.body.effort);
    // Judge defaults: terra/high — strong enough to grade, cheaper than sol.
    const { model: judgeModel } = resolveModel(req.body.judgeModel || 'gpt-5.6-terra');
    const judgeEffort           = resolveEffort(req.body.judgeEffort || 'high');

    try {
        const cs = await pool.query(
            `SELECT log_id, question, answer, corrected_answer, category
               FROM tbl_skill_test_log
              WHERE skill_id=$1 AND is_eval_case AND verdict IS NOT NULL
              ORDER BY log_id`, [skill.id]);
        if (!cs.rows.length) {
            EVAL_ACTIVE = false;
            return res.status(400).json({ ok: false, error: 'skill นี้ยังไม่มีข้อสอบ (⭐) — เข้าหน้า Prompt Lab แล้วกด ⭐ เคสที่ตัดสินแล้วก่อน' });
        }

        const ins = await pool.query(
            `INSERT INTO tbl_eval_run
                 (skill_id, skill_label, model, effort, judge_model, judge_effort, total_cases, started_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING run_id`,
            [skill.id, skill.label || null, reqModel, reqEffort, judgeModel, judgeEffort,
             cs.rows.length, req.session.userId]);
        const runId = ins.rows[0].run_id;

        // Slot already claimed above; the runner's finally will release it.
        // Fire-and-forget: the loop reports its own progress/errors to the DB.
        executeEvalRun(runId, {
            userId: req.session.userId,
            skillContent: skill.content,
            model: reqModel, effort: reqEffort,
            judgeModel, judgeEffort,
            cases: cs.rows,
        });

        logAdminAction(req, {
            action: 'start_eval_run',
            targetType: 'skill',
            extra: { runId, skillId: skill.id, model: reqModel, effort: reqEffort, judgeModel, cases: cs.rows.length },
        });
        res.json({ ok: true, runId, total: cs.rows.length });
    } catch (e) {
        EVAL_ACTIVE = false;
        console.error('[evals/start]', e.message);
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// GET /api/evals?skill=<id>&limit=20 — run history (newest first) for the
// report page: score trend + the table of past sittings.
router.get('/api/evals', requireTrainer, async (req, res) => {
    const skillId = String(req.query.skill || '').trim();
    const limit   = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    try {
        const r = await pool.query(
            `SELECT run_id, skill_id, skill_label, model, effort, judge_model, judge_effort,
                    status, total_cases, done_cases, pass_cases, score_pct, error,
                    input_tokens, output_tokens, started_at, finished_at
               FROM tbl_eval_run
              ${skillId ? 'WHERE skill_id=$1' : ''}
              ORDER BY run_id DESC
              LIMIT ${limit}`,
            skillId ? [skillId] : []);
        res.json({ ok: true, runs: r.rows, active: EVAL_ACTIVE });
    } catch (e) {
        console.error('[evals/list]', e.message);
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// GET /api/evals/:runId — one run + all its per-case results (poll target
// while running; full report once done).
router.get('/api/evals/:runId', requireTrainer, async (req, res) => {
    const runId = parseInt(req.params.runId, 10);
    if (!Number.isInteger(runId)) return res.status(400).json({ ok: false, error: 'bad runId' });
    try {
        const run = await pool.query('SELECT * FROM tbl_eval_run WHERE run_id=$1', [runId]);
        if (!run.rows.length) return res.status(404).json({ ok: false, error: 'run not found' });
        const results = await pool.query(
            `SELECT r.result_id, r.log_id, r.category, r.passed, r.score, r.judge_reason, r.error,
                    r.input_tokens, r.output_tokens, r.answer,
                    LEFT(l.question, 160) AS question_preview,
                    l.question, l.answer AS old_answer, l.corrected_answer
               FROM tbl_eval_result r
               LEFT JOIN tbl_skill_test_log l ON l.log_id = r.log_id
              WHERE r.run_id=$1
              ORDER BY r.result_id`, [runId]);
        res.json({ ok: true, run: run.rows[0], results: results.rows });
    } catch (e) {
        console.error('[evals/:id]', e.message);
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// POST /api/evals/:runId/cancel — flag a running exam to stop after the
// current case (each case is atomic; we never kill mid-request).
router.post('/api/evals/:runId/cancel', requireTrainer, async (req, res) => {
    const runId = parseInt(req.params.runId, 10);
    if (!Number.isInteger(runId)) return res.status(400).json({ ok: false, error: 'bad runId' });
    EVAL_CANCEL.add(runId);
    logAdminAction(req, { action: 'cancel_eval_run', targetType: 'skill', extra: { runId } });
    res.json({ ok: true, runId });
});


return router;
};
