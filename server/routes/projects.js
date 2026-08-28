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
        // Phase 16.5 / 17: never leak the full project_api_key to the browser.
        // The frontend only needs to know "does this project have a key?" plus
        // a short preview for the admin to confirm which key is set.
        // Phase 17: column may now be encrypted (`enc:v1:...`) — decrypt once
        // before sniffing prefix/suffix so the preview still shows the real
        // "sk-svcac…XXXX" pattern. Legacy plaintext rows decrypt() returns
        // unchanged so the same path covers both.
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

// POST /api/projects
// Phase 15: also creates a matching project + service-account on OpenAI so
// every dashboard project owns its own API key. If admin key isn't configured
// or OpenAI rejects the call, the dashboard row still lands — admin can
// manually link it later — so a flaky OpenAI never blocks local provisioning.
router.post('/api/projects', requireAdmin, validate(schemas.createProject), async (req, res) => {
    const { name, projectId, apiKey, description, inputRate, outputRate, creditLimit } = req.body;
    const inRate  = inputRate  !== undefined ? inputRate  : 0.50;
    const outRate = outputRate !== undefined ? outputRate : 1.50;
    const credLim = creditLimit !== undefined ? creditLimit : 0;

    // Phase 16.2: provision the OpenAI project ONLY — do not auto-create a
    // service-account or API key. Rationale: many admins want the project
    // linked at OpenAI for usage tracking & quota isolation, but prefer to
    // generate the API key by hand in the OpenAI dashboard (e.g. user-owned
    // key with explicit "All" permissions, or a SA with custom name/scope).
    //
    // The SA-creation path is preserved in git history (see commit before
    // Phase 16.2) and can be re-enabled per-project later via a dedicated
    // "Generate API key" admin action if desired.
    //
    // Result of this block:
    //   openaiProjectId         → set when admin key is configured & API succeeded
    //   openaiServiceAccountId  → always null (no SA created here)
    //   openaiKey               → always null (admin pastes key later via Edit Project)
    //   openaiError             → message if the project create call failed (non-fatal —
    //                             the dashboard row still lands so admin can recover)
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

    // Phase 15.2: prefer OpenAI's project id as the dashboard PK so
    // tbl_project.project_id == tbl_project.openai_project_id from day one.
    // Fallbacks (in order):
    //   1) the OpenAI id we just received    (preferred — DB and OpenAI agree)
    //   2) admin-supplied projectId          (back-compat for offline mode)
    //   3) generated 'proj_<slug>_<ts>' id   (last resort, e.g. admin key missing)
    const pid = openaiProjectId
        || projectId
        || ('proj_' + name.toLowerCase().replace(/\s+/g,'_').slice(0,20) + '_' + Date.now().toString(36));

    // Pick what to write into project_api_key:
    //   1) the freshly-minted service-account key  (Phase 16.2: never set here anymore)
    //   2) whatever the admin pasted in the form   (backwards-compat path — manual key)
    //   3) NULL                                    (Phase 16.2: prefer null over a fake
    //                                                placeholder. Admin can paste a real
    //                                                key later via Edit Project.)
    // Phase 17: encrypt at rest before INSERT.
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
    // Phase 16.5: distinguish three states for apiKey:
    //   apiKey === undefined       → field omitted: keep existing (COALESCE)
    //   apiKey === null            → admin clicked "Clear": overwrite with NULL
    //   apiKey === 'sk-...'        → admin pasted new key: overwrite
    // The legacy code used `apiKey || null` which collapsed null and '' into
    // "keep existing", making clear-key impossible.
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

        // Build the api_key fragment dynamically so 'clear' can write NULL
        // while 'keep' leaves the column alone.
        // Phase 17: encrypt the new key before writing.
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
        // Phase 17.2: drop any cached per-project OpenAI client so the next
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

// DELETE /api/projects/:id  — Phase 7: soft-delete
// Three FKs reference tbl_project: tbl_user.project_id (nullable),
// tbl_balance.project_id (NOT NULL), tbl_response.project_id (NOT NULL).
// We refuse delete if there is chat history (history is user data — never
// silently deleted), unassign users, drop the balance row so the credit
// pool doesn't leak, and mark the project row is_deleted=TRUE for audit.
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
        // Drop per-user credits tied to this project BEFORE tbl_balance
        // because tbl_credits.project_id → tbl_balance.project_id (FK). The
        // project is going away so those credit allocations die with it;
        // users keep their accounts but need to be re-assigned to a project
        // (and re-funded) to spend again.
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

        // Phase 16.5: archive the linked OpenAI project so it doesn't keep
        // showing up on platform.openai.com after the admin "deleted" it.
        // Done AFTER commit — a flaky OpenAI shouldn't roll back the dashboard
        // delete; we just record the failure in the audit log so admin can
        // archive by hand later.
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

// PUT /api/projects/:id/topup  — add credits to project pool
// Phase 16.1 / 21.2: top-up flow writes to BOTH tbl_balance (current) and
// tbl_topup_project (audit trail — renamed from tbl_topup_history),
// atomically inside a single transaction.
// Prior implementation used a non-transactional UPSERT plus a "revert if cap
// exceeded" UPDATE — fragile under concurrent top-ups (a 2nd request could
// observe an over-cap intermediate state, or the revert could fail leaving
// the cap silently breached). Now: row-locked check → conditional write,
// no revert path needed.
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

        // 2) Lock the balance row (or fall through to insert path) so no
        //    concurrent top-up can race past the cap check.
        //    Also read project_credits_amount (Phase 20) so we can bump it
        //    inside the same transaction.
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

        // 4) UPSERT current balance + lifetime amount.
        //    Phase 20: project_credits_amount is monotonically non-decreasing —
        //    on conflict we ADD `amountNum` to the existing value rather than
        //    overwrite with newLifetime (defensive in case the locked row went
        //    out of sync; ADD is order-independent).
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

        // 5) Append to history (one row per top-up event, never updated).
        // Phase 21.2: table renamed tbl_topup_history → tbl_topup_project
        // so the name matches the rest of the project-scoped tables.
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

// GET /api/topup-history  — Phase 16.1
//   ?projectId=...   filter to one project (optional)
//   ?limit=N         default 100, max 500
// Returns newest-first. Joins tbl_project + tbl_user so the UI doesn't N+1.
// Open to all admins (requireAdmin); regular users have no business reading
// other projects' financial events.
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

// ══════════════════════════════════════════════════════════
//  AUDIT LOGS
// ══════════════════════════════════════════════════════════


return router;
};
