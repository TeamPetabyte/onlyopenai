// users.js — จัดการ user, credits, daily cap
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const bcrypt = require('bcrypt');
const {
    logAdminAction,
    normalizeRole,
    pool,
    requireAdmin,
    requireAuth,
    safeError,
    schemas,
    spentToday,
    validate,
    validatePasswordStrength,
} = ctx;
// GET /api/users — admin only (user list is sensitive). Phase 7: hide soft-deleted.
router.get('/api/users', requireAdmin, async (req, res) => {
    try {
        // effective_status รวม acc_status_id กับ locked_until — auto-lock ไม่ได้แตะ acc_status
        const r = await pool.query(`
            SELECT u.user_id AS id, u.username, u.name, u.surname,
                   (u.name || ' ' || u.surname) AS display_name,
                   ro.role_des AS role, ro.role_id,
                   u.project_id, u.created_date AS created_at,
                   u.acc_status_id, a.acc_status,
                   CASE
                       WHEN u.locked_until IS NOT NULL AND u.locked_until > NOW()
                            THEN 'locked'
                       ELSE a.acc_status
                   END AS effective_status,
                   u.locked_until,
                   u.failed_attempts,
                   u.daily_cap,
                   COALESCE(cr.user_credits, 0) AS balance
            FROM tbl_user u
            JOIN tbl_user_role ro ON u.role_id = ro.role_id
            JOIN tbl_acc_status a ON u.acc_status_id = a.acc_status_id
            LEFT JOIN tbl_credits cr ON u.user_id = cr.user_id
            WHERE u.is_deleted = FALSE
            ORDER BY u.user_id ASC`);
        const users = r.rows.map(u => ({ ...u, role: normalizeRole(u.role) }));
        res.json({ ok: true, users });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// GET /api/users/:id  — single user with balance. Phase 7: hide soft-deleted.
router.get('/api/users/:id', requireAuth, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT u.user_id AS id, u.username, u.name, u.surname,
                   (u.name || ' ' || u.surname) AS display_name,
                   ro.role_des AS role, ro.role_id,
                   u.project_id, u.created_date AS created_at,
                   u.acc_status_id, a.acc_status,
                   u.daily_cap,
                   COALESCE(cr.user_credits, 0) AS balance
            FROM tbl_user u
            JOIN tbl_user_role ro ON u.role_id = ro.role_id
            JOIN tbl_acc_status a ON u.acc_status_id = a.acc_status_id
            LEFT JOIN tbl_credits cr ON u.user_id = cr.user_id
            WHERE u.user_id = $1 AND u.is_deleted = FALSE`, [req.params.id]);
        if (r.rows.length === 0) return res.json({ ok: false, error: 'User not found' });
        const user = { ...r.rows[0], role: normalizeRole(r.rows[0].role) };
        res.json({ ok: true, user });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// POST /api/users  — create user. Phase 7: enforce password policy on create.
router.post('/api/users', requireAdmin, validate(schemas.createUser), async (req, res) => {
    const { username, password, displayName, role, balance, projectId } = req.body;
    // Strength check is still separate — schema only enforces length range
    const pwErr = validatePasswordStrength(password);
    if (pwErr) return res.status(400).json({ ok: false, error: pwErr });
    const balanceNum = (balance === undefined) ? 0 : balance;
    // Concept B: per-user daily spending limit. null/'' = no cap (unlimited,
    // bounded only by the project pool). Validated by createUserSchema.
    const dailyCap = (req.body.dailyCap === undefined
                       || req.body.dailyCap === null
                       || req.body.dailyCap === '')
        ? null : Number(req.body.dailyCap);

    // เฉพาะ trainer สร้าง admin ได้; role 'trainer' สร้างผ่าน API ไม่ได้เลย
    const ROLE_IDS = { admin: 1, user: 2 };
    const roleId = ROLE_IDS[role] || 2;
    if (roleId !== 2 && req.session.role !== 'trainer') {
        return res.status(403).json({ ok: false, error: 'Only a trainer can create admin accounts' });
    }
    const [name, ...rest] = (displayName || req.body.name || username).split(' ');
    const surname = req.body.surname || rest.join(' ') || '';
    // staff (admin/trainer) ไม่ผูก project ไม่มี cap/credits
    const isStaff = roleId !== 2;
    const projId     = isStaff ? null : (projectId || 'proj_sap_dev');
    const effDailyCap = isStaff ? null : dailyCap;
    try {
        const hash = await bcrypt.hash(password, 10);
        // รหัสที่ admin ตั้งให้ user = ชั่วคราว บังคับเปลี่ยนตอน login แรก; staff ยกเว้น
        const mustChangePw = roleId === 2;
        const r = await pool.query(`
            INSERT INTO tbl_user (project_id, role_id, username, password, name, surname, created_date, acc_status_id, must_change_password, daily_cap)
            VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,1,$7,$8) RETURNING user_id`,
            [projId, roleId, username, hash, name, surname, mustChangePw, effDailyCap]);
        const userId = r.rows[0].user_id;
        // คง tbl_credits ไว้ที่ 0 — Concept B ไม่ใช้แล้ว แต่บาง join ยังคาดหวังแถว
        if (projId) {
            await pool.query(`INSERT INTO tbl_credits (user_id, project_id, user_credits) VALUES ($1,$2,0)
                ON CONFLICT (user_id) DO NOTHING`,
                [userId, projId]);
        }
        logAdminAction(req, {
            action: 'create_user',
            targetType: 'user',
            targetId: userId,
            after: { username, name, surname, role, projectId: projId, daily_cap: effDailyCap },
        });
        res.json({ ok: true, id: userId });
    } catch (e) {
        if (e.code === '23505') return res.json({ ok: false, error: 'Username already exists' });
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// PUT /api/users/:id  — edit user
router.put('/api/users/:id', requireAdmin, validate(schemas.updateUser), async (req, res) => {
    // PARTIAL update — แตะเฉพาะ key ที่มากับ body (เคยเขียนทับทุกคอลัมน์ด้วย default)
    const b = req.body;
    const has = k => Object.prototype.hasOwnProperty.call(b, k);

    // Derive name/surname only if the caller sent them (or displayName).
    let name, surname, nameChanged = false;
    if (has('name') || has('surname')) {
        name    = has('name')    ? (b.name    || '') : undefined;
        surname = has('surname') ? (b.surname || '') : undefined;
        nameChanged = true;
    } else if (has('displayName')) {
        const parts = (b.displayName || '').split(' ');
        name    = parts[0] || '';
        surname = parts.slice(1).join(' ') || '';
        nameChanged = true;
    }

    // Enforce password policy when admin sets a new password
    if (b.password) {
        const pwErr = validatePasswordStrength(b.password);
        if (pwErr) return res.json({ ok: false, error: pwErr });
    }

    // เกตเดียวกับ createUser — เฉพาะ trainer มอบ role admin ได้
    const UPD_ROLE_IDS = { admin: 1, user: 2 };
    const roleId = has('role') ? (UPD_ROLE_IDS[b.role] || 2) : undefined;
    if (roleId !== undefined && roleId !== 2 && req.session.role !== 'trainer') {
        return res.status(403).json({ ok: false, error: 'Only a trainer can assign the admin role' });
    }
    // projectId: null = unassign, string = assign, undefined = no change
    const projValue = has('projectId')
        ? (b.projectId === null ? null : b.projectId)
        : undefined;
    const balanceNum = has('balance') ? b.balance : undefined;
    const accStatusId = has('accStatusId') ? b.accStatusId : undefined;

    try {
        // Snapshot current values before UPDATE so the audit row records
        // exactly which fields changed (and from what).
        const beforeRows = await pool.query(
            `SELECT u.name, u.surname, u.role_id, u.project_id, u.acc_status_id,
                    COALESCE(cr.user_credits, 0) AS balance
               FROM tbl_user u
               LEFT JOIN tbl_credits cr ON cr.user_id = u.user_id
              WHERE u.user_id = $1 AND u.is_deleted = FALSE`, [req.params.id]);
        const before = beforeRows.rows[0] || null;
        if (!before) return res.json({ ok: false, error: 'User not found' });

        // Build dynamic SET clause — only columns that were actually provided.
        const sets = [], params = [];
        const addSet = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
        if (nameChanged && name    !== undefined) addSet('name',    name);
        if (nameChanged && surname !== undefined) addSet('surname', surname);
        if (roleId      !== undefined) addSet('role_id',       roleId);
        if (projValue   !== undefined) addSet('project_id',    projValue);
        if (accStatusId !== undefined) {
            addSet('acc_status_id', accStatusId);
            // กลับเป็น active ต้องล้าง locked_until/failed_attempts ไม่งั้น badge ค้างที่ Locked
            if (accStatusId === 1) {
                addSet('locked_until',    null);
                addSet('failed_attempts', 0);
            }
        }
        if (b.password) {
            const hash = await bcrypt.hash(b.password, 10);
            addSet('password', hash);
            // force the target user to pick their own pw next login,
            // unless admin is editing their own row (avoids self-lockout).
            const flipFlag = req.session.userId !== parseInt(req.params.id, 10);
            addSet('must_change_password', flipFlag);
        }

        if (sets.length > 0) {
            params.push(req.params.id);
            await pool.query(
                `UPDATE tbl_user SET ${sets.join(', ')}
                 WHERE user_id = $${params.length} AND is_deleted = FALSE`, params);
        }

        if (balanceNum !== undefined && balanceNum !== null) {
            // ใช้ project_id หลังอัปเดต — กัน credits ไปเกาะ project เก่า
            const credProjId = (projValue !== undefined ? projValue : before.project_id) || 'proj_sap_dev';
            await pool.query(`INSERT INTO tbl_credits (user_id, project_id, user_credits) VALUES ($1,$2,$3)
                ON CONFLICT (user_id) DO UPDATE SET user_credits=$3`,
                [req.params.id, credProjId, balanceNum]);
        }

        // Compose diff — only consider fields that were provided this call
        // AND actually changed. Everything else stays off the audit row.
        const afterSubset = {};
        if (nameChanged && name    !== undefined) afterSubset.name    = name;
        if (nameChanged && surname !== undefined) afterSubset.surname = surname;
        if (roleId      !== undefined) afterSubset.role_id       = roleId;
        if (projValue   !== undefined) afterSubset.project_id    = projValue;
        if (accStatusId !== undefined) afterSubset.acc_status_id = accStatusId;
        if (balanceNum  !== undefined && balanceNum !== null) afterSubset.balance = balanceNum;
        if (b.password) afterSubset.password_reset = true;

        const diffBefore = {}, diffAfter = {};
        for (const k of Object.keys(afterSubset)) {
            const bv = before[k];
            const av = afterSubset[k];
            const norm = v => (v == null ? null : (typeof v === 'number' ? v : String(v)));
            if (norm(bv) !== norm(av)) {
                diffBefore[k] = bv ?? null;
                diffAfter[k]  = av;
            }
        }
        logAdminAction(req, {
            action: 'update_user',
            targetType: 'user',
            targetId: parseInt(req.params.id, 10),
            before: Object.keys(diffBefore).length ? diffBefore : undefined,
            after:  Object.keys(diffAfter).length  ? diffAfter  : undefined,
        });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// PUT /api/users/:id/password  — change own password (auth + self-only)
// lets non-admin users change their own password without admin rights.
router.put('/api/users/:id/password', requireAuth, validate(schemas.changePassword), async (req, res) => {
    const targetId = parseInt(req.params.id);
    if (req.session.userId !== targetId && req.session.role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Can only change own password' });
    }
    const { password } = req.body;
    // stronger password policy applied here too
    const pwErr = validatePasswordStrength(password);
    if (pwErr) return res.status(400).json({ ok: false, error: pwErr });
    try {
        const hash = await bcrypt.hash(password, 10);
        // เปลี่ยนรหัสตัวเอง = ล้าง must_change_password; admin reset ให้คนอื่น = คงไว้
        const isSelf = req.session.userId === targetId;
        const r = await pool.query(
            `UPDATE tbl_user
                SET password = $1,
                    must_change_password = CASE WHEN $3::boolean THEN FALSE ELSE must_change_password END
              WHERE user_id = $2 AND is_deleted = FALSE`,
            [hash, targetId, isSelf]);
        if (r.rowCount === 0) return res.json({ ok: false, error: 'User not found' });
        // บันทึกทุกการเปลี่ยนรหัส — ห้ามมี hash/plaintext ใน log
        logAdminAction(req, {
            action: isSelf ? 'change_own_password' : 'admin_reset_password',
            targetType: 'user',
            targetId,
            extra: { self: isSelf, must_change_password_cleared: isSelf },
        });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// PUT /api/users/:id/balance — DELTA: ย้ายเงิน pool ↔ wallet ใน tx เดียว + FOR UPDATE กัน admin สองคนแย่ง
// pool ไม่พอ → ok:false INSUFFICIENT_POOL — ไม่ auto-cap เพราะเรื่องเงินต้อง explicit
router.put('/api/users/:id/balance', requireAdmin, validate(schemas.setBalance), async (req, res) => {
    const balanceNum = parseFloat(req.body.balance);
    if (isNaN(balanceNum) || balanceNum < 0) {
        return res.json({ ok: false, error: 'balance must be a non-negative number' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ล็อกเฉพาะแถว user — FOR UPDATE ฝั่ง nullable ของ outer join ไม่ได้; upsert ล็อกของมันเอง
        const u = await client.query(
            `SELECT u.user_id, u.project_id, COALESCE(cr.user_credits, 0) AS user_credits
               FROM tbl_user u
               LEFT JOIN tbl_credits cr ON cr.user_id = u.user_id
              WHERE u.user_id = $1 AND u.is_deleted = FALSE
              FOR UPDATE OF u`, [req.params.id]);
        if (u.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, error: 'User not found' });
        }
        const projId  = u.rows[0].project_id;
        const prevBal = parseFloat(u.rows[0].user_credits) || 0;
        const delta   = balanceNum - prevBal;

        // User must be on a project; we have nowhere to debit/credit from otherwise.
        if (!projId) {
            await client.query('ROLLBACK');
            return res.json({ ok: false, error: 'User is not assigned to a project — assign first then set credit' });
        }

        // Lock project pool. LEFT JOIN-style fallback: a project with no top-up
        // history yet has no tbl_balance row → treat pool as 0.
        const pb = await client.query(
            `SELECT project_credits FROM tbl_balance
              WHERE project_id = $1 FOR UPDATE`, [projId]);
        const poolBefore = pb.rows.length ? parseFloat(pb.rows[0].project_credits) : 0;

        // Insufficient pool check (only matters when allocating MORE to user).
        if (delta > 0 && poolBefore < delta) {
            await client.query('ROLLBACK');
            return res.json({
                ok: false,
                code: 'INSUFFICIENT_POOL',
                error: `Project pool only has ฿${poolBefore.toFixed(2)} — cannot allocate ฿${delta.toFixed(2)} more. Top up the project first.`,
                poolAvailable: poolBefore,
                requested:     delta,
            });
        }

        // 1) Upsert user_credits to new value
        await client.query(`
            INSERT INTO tbl_credits (user_id, project_id, user_credits)
            VALUES ($1, $2, $3)
            ON CONFLICT (user_id) DO UPDATE SET user_credits = EXCLUDED.user_credits`,
            [req.params.id, projId, balanceNum]);

        // log ธุรกรรมใน tx เดียวกัน — delta>0 topup, delta<0 adjustment
        if (delta !== 0) {
            const txType = delta > 0 ? 'topup' : 'adjustment';
            await client.query(`
                INSERT INTO tbl_user_credit_transaction
                    (user_id, project_id, transaction_type, amount,
                     balance_before, balance_after,
                     ref_type, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, 'admin_edit', $7)`,
                [req.params.id, projId, txType, delta,
                 prevBal, balanceNum, req.session.userId]);
        }

        // 2) Adjust project pool by -delta (if user gets more, pool drops)
        let poolAfter = poolBefore;
        if (delta !== 0) {
            if (pb.rows.length) {
                const r = await client.query(
                    `UPDATE tbl_balance SET project_credits = project_credits - $1,
                                            top_up_date = top_up_date,
                                            top_up_time = top_up_time
                      WHERE project_id = $2
                      RETURNING project_credits`,
                    [delta, projId]);
                poolAfter = parseFloat(r.rows[0].project_credits);
            } else if (delta < 0) {
                // No balance row yet, but user is returning credit → create one with the credit returned
                await client.query(
                    `INSERT INTO tbl_balance (project_id, project_credits, top_up_date, top_up_time, user_id)
                     VALUES ($1, $2, CURRENT_DATE, NOW(), $3)`,
                    [projId, -delta, req.session.userId]);
                poolAfter = -delta;
            }
            // delta > 0 with no pool row already hit the INSUFFICIENT_POOL guard above
        }

        await client.query('COMMIT');

        logAdminAction(req, {
            action: 'update_balance',
            targetType: 'user',
            targetId: parseInt(req.params.id, 10),
            before: { user_credits: prevBal, project_pool: poolBefore },
            after:  { user_credits: balanceNum, project_pool: poolAfter },
            extra:  { delta, project_id: projId },
        });
        res.json({
            ok: true,
            balance: balanceNum,             // new user credit
            projectId: projId,
            projectBalance: poolAfter,       // for UI to refresh project rows
            delta,
        });
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        res.status(500).json({ ok: false, ...safeError(e, req) });
    } finally {
        client.release();
    }
});

// GET /api/credits — ตารางรวมต่อ user; projectBalance ซ้ำข้ามแถวโดยตั้งใจ กัน N+1 ฝั่ง UI
router.get('/api/credits', requireAdmin, async (req, res) => {
    try {
        // แถม spend วันนี้ + bonus (วันแบบ Asia/Bangkok) ให้หน้า Cap Management
        const r = await pool.query(`
            SELECT u.user_id                                      AS "userId",
                   u.username,
                   (u.name || ' ' || u.surname)                   AS "displayName",
                   u.project_id                                   AS "projectId",
                   p.project_name                                 AS "projectName",
                   COALESCE(b.project_credits, 0)                 AS "projectBalance",
                   COALESCE(cr.user_credits, 0)                   AS "userCredits",
                   u.daily_cap                                    AS "dailyCap",
                   COALESCE((SELECT SUM(du.total_price)
                               FROM tbl_daily_usage du
                              WHERE du.user_id = u.user_id
                                AND du.usage_date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date), 0)
                                                                  AS "spentToday",
                   COALESCE(u.bonus_balance, 0)                   AS "bonusBalance",
                   -- Phase 21.11 (Dashboard): lifetime per-user rollups from
                   -- tbl_daily_usage (kept live by the chat handler upsert).
                   COALESCE(lt.tokens,   0)                       AS "lifetimeTokens",
                   COALESCE(lt.spend,    0)                       AS "lifetimeSpend",
                   COALESCE(lt.requests, 0)                       AS "lifetimeRequests"
              FROM tbl_user u
              JOIN tbl_user_role ro ON ro.role_id = u.role_id
              LEFT JOIN tbl_project p  ON p.project_id = u.project_id
              LEFT JOIN tbl_balance b  ON b.project_id = u.project_id
              LEFT JOIN tbl_credits cr ON cr.user_id = u.user_id
              LEFT JOIN (SELECT du.user_id,
                                SUM(du.total_token)   AS tokens,
                                SUM(du.total_price)   AS spend,
                                SUM(du.request_count) AS requests
                           FROM tbl_daily_usage du
                          GROUP BY du.user_id) lt ON lt.user_id = u.user_id
             WHERE u.is_deleted = FALSE AND ro.role_des = 'general user'
             ORDER BY u.user_id ASC`);
        res.json({ ok: true, credits: r.rows });
    } catch (e) {
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// PUT daily-cap: number = เพดาน ฿/วัน (ชนแล้ว /api/chat ตอบ 402), null = ไม่จำกัด
router.put('/api/users/:id/daily-cap', requireAdmin, validate(schemas.dailyCap), async (req, res) => {
    const cap = req.body.dailyCap;
    const capVal = (cap === undefined || cap === null) ? null : cap;
    try {
        // Snapshot previous cap for audit diff
        const prev = await pool.query(
            'SELECT daily_cap FROM tbl_user WHERE user_id=$1 AND is_deleted=FALSE',
            [req.params.id]);
        const prevCap = prev.rows[0]?.daily_cap ?? null;

        const r = await pool.query(
            `UPDATE tbl_user SET daily_cap = $1
             WHERE user_id = $2 AND is_deleted = FALSE
             RETURNING user_id, daily_cap`,
            [capVal, req.params.id]);
        if (r.rowCount === 0) return res.json({ ok: false, error: 'User not found' });
        logAdminAction(req, {
            action: 'update_daily_cap',
            targetType: 'user',
            targetId: parseInt(req.params.id, 10),
            before: { daily_cap: prevCap },
            after:  { daily_cap: capVal },
        });
        res.json({ ok: true, dailyCap: r.rows[0].daily_cap });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});


// GET daily-cap-status — ดูของตัวเองได้, admin ดูได้ทุกคน
router.get('/api/users/:id/daily-cap-status', requireAuth, async (req, res) => {
    const uid = parseInt(req.params.id, 10);
    if (!Number.isFinite(uid)) return res.status(400).json({ ok: false, error: 'bad id' });
    if (req.session.role !== 'admin' && req.session.userId !== uid) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    try {
        const u = await pool.query(
            'SELECT daily_cap FROM tbl_user WHERE user_id=$1 AND is_deleted=FALSE',
            [uid]);
        if (u.rows.length === 0) return res.json({ ok: false, error: 'User not found' });
        const cap = u.rows[0].daily_cap === null ? null : parseFloat(u.rows[0].daily_cap);
        const spent = await spentToday(uid);
        const remaining  = cap === null ? null : Math.max(0, cap - spent);
        const exhausted  = cap !== null && spent >= cap;
        res.json({ ok: true, dailyCap: cap, spentToday: spent, remaining, exhausted });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// soft-delete + revoke ทุก session — เก็บแถวไว้ audit, login กรอง is_deleted อยู่แล้ว
router.delete('/api/users/:id', requireAdmin, async (req, res) => {
    const targetId = parseInt(req.params.id);
    if (!Number.isInteger(targetId)) return res.json({ ok: false, error: 'Invalid user id' });
    // Don't let an admin nuke themselves out of the running session
    if (req.session.userId === targetId) {
        return res.json({ ok: false, error: 'Cannot delete your own account' });
    }
    try {
        // Snapshot who's being deleted for audit
        const before = await pool.query(
            'SELECT username, name, surname, role_id, project_id FROM tbl_user WHERE user_id=$1',
            [targetId]);
        const r = await pool.query(
            `UPDATE tbl_user SET is_deleted = TRUE, deleted_at = NOW()
             WHERE user_id = $1 AND is_deleted = FALSE`,
            [targetId]);
        if (r.rowCount === 0) return res.json({ ok: false, error: 'User not found' });
        // Revoke any live sessions for this user
        const sessRows = await pool.query('DELETE FROM tbl_session WHERE user_id = $1', [targetId]);
        logAdminAction(req, {
            action: 'delete_user',
            targetType: 'user',
            targetId,
            before: before.rows[0] || { user_id: targetId },
            extra: { sessions_revoked: sessRows.rowCount || 0 },
        });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});



return router;
};
