// @ts-check
// validators.js — กติกา input ที่ใช้ร่วมกันทุก route (pure, ไม่มี pool)

// รหัสที่เดาก่อนเสมอ — ผ่านกฎความยาว/ตัวเลขได้ทุกตัว จึงต้องกันแยก
const COMMON_PASSWORDS = new Set([
    'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'admin123', 'admin1234', 'administrator1',
    'welcome1', 'welcome123', 'qwerty123', 'abc12345', 'iloveyou1', 'letmein1', 'monkey123',
    'football1', 'sunshine1', 'princess1', 'dragon123', 'master123', 'trustno1', 'baseball1',
    '12345678', '123456789', '1234567890', 'a1234567', 'test1234', 'user1234', 'changeme1',
    'petabyte1', 'petabyte123', 'pipekai123', 'openai123',
]);

/** Phase 7: stricter password policy. Returns null if OK, error string if bad. */
function validatePasswordStrength(pw, username) {
    if (!pw || typeof pw !== 'string') return 'password is required';
    const low = pw.toLowerCase();
    if (COMMON_PASSWORDS.has(low)) return 'password is too common — pick something unpredictable';
    if (username && typeof username === 'string' && username.length >= 3
        && low.includes(username.toLowerCase())) return 'password must not contain the username';
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

// map role_des จาก DB เป็น 'admin'|'trainer'|'user' — ไม่รู้จัก = 'user' (typo ห้ามได้สิทธิ์เพิ่ม)
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
