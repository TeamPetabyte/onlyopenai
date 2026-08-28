// validators.js — กติกา input ที่ใช้ร่วมกันทุก route (pure, ไม่มี pool)

/** Phase 7: stricter password policy. Returns null if OK, error string if bad. */
function validatePasswordStrength(pw) {
    if (!pw || typeof pw !== 'string') return 'password is required';
    if (pw.length < 8)              return 'password must be at least 8 characters';
    if (pw.length > 128)            return 'password must be at most 128 characters';
    if (!/[A-Za-z]/.test(pw))       return 'password must contain at least one letter';
    if (!/[0-9]/.test(pw))          return 'password must contain at least one digit';
    return null;
}

/** Validate balance/credit number. Returns number (safe) or throws. */
function validateAmount(value, { min = 0, max = Infinity, required = true } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) throw new Error('amount required');
        return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error('amount must be a number');
    if (n < min) throw new Error(`amount must be >= ${min}`);
    if (n > max) throw new Error(`amount must be <= ${max}`);
    return n;
}

// ── Role normalization ─────────────────────────────────────
// DB stores tbl_user_role.role_des as 'admin' or 'general user'.
// Frontend (Auth.check / requireRole) compares against literal role names.
// Normalize at every response boundary so client & middleware never see raw
// role_des values like 'general user'.
// Phase 30: added 'trainer' (superadmin) — anything unknown still maps to
// 'user' so a typo'd role can never gain privileges.
function normalizeRole(roleDes) {
    const r = String(roleDes || '').toLowerCase().trim();
    if (r === 'admin')   return 'admin';
    if (r === 'trainer') return 'trainer';
    return 'user';
}

// validateAmount ต้องรู้เพดานเงินของระบบ — รับเป็น argument ไม่อ่าน env เอง
function makeValidateAmount(maxBalance) {
    return (value, opts = {}) => validateAmount(value, { max: maxBalance, ...opts });
}

module.exports = { validatePasswordStrength, validateAmount, makeValidateAmount, normalizeRole };
