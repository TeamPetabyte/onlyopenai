// audit.js — เขียน tbl_action_admin / tbl_audit_log (best-effort เสมอ)

module.exports = function createAudit({ pool }) {
// ── Helper: บันทึก admin/user action (Phase 14 extended) ─────
// tbl_action_admin.project_id was NOT NULL in older schemas; phase11-003
// relaxes it, and we pass the admin's project_id (may be NULL) so rows
// with a project still record it for reporting.
//
// Phase 14 adds structured detail: action_type, target_type, target_id,
// and a before/after change snapshot (JSONB). All detail params are
// optional for back-compat — the two-arg form `logAdminAction(req)` is
// still valid. Prefer the object form:
//
//   logAdminAction(req, {
//     action: 'update_balance',
//     targetType: 'user', targetId: 42,
//     before: { balance: 100 },
//     after:  { balance: 500 },
//   });
//
// SECURITY: never pass `password`, `password_hash`, CSRF tokens,
// or session tokens inside before/after. The redactor below strips
// them defensively, but the caller is the primary gate.
const REDACT_KEYS = new Set([
    'password', 'password_hash', 'pw', 'pw_hash',
    'csrf_token', 'csrf', 'token', 'bearer', 'session_token',
]);
function _redactSecrets(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (REDACT_KEYS.has(String(k).toLowerCase())) continue;
        out[k] = v;
    }
    return out;
}

async function logAdminAction(req, detail = {}) {
    const sess = req.session;     // populated by requireAuth/requireAdmin
    if (!sess) return;
    try {
        const uRow = await pool.query(
            'SELECT role_id, project_id FROM tbl_user WHERE user_id=$1', [sess.userId]);
        const roleId    = uRow.rows[0]?.role_id    || 1;
        const projectId = uRow.rows[0]?.project_id || null;

        const actionType = detail.action     ? String(detail.action).slice(0, 40)     : null;
        const targetType = detail.targetType ? String(detail.targetType).slice(0, 20) : null;
        const targetId   = Number.isInteger(detail.targetId) ? detail.targetId : null;

        // Build change_json only if either before or after was provided.
        let changeJson = null;
        if (detail.before || detail.after) {
            changeJson = {};
            if (detail.before) changeJson.before = _redactSecrets(detail.before);
            if (detail.after)  changeJson.after  = _redactSecrets(detail.after);
            // Optional free-form extras (e.g. reason, notes)
            if (detail.extra && typeof detail.extra === 'object') {
                changeJson.extra = _redactSecrets(detail.extra);
            }
        } else if (detail.extra && typeof detail.extra === 'object') {
            changeJson = { extra: _redactSecrets(detail.extra) };
        }

        await pool.query(
            `INSERT INTO tbl_action_admin
                (user_id, project_id, role_id, edit_date, edit_time,
                 action_type, target_type, target_id, change_json)
             VALUES ($1, $2, $3, CURRENT_DATE, NOW(), $4, $5, $6, $7)`,
            [sess.userId, projectId, roleId,
             actionType, targetType, targetId,
             changeJson ? JSON.stringify(changeJson) : null]);
    } catch (e) { console.error('[action-log]', e.message); }
}

// ── Helper: audit-log event (Phase 14) ──────────────────────
// Records non-action events (failed login, lockout, logout) in
// tbl_audit_log. user_id may be NULL when the username was unknown.
async function logAuthEvent(eventType, userId, req, detail = {}) {
    try {
        const ip = (req?.headers?.['x-forwarded-for'] || req?.ip || '').toString().slice(0, 45);
        await pool.query(
            `INSERT INTO tbl_audit_log
                (user_id, log_in_date, log_in_time, event_type, detail, ip)
             VALUES ($1, CURRENT_DATE, NOW(), $2, $3, $4)`,
            [userId || null, String(eventType).slice(0, 20),
             detail ? JSON.stringify(_redactSecrets(detail)) : null, ip]);
    } catch (e) { console.error('[audit-log]', e.message); }
}

return { logAdminAction, logAuthEvent, _redactSecrets };
};
