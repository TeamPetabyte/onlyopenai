// audit.js — เขียน tbl_action_admin / tbl_audit_log (best-effort เสมอ)

module.exports = function createAudit({ pool }) {
// เขียน tbl_action_admin — detail แบบ object (action/target/before/after) หรือสองอาร์กแบบเก่าก็ได้
// ห้ามใส่รหัสผ่าน/token ใน before/after — redactor ช่วยกรอง แต่ผู้เรียกคือด่านแรก
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

// เหตุการณ์ auth (login fail/lockout/logout) ลง tbl_audit_log — user_id เป็น NULL ได้
async function logAuthEvent(eventType, userId, req, detail = {}) {
    try {
        // req.clientIp มาจาก middleware ใน server.js (CF-Connecting-IP → req.ip) — ไม่อ่าน XFF ดิบ
        const ip = (req?.clientIp || req?.ip || '').toString().slice(0, 45);
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
