// skills.js — CRUD skill prompt + ทดสอบใน Prompt Lab
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const crypto = require('crypto');
const {
    expensiveRateLimiter,
    HAS_API_KEY,
    isSkillPlaceholder,
    logAdminAction,
    openai,
    pickSkillFromCatalog,
    pool,
    requireTrainer,
    runSkillPromptOnce,
    safeError,
    skillPrompts,
} = ctx;
router.get('/api/skills', requireTrainer, (req, res) => {
    try {
        // Strip the full `content` field — could be many KB; admin UI list
        // only needs name/description/preview. Detail view (future) can
        // call a per-skill endpoint if needed.
        const status = skillPrompts.getStatus();
        const skills = skillPrompts.getSkills().map(s => ({
            id:             s.id,
            label:          s.label,
            description:    s.description,
            openaiPromptId: s.openaiPromptId,
            contentPreview: s.content.length > 200 ? s.content.slice(0, 200) + '…' : s.content,
            contentLength:  s.content.length,
            isPlaceholder:  isSkillPlaceholder(s.content),
        }));
        res.json({ ok: true, status, skills });
    } catch (e) {
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

router.post('/api/skills/reload', requireTrainer, async (req, res) => {
    try {
        await skillPrompts.load();
        const status = skillPrompts.getStatus();
        logAdminAction(req, {
            action: 'reload_skill_prompts',
            targetType: 'system',
            extra: { count: status.count, error: status.error },
        });
        res.json({ ok: true, status });
    } catch (e) {
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// GET /api/skills/:id — full record incl. content (admin edit modal needs it;
// the list endpoint deliberately strips content to keep the payload small).
router.get('/api/skills/:id', requireTrainer, (req, res) => {
    try {
        const s = skillPrompts.getSkill(req.params.id);
        if (!s) return res.status(404).json({ ok: false, error: 'skill not found' });
        res.json({ ok: true, skill: s });
    } catch (e) {
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// POST /api/skills — create or update a skill (Phase 22 prompt management).
// Body: { id, label, description, content, openaiPromptId }. Writes
// skill-prompts.json atomically and hot-reloads the registry so the chat
// router uses the new prompt immediately.
router.post('/api/skills', requireTrainer, async (req, res) => {
    try {
        const body = req.body || {};
        const result = await skillPrompts.upsertSkill({
            id:             body.id,
            label:          body.label,
            description:    body.description,
            content:        body.content,
            openaiPromptId: body.openaiPromptId,
            updatedBy:      (req.session && (req.session.username || req.session.userId)) || 'admin',
        });
        if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
        logAdminAction(req, {
            action: result.created ? 'create_skill_prompt' : 'update_skill_prompt',
            targetType: 'skill',
            targetId: result.skill.id,
            extra: { label: result.skill.label, contentLength: result.skill.content.length },
        });
        res.json({ ok: true, created: result.created, status: skillPrompts.getStatus() });
    } catch (e) {
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// DELETE /api/skills/:id — remove a skill from the registry.
router.delete('/api/skills/:id', requireTrainer, async (req, res) => {
    try {
        const result = await skillPrompts.deleteSkill(req.params.id, {
            deletedBy: (req.session && (req.session.username || req.session.userId)) || 'admin',
        });
        if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
        logAdminAction(req, {
            action: 'delete_skill_prompt',
            targetType: 'skill',
            targetId: result.deleted,
        });
        res.json({ ok: true, status: skillPrompts.getStatus() });
    } catch (e) {
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});


// POST /api/skills/:id/test — admin-only QA sandbox: run a test prompt
// against a skill's system prompt without touching the chat budget gate or
// persisting a tbl_chat_session row. Non-streaming (one-shot QA check, not
// a live chat UX). Supports a short tool-calling loop since some skills
// (find_bapi, lookup_auth_object, etc.) only produce a meaningful answer
// via tool results.
router.post('/api/skills/:id/test', requireTrainer, expensiveRateLimiter, async (req, res) => {
    if (!HAS_API_KEY) return res.json({ ok: false, error: 'No API key configured' });

    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt required' });

    // Phase 37: id "auto" — the same catalog router live chat uses picks the
    // skill, so seniors don't have to know which prompt fits their question.
    // The run is logged under the DETECTED skill, so history shows the match.
    let skill = null, routed = null;
    if (req.params.id === 'auto') {
        const pick = await pickSkillFromCatalog(prompt, openai);
        if (pick.skillId && pick.content) {
            skill  = skillPrompts.getSkill(pick.skillId)
                  || { id: pick.skillId, label: pick.label, content: pick.content };
            routed = { skillId: skill.id, label: skill.label || skill.id, confidence: pick.confidence };
        } else {
            skill  = { id: 'general', label: '💬 General', content: 'คุณเป็น AI assistant ที่ช่วยงาน SAP ABAP' };
            routed = { skillId: null, label: skill.label + ' (no skill matched)', confidence: pick.confidence };
        }
    } else {
        skill = skillPrompts.getSkill(req.params.id);
        if (!skill) return res.status(404).json({ ok: false, error: 'skill not found' });
    }

    try {
        // Phase 34: model + effort from the request (validated allowlist).
        const { answer, inputTokens, outputTokens, model: reqModel, effort: reqEffort } =
            await runSkillPromptOnce({
                userId: req.session.userId,
                skillContent: skill.content,
                question: prompt,
                model: req.body.model,
                effort: req.body.effort,
            });

        logAdminAction(req, {
            action: 'test_skill_prompt',
            targetType: 'skill',
            extra: { skillId: skill.id, model: reqModel, effort: reqEffort, promptPreview: prompt.slice(0, 100), inputTokens, outputTokens },
        });

        // Phase 28: persist the full question+answer so a senior can judge it
        // later (verdict + corrected answer → golden dataset). A failed insert
        // must NOT fail the test itself — the answer is still useful on screen.
        let logId = null;
        try {
            const ins = await pool.query(
                `INSERT INTO tbl_skill_test_log
                     (skill_id, skill_label, prompt_sha256, prompt_length,
                      model, effort, question, answer, input_tokens, output_tokens, tested_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 RETURNING log_id`,
                [skill.id, skill.label || null,
                 crypto.createHash('sha256').update(skill.content, 'utf8').digest('hex'),
                 skill.content.length,
                 reqModel, reqEffort, prompt, answer, inputTokens, outputTokens,
                 req.session.userId]);
            logId = ins.rows[0].log_id;
        } catch (e2) {
            console.error('[skills/test] log insert failed:', e2.message);
        }

        res.json({ ok: true, answer, model: reqModel, effort: reqEffort, inputTokens, outputTokens, logId, routed });
    } catch (e) {
        console.error('[skills/test]', e.message);
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// ── Phase 28: skill test log — verdict + history ──────────────────────────
// The senior-dev training loop: every /api/skills/:id/test run is persisted
// to tbl_skill_test_log; these endpoints let an admin judge answers
// (correct/partial/incorrect + corrected answer) and browse the history.
// NOTE: path is /api/skill-test-logs (NOT /api/skills/test-logs) so it can't
// collide with the GET /api/skills/:id param route above.


return router;
};
