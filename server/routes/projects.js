// projects.js — จัดการ project + topup + topup-history
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const {
    cryptoStore,
    invalidateProjectClient,
    logAdminAction,
    logger,
    MAX_BALANCE,
    openaiAdmin,
    pool,
    requireAdmin,
    requireAuth,
    safeError,
    schemas,
    validate,
} = ctx;
// GET /api/projects
router.get('/api/projects', requireAuth, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT p.project_id AS id, p.project_name AS name, p.project_api_key,
                   p.description, p.input_rate, p.output_rate, p.credit_limit,
                   p.created_date AS created_at,
                   COALESCE(b.project_credits,        0) AS balance,
                   COALESCE(b.project_credits_amount, 0) AS lifetime_amount
            FROM tbl_project p
            LEFT JOIN tbl_balance b ON p.project_id = b.project_id
            WHERE p.is_deleted = FALSE
            ORDER BY p.created_date ASC`);
        // ไม่ส่ง key เต็มให้ browser — decrypt ก่อนทำ preview "sk-…XXXX" (แถว legacy plaintext ผ่าน path เดียวกัน)
        const projects = r.rows.map(p => {
            const raw = cryptoStore.tryDecrypt(p.project_api_key);
            const looksReal = !!raw && /^sk-/i.test(raw);
            return {
                ...p,
                has_api_key: looksReal,
                api_key_preview: looksReal
                    ? raw.slice(0, 8) + '…' + raw.slice(-4)
                    : null,
                project_api_key: undefined, // strip the secret (even encrypted blob)
            };
        });
        res.json({ ok: true, projects });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// POST /api/projects — สร้างคู่ฝั่ง OpenAI ด้วย; OpenAI ล่มไม่ block การสร้างฝั่งเรา
router.post('/api/projects', requireAdmin, validate(schemas.createProject), async (req, res) => {
    const { name, projectId, apiKey, description, inputRate, outputRate, creditLimit } = req.body;
    const inRate  = inputRate  !== undefined ? inputRate  : 0.50;
    const outRate = outputRate !== undefined ? outputRate : 1.50;
    const credLim = creditLimit !== undefined ? creditLimit : 0;

    // สร้างเฉพาะ OpenAI project — ไม่ mint SA/key อัตโนมัติ (admin วาง key เองทีหลัง; โค้ดเดิมอยู่ใน git history)
    let openaiProjectId = null;
    let openaiServiceAccountId = null;
    let openaiKey = null;
    let openaiError = null;

    if (openaiAdmin.isEnabled()) {
        try {
            const proj = await openaiAdmin.createProject(name.trim() + ' (dashboard)');
            openaiProjectId = proj.id;
        } catch (e) {
            openaiError = e.message;
            logger?.warn?.({ err: e.message, project: name }, 'openai-admin: project create failed');
        }
    }

    // ใช้ id ของ OpenAI เป็น PK เมื่อได้มา; fallback: id จาก admin → gen proj_<slug>_<ts>
    const pid = openaiProjectId
        || projectId
        || ('proj_' + name.toLowerCase().replace(/\s+/g,'_').slice(0,20) + '_' + Date.now().toString(36));

    // key ที่เขียน: ของที่ admin วาง หรือ NULL — เข้ารหัสก่อน INSERT เสมอ
    const rawKey = openaiKey || apiKey || null;
    const keyToStore = rawKey ? cryptoStore.encrypt(rawKey) : null;

    try {
        // openai_synced_at = NOW() if we got an id back, else NULL
        const syncedAtSql = openaiProjectId ? 'NOW()' : 'NULL';
        await pool.query(`INSERT INTO tbl_project
            (project_id, project_name, project_api_key, admin_api_key, created_date,
             description, input_rate, output_rate, credit_limit,
             openai_project_id, openai_service_account_id, openai_synced_at)
            VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$8,$9,$10, ${syncedAtSql})`,
            [pid, name.trim(), keyToStore, 'admin_key_001',
             description || '', inRate, outRate, credLim,
             openaiProjectId, openaiServiceAccountId]);
        await pool.query(`INSERT INTO tbl_balance (project_id, project_credits, top_up_date, top_up_time, user_id)
            VALUES ($1, 0, CURRENT_DATE, NOW(), 1) ON CONFLICT (project_id) DO NOTHING`, [pid]);
        logAdminAction(req, {
            action: 'create_project',
            targetType: 'project',
            // project_id is a string PK — we stash it in extra, not target_id
            after: {
                project_id: pid,
                name: name.trim(),
                input_rate: inRate,
                output_rate: outRate,
                credit_limit: credLim,
                description: description || '',
                ...(openaiProjectId ? {
                    openai_project_id: openaiProjectId,
                    openai_service_account_id: openaiServiceAccountId,
                    openai_synced: true,
                } : {}),
                ...(openaiError ? { openai_sync_error: openaiError } : {}),
            },
        });
        res.json({
            ok: true,
            id: pid,
            openai: openaiProjectId
                ? { project_id: openaiProjectId, service_account_id: openaiServiceAccountId, synced: true }
                : { synced: false, error: openaiError || 'admin key not configured' },
        });
    } catch (e) {
        if (e.code === '23505') return res.json({ ok: false, error: 'Project ID already exists' });
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// PUT /api/projects/:id
router.put('/api/projects/:id', requireAdmin, validate(schemas.updateProject), async (req, res) => {
    const { name, apiKey, credits, description, inputRate, outputRate, creditLimit } = req.body;
    const creditsNum = (credits === undefined) ? null : credits;
    // apiKey สามสถานะ: undefined=คงเดิม, null=ล้าง, sk-...=ทับ (เดิม `|| null` ทำให้ล้างไม่ได้)
    const apiKeyAction =
        apiKey === undefined ? 'keep'
      : apiKey === null      ? 'clear'
      : (typeof apiKey === 'string' && apiKey.length > 0) ? 'set'
      : 'keep';
    try {
        // Snapshot for diff — also ensures the project exists before UPDATE
        const prev = await pool.query(
            `SELECT p.project_name, p.project_api_key, p.description,
                    p.input_rate, p.output_rate, p.credit_limit,
                    COALESCE(b.project_credits, 0) AS project_credits
               FROM tbl_project p
               LEFT JOIN tbl_balance b ON b.project_id = p.project_id
              WHERE p.project_id = $1`, [req.params.id]);
        const before = prev.rows[0] || null;

        // สร้าง fragment แบบ dynamic ให้ 'clear' เขียน NULL ได้; key ใหม่เข้ารหัสก่อน
        const apiKeyFrag =
            apiKeyAction === 'set'   ? `project_api_key = $2`
          : apiKeyAction === 'clear' ? `project_api_key = NULL`
          : `project_api_key = project_api_key`;
        const apiKeyParam = apiKeyAction === 'set' ? cryptoStore.encrypt(apiKey) : null;

        const r = await pool.query(`UPDATE tbl_project SET
                project_name      = COALESCE($1, project_name),
                ${apiKeyFrag},
                description       = COALESCE($3, description),
                input_rate        = COALESCE($4, input_rate),
                output_rate       = COALESCE($5, output_rate),
                credit_limit      = COALESCE($6, credit_limit)
             WHERE project_id = $7`,
            [name || null, apiKeyParam, description ?? null,
             (inputRate  !== undefined ? parseFloat(inputRate)  : null),
             (outputRate !== undefined ? parseFloat(outputRate) : null),
             (creditLimit !== undefined ? parseFloat(creditLimit) : null),
             req.params.id]);
        if (r.rowCount === 0) return res.json({ ok: false, error: 'Project not found' });
        // drop any cached per-project OpenAI client so the next
        // chat request reads the new key (set or clear) from the DB.
        if (apiKeyAction !== 'keep') invalidateProjectClient(req.params.id);
        if (creditsNum !== null) {
            await pool.query(`INSERT INTO tbl_balance (project_id, project_credits, top_up_date, top_up_time, user_id)
                VALUES ($1, $2, CURRENT_DATE, NOW(), 1)
                ON CONFLICT (project_id) DO UPDATE SET project_credits = EXCLUDED.project_credits,
                    top_up_date = CURRENT_DATE, top_up_time = NOW()`, [req.params.id, creditsNum]);
        }

        // Compute the changed-only subset (api_key is redacted to a boolean)
        const afterFull = {
            project_name: name ?? before?.project_name,
            description:  description ?? before?.description,
            input_rate:   inputRate   !== undefined ? parseFloat(inputRate)   : before?.input_rate,
            output_rate:  outputRate  !== undefined ? parseFloat(outputRate)  : before?.output_rate,
            credit_limit: creditLimit !== undefined ? parseFloat(creditLimit) : before?.credit_limit,
            ...(creditsNum !== null ? { project_credits: creditsNum } : {}),
            ...(apiKeyAction === 'set'   ? { api_key_changed: true } : {}),
            ...(apiKeyAction === 'clear' ? { api_key_cleared: true } : {}),
        };
        const diffBefore = {}, diffAfter = {};
        if (before) {
            for (const k of Object.keys(afterFull)) {
                const bv = before[k];
                const av = afterFull[k];
                const norm = v => (v == null ? null : (typeof v === 'number' ? Number(v) : String(v)));
                if (norm(bv) !== norm(av)) { diffBefore[k] = bv ?? null; diffAfter[k] = av; }
            }
        }
        logAdminAction(req, {
            action: 'update_project',
            targetType: 'project',
            before: Object.keys(diffBefore).length ? diffBefore : undefined,
            after:  Object.keys(diffAfter).length  ? diffAfter  : undefined,
            extra:  { project_id: req.params.id },
        });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// soft-delete: มีประวัติแชท = ปฏิเสธ, ปลด user, ลบแถว balance, mark is_deleted
router.delete('/api/projects/:id', requireAdmin, async (req, res) => {
    const pid = req.params.id;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Project must exist and not already be soft-deleted
        const exists = await client.query(
            'SELECT 1 FROM tbl_project WHERE project_id=$1 AND is_deleted = FALSE', [pid]);
        if (exists.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, error: 'Project not found' });
        }
        // Reject if responses (history) reference this project
        const respCheck = await client.query(
            'SELECT COUNT(*)::int AS n FROM tbl_response WHERE project_id=$1', [pid]);
        if (respCheck.rows[0].n > 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: false,
                error: `Project has ${respCheck.rows[0].n} chat history record(s). ` +
                       `Reassign or delete those first.` });
        }
        // Unassign users so the dashboard doesn't show a ghost project
        await client.query('UPDATE tbl_user SET project_id=NULL WHERE project_id=$1', [pid]);
        // ลบ tbl_credits ก่อน tbl_balance (FK) — โปรเจกต์หาย เงินจัดสรรหายตาม
        await client.query('DELETE FROM tbl_credits WHERE project_id=$1', [pid]);
        // Drop balance row (otherwise credits are still "allocated" to a dead project)
        await client.query('DELETE FROM tbl_balance WHERE project_id=$1', [pid]);
        // Snapshot before soft-delete (also grab the OpenAI link so we can
        // archive on the OpenAI side after COMMIT).
        const beforeProj = await client.query(
            `SELECT project_name, description, openai_project_id
               FROM tbl_project WHERE project_id = $1`, [pid]);
        // Soft-delete the project row
        await client.query(
            `UPDATE tbl_project SET is_deleted = TRUE, deleted_at = NOW() WHERE project_id = $1`,
            [pid]);
        await client.query('COMMIT');

        // archive ฝั่ง OpenAI หลัง COMMIT — OpenAI ล่มไม่ roll back ฝั่งเรา แค่ลง audit ไว้ archive มือ
        let openaiArchiveStatus = 'skipped';
        const openaiPid = beforeProj.rows[0]?.openai_project_id;
        if (openaiPid && openaiAdmin.isEnabled()) {
            try {
                const r = await openaiAdmin.archiveProject(openaiPid);
                openaiArchiveStatus = r?.status || 'archived';
            } catch (e) {
                openaiArchiveStatus = 'failed: ' + e.message;
                logger?.warn?.({ err: e.message, project: pid, openaiPid },
                    'openai-admin: archiveProject on delete failed (non-fatal)');
            }
        }

        logAdminAction(req, {
            action: 'delete_project',
            targetType: 'project',
            before: beforeProj.rows[0] || null,
            extra:  { project_id: pid, openai_archive: openaiArchiveStatus },
        });
        res.json({ ok: true, openaiArchiveStatus });
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        res.status(500).json({ ok: false, ...safeError(e, req) });
    } finally {
        client.release();
    }
});

// topup เขียน tbl_balance + tbl_topup_project ใน tx เดียว ล็อกแถวกันแข่ง (เดิม UPSERT+revert เปราะ)
router.put('/api/projects/:id/topup', requireAdmin, validate(schemas.topup), async (req, res) => {
    const amountNum = req.body.amount;
    const note      = (req.body.note || '').toString().trim().slice(0, 500) || null;
    const pid       = req.params.id;
    const adminId   = req.session.userId;
    const client    = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1) Project must exist (and not be soft-deleted)
        const proj = await client.query(
            `SELECT 1 FROM tbl_project WHERE project_id=$1 AND is_deleted = FALSE`, [pid]);
        if (proj.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, error: 'Project not found' });
        }

        // ล็อกแถว balance กัน top-up ซ้อนทะลุ cap; อ่าน lifetime มาบวกใน tx เดียวกัน
        const lock = await client.query(
            `SELECT project_credits, project_credits_amount
             FROM tbl_balance WHERE project_id=$1 FOR UPDATE`, [pid]);
        const prevBal      = lock.rowCount > 0 ? parseFloat(lock.rows[0].project_credits) : 0;
        const prevLifetime = lock.rowCount > 0 ? parseFloat(lock.rows[0].project_credits_amount || 0) : 0;
        const newBal       = prevBal      + parseFloat(amountNum);
        const newLifetime  = prevLifetime + parseFloat(amountNum);

        // 3) Cap check BEFORE write — cleaner than write-then-revert.
        //    Lifetime amount has NO upper cap (it's a historical accumulator).
        if (newBal > MAX_BALANCE) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, error: `Balance cap exceeded (max ${MAX_BALANCE})` });
        }

        // lifetime บวกเพิ่มเสมอ (order-independent) ไม่เขียนทับ
        await client.query(
            `INSERT INTO tbl_balance
                (project_id, project_credits, project_credits_amount,
                 top_up_date, top_up_time, user_id)
             VALUES ($1, $2, $3, CURRENT_DATE, NOW(), $4)
             ON CONFLICT (project_id) DO UPDATE SET
                project_credits        = EXCLUDED.project_credits,
                project_credits_amount = tbl_balance.project_credits_amount + $5,
                top_up_date            = CURRENT_DATE,
                top_up_time            = NOW(),
                user_id                = EXCLUDED.user_id`,
            [pid, newBal, newLifetime, adminId, parseFloat(amountNum)]
        );

        // append ประวัติ หนึ่งแถวต่อครั้ง ไม่มี update
        await client.query(
            `INSERT INTO tbl_topup_project
                (project_id, user_id, amount, balance_before, balance_after, note)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [pid, adminId, amountNum, prevBal, newBal, note]
        );

        await client.query('COMMIT');

        // Admin audit log (separate concern — written outside the txn so a
        // logger failure doesn't roll back the financial write)
        logAdminAction(req, {
            action: 'topup_project',
            targetType: 'project',
            before: { project_credits: prevBal,  project_credits_amount: prevLifetime },
            after:  { project_credits: newBal,   project_credits_amount: newLifetime  },
            extra:  { project_id: pid, amount: amountNum, note },
        });
        res.json({ ok: true, newBalance: newBal, lifetimeAmount: newLifetime });
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        res.status(500).json({ ok: false, ...safeError(e, req) });
    } finally {
        client.release();
    }
});

