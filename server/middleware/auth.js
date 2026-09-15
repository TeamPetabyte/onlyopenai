// auth.js — csrfGuard + requireAdmin/Trainer/Auth (เกตจริงของทุก route)

module.exports = function createAuthMiddleware({ sessionStore }) {
const { getSession, _extractToken, CSRF_HEADER } = sessionStore;
// CSRF double-submit on state-changing methods (extra layer over SameSite=Strict); login exempt — no session yet
const CSRF_EXEMPT_PATHS = new Set([
    '/api/auth/login',     // no session yet
    '/api/health',         // public probe
    '/api/logout',         // best-effort cleanup; idempotent
]);
function _isCsrfMethod(m) { return m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH'; }

async function csrfGuard(req, res, next) {
    if (!_isCsrfMethod(req.method)) return next();
    if (CSRF_EXEMPT_PATHS.has(req.path)) return next();
    const token = _extractToken(req);
    if (!token) return next();   // no session → requireAuth will 401 later
    try {
        const sess = await getSession(token);
        if (!sess) return next(); // requireAuth will 401
        const headerCsrf = req.headers[CSRF_HEADER];
        if (!headerCsrf || headerCsrf !== sess.csrfToken) {
            // log ไว้หนึ่งบรรทัด — CSRF ค้างหลัง deploy จะได้เห็นในบันทึก ไม่ dump header
            console.warn('[csrf] reject', req.method, req.path,
                '— browser CSRF stale; user needs to logout/login');
            return res.status(403).json({ ok: false, error: 'CSRF token missing or invalid' });
        }
        next();
    } catch (e) {
        console.error('[csrf]', e.message);
        res.status(500).json({ ok: false, error: 'CSRF check failed' });
    }
}
// registered after cors() + body parser so the 403 carries CORS headers

// must_change_password=true → ทำได้แค่เปลี่ยนรหัสตัวเอง/logout ที่เหลือ 423
const PW_CHANGE_ALLOWED = [
    /^\/api\/users\/\d+\/password$/,    // PUT — self password change
    /^\/api\/logout$/,                   // POST — sign out
];
function _isPwChangeAllowed(req) {
    return PW_CHANGE_ALLOWED.some(rx => rx.test(req.path));
}

async function requireAdmin(req, res, next) {
    const token = _extractToken(req);
    if (!token) return res.status(401).json({ ok: false, error: 'Authentication required' });
    try {
        const sess = await getSession(token);
        if (!sess) return res.status(401).json({ ok: false, error: 'Session expired' });
        // trainer is a superadmin: people/money surfaces accept both roles; training surfaces use requireTrainer
        if (sess.role !== 'admin' && sess.role !== 'trainer') {
            return res.status(403).json({ ok: false, error: 'Admin access required' });
        }
        if (sess.mustChangePassword && !_isPwChangeAllowed(req)) {
            return res.status(423).json({ ok: false, mustChangePassword: true,
                error: 'Password change required before continuing' });
        }
        req.session = sess;
        next();
    } catch (e) {
        console.error('[requireAdmin]', e.message);
        res.status(500).json({ ok: false, error: 'Auth check failed' });
    }
}

// trainer เท่านั้น — verdict/เฉลย/eval คือ golden dataset, admin ธรรมดาห้ามแตะ (UI ซ่อนแท็บ แต่เกตจริงอยู่นี่)
async function requireTrainer(req, res, next) {
    const token = _extractToken(req);
    if (!token) return res.status(401).json({ ok: false, error: 'Authentication required' });
    try {
        const sess = await getSession(token);
        if (!sess) return res.status(401).json({ ok: false, error: 'Session expired' });
        if (sess.role !== 'trainer') {
            return res.status(403).json({ ok: false, error: 'Trainer access required' });
        }
        if (sess.mustChangePassword && !_isPwChangeAllowed(req)) {
            return res.status(423).json({ ok: false, mustChangePassword: true,
                error: 'Password change required before continuing' });
        }
        req.session = sess;
        next();
    } catch (e) {
        console.error('[requireTrainer]', e.message);
        res.status(500).json({ ok: false, error: 'Auth check failed' });
    }
}

async function requireAuth(req, res, next) {
    const token = _extractToken(req);
    if (!token) return res.status(401).json({ ok: false, error: 'Authentication required' });
    try {
        const sess = await getSession(token);
        if (!sess) return res.status(401).json({ ok: false, error: 'Session expired' });
        if (sess.mustChangePassword && !_isPwChangeAllowed(req)) {
            return res.status(423).json({ ok: false, mustChangePassword: true,
                error: 'Password change required before continuing' });
        }
        req.session = sess;
        next();
    } catch (e) {
        console.error('[requireAuth]', e.message);
        res.status(500).json({ ok: false, error: 'Auth check failed' });
    }
}

return { csrfGuard, requireAdmin, requireTrainer, requireAuth, _isPwChangeAllowed };
};