// GET topup-history ?projectId ?limit(100/500) ใหม่→เก่า, join ครบกัน N+1; admin เท่านั้น
router.get('/api/topup-history', requireAdmin, async (req, res) => {
    const limit     = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const projectId = req.query.projectId ? String(req.query.projectId).slice(0, 64) : null;
    const where = [], params = [];
    if (projectId) { params.push(projectId); where.push(`h.project_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);
    try {
        const r = await pool.query(
            `SELECT h.id,
                    h.project_id                                 AS "projectId",
                    p.project_name                               AS "projectName",
                    h.user_id                                    AS "userId",
                    COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.name, u.surname)), ''),
                             u.username, '—')                    AS "userName",
                    h.amount,
                    h.balance_before                             AS "balanceBefore",
                    h.balance_after                              AS "balanceAfter",
                    h.note,
                    h.created_at                                 AS "createdAt"
               FROM tbl_topup_project h     -- Phase 21.2: renamed from tbl_topup_history
               LEFT JOIN tbl_project p ON p.project_id = h.project_id
               LEFT JOIN tbl_user    u ON u.user_id    = h.user_id
               ${whereSql}
               ORDER BY h.created_at DESC, h.id DESC
               LIMIT $${params.length}`,
            params
        );
        res.json({ ok: true, data: r.rows });
    } catch (e) {
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});



return router;
};
