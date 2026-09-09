// auth.js — shared auth/session module plus the localStorage mirrors of users and projects.

// Global fetch patch: attach credentials:'include' and X-CSRF-Token (double-submit) on same-site
// calls, and redirect on 423 (must change password) or 401 / csrf-403 (session gone).
// The HttpOnly cookie is the only auth path — no Bearer token in localStorage.
(function () {
    if (window.__petabyteFetchPatched) return;
    window.__petabyteFetchPatched = true;
    // purge any legacy Bearer token left in localStorage
    try { localStorage.removeItem('agenthub_token'); } catch (_) {}
    const _origFetch = window.fetch.bind(window);
    const CSRF_KEY = 'agenthub_csrf';
    const STATE_CHANGING = { POST: 1, PUT: 1, DELETE: 1, PATCH: 1 };

    // Trusted origins: the page itself + the API (window.BASE) — usually another port, still same-site.
    var API_ORIGIN = '';
    try { if (window.BASE) API_ORIGIN = new URL(window.BASE).origin; } catch (_) {}
    function isSameOrigin(url) {
        try {
            if (!url || typeof url !== 'string') return true;      // Request obj, relative, etc.
            if (url.indexOf('http') !== 0) return true;            // relative URL
            var u = new URL(url, window.location.href);
            return u.origin === window.location.origin
                || (API_ORIGIN && u.origin === API_ORIGIN);
        } catch (_) { return false; }
    }

    window.fetch = function (input, init) {
        init = init || {};
        // HttpOnly session cookie rides on same-origin requests
        var urlStr = (typeof input === 'string') ? input : (input && input.url) || '';
        if (isSameOrigin(urlStr) && init.credentials === undefined) {
            init.credentials = 'include';
        }
        // Attach CSRF header on state-changing methods
        var method = (init.method || (input && input.method) || 'GET').toUpperCase();
        if (STATE_CHANGING[method] && isSameOrigin(urlStr)) {
            var csrf = null;
            try { csrf = localStorage.getItem(CSRF_KEY); } catch (_) {}
            if (csrf) {
                // Normalize headers — caller may pass plain object, Headers, or nothing
                var h = init.headers;
                if (h instanceof Headers) {
                    if (!h.has('X-CSRF-Token')) h.set('X-CSRF-Token', csrf);
                } else if (Array.isArray(h)) {
                    var hasIt = h.some(function (p) { return p[0] && p[0].toLowerCase() === 'x-csrf-token'; });
                    if (!hasIt) h.push(['X-CSRF-Token', csrf]);
                } else {
                    h = h || {};
                    var already = Object.keys(h).some(function (k) { return k.toLowerCase() === 'x-csrf-token'; });
                    if (!already) h['X-CSRF-Token'] = csrf;
                    init.headers = h;
                }
            }
        }
        return _origFetch(input, init).then(function (res) {
            try {
                const path = (window.location.pathname || '').toLowerCase();
                const onPwPage    = path.indexOf('change-password') >= 0;
                const onLoginPage = path.indexOf('login') >= 0;
                if (res.status === 423 && !onPwPage) {
                    try {
                        const s = JSON.parse(localStorage.getItem('agenthub_session') || 'null');
                        if (s) { s.mustChangePassword = true; localStorage.setItem('agenthub_session', JSON.stringify(s)); }
                    } catch (_) {}
                    setTimeout(function () { window.location.href = '/change-password'; }, 0);
                }
                // 401 = session expired or wiped server-side: redirect to login once per page-load.
                // Skip on the login/change-password pages and for /api/auth/login (a 401 there is a wrong password).
                if (res.status === 401 && !onPwPage && !onLoginPage && !window.__petabyteAuthExpired) {
                    var reqUrl = (typeof input === 'string')
                        ? input
                        : (input && input.url) || '';
                    var isLoginCall = /\/api\/auth\/login\b/.test(String(reqUrl));
                    if (!isLoginCall) {
                        window.__petabyteAuthExpired = true;
                        // wipe local session bits so login.html treats us as logged out
                        try {
                            localStorage.removeItem('agenthub_session');
                            localStorage.removeItem('agenthub_token');
                            localStorage.removeItem('agenthub_csrf');
                        } catch (_) {}
                        setTimeout(function () {
                            window.location.href = '/login?expired=1';
                        }, 0);
                    }
                }

                // A 403 whose body mentions csrf is a stale token after a server-side session
                // rotation — treat as expired. Clone first so the caller's .json() still works.
                if (res.status === 403 && !onPwPage && !onLoginPage && !window.__petabyteAuthExpired) {
                    res.clone().json().then(function (body) {
                        if (body && /csrf/i.test(String(body.error || ''))) {
                            window.__petabyteAuthExpired = true;
                            try {
                                localStorage.removeItem('agenthub_session');
                                localStorage.removeItem('agenthub_token');
                                localStorage.removeItem('agenthub_csrf');
                            } catch (_) {}
                            window.location.href = '/login?expired=1';
                        }
                    }).catch(function () { /* not JSON body — leave alone */ });
                }
            } catch (_) {}
            return res;
        });
    };
})();

const Auth = {
    // --- Keys ---
    SESSION_KEY: 'agenthub_session',
    TOKEN_KEY:   'agenthub_token',     // legacy — only ever cleared, never written
    CSRF_KEY:    'agenthub_csrf',      // double-submit CSRF token
    USERS_KEY: 'agenthub_admin_users',
    PROJECTS_KEY: 'agenthub_projects',

    // --- Token helpers ---
    // Auth rides in the HttpOnly cookie; authHeaders() adds only Content-Type + CSRF.
    getCsrf: function () {
        try { return localStorage.getItem(this.CSRF_KEY) || null; } catch (_) { return null; }
    },
    authHeaders: function (extra) {
        var h = { 'Content-Type': 'application/json' };
        var c = this.getCsrf();
        if (c) h['X-CSRF-Token'] = c;
        if (extra) for (var k in extra) h[k] = extra[k];
        return h;
    },
    /** fetch() wrapper that adds auth headers and redirects on 423 (must change password). */
    fetch: function (url, opts) {
        opts = opts || {};
        opts.headers = this.authHeaders(opts.headers);
        var fullUrl = (url.indexOf('http') === 0) ? url : (BASE + url);
        var self = this;
        return fetch(fullUrl, opts).then(function (res) {
            // Skip the password-change page itself — it's the only escape hatch.
            var path = (window.location.pathname || '').toLowerCase();
            var onPwPage = path.indexOf('change-password') >= 0;
            if (res.status === 423 && !onPwPage) {
                self._markPwChangeRequired();
                window.location.href = '/change-password';
            }
            return res;
        });
    },

    /** Mark the current session as needing a password change. */
    _markPwChangeRequired: function () {
        try {
            var s = JSON.parse(localStorage.getItem(this.SESSION_KEY) || 'null');
            if (s) { s.mustChangePassword = true; localStorage.setItem(this.SESSION_KEY, JSON.stringify(s)); }
        } catch (_) {}
    },

    // --- Default projects ---
    DEFAULT_PROJECTS: [
        {
            id: 'proj_sap_dev',
            name: 'SAP Development',
            desc: 'ทีม ABAP Developer ภายใน',
            inputRate: 0.50, outputRate: 1.50, color: '#e8e8e8',
            totalTopUp: 500.00,
            createdAt: new Date().toISOString(),
        },
        {
            id: 'proj_sap_cons',
            name: 'SAP Consulting',
            desc: 'ทีม Consultant โครงการลูกค้า',
            inputRate: 0.35, outputRate: 1.10, color: '#bbbbbb',
            totalTopUp: 750.00,
            createdAt: new Date().toISOString(),
        },
        {
            id: 'proj_sap_qa',
            name: 'SAP QA & Testing',
            desc: 'ทีม QA และ Unit Testing',
            inputRate: 0.25, outputRate: 0.80, color: '#999999',
            totalTopUp: 1000.00,
            createdAt: new Date().toISOString(),
        },
    ],

    // --- Default users ---
    DEFAULT_USERS: [
        // display-only demo rows, no passwords — login is server-side only
        { username: 'user', displayName: 'สมชาย ABAP Developer', projectId: 'proj_sap_dev', balance: 100.00 },
        { username: 'user2', displayName: 'วิชัย SAP Consultant', projectId: 'proj_sap_cons', balance: 250.00 },
        { username: 'user3', displayName: 'นิภา QA Engineer', projectId: 'proj_sap_qa', balance: 500.00 },
    ],

    // --- Init default data ---
    initDefaults() {
        if (!localStorage.getItem(this.PROJECTS_KEY)) {
            localStorage.setItem(this.PROJECTS_KEY, JSON.stringify(this.DEFAULT_PROJECTS));
        }
        if (!localStorage.getItem(this.USERS_KEY)) {
            const users = this.DEFAULT_USERS.map(u => ({
                username: u.username,
                displayName: u.displayName,
                role: 'user',
                projectId: u.projectId,
                balance: parseFloat(localStorage.getItem(`agenthub_balance_${u.username}`) || u.balance),
                history: [],
                createdAt: new Date().toISOString(),
            }));
            localStorage.setItem(this.USERS_KEY, JSON.stringify(users));
        }
        // Migrate projects that don't have totalTopUp yet
        const projects = this.getProjects();
        let dirty = false;
        projects.forEach(p => { if (p.totalTopUp === undefined) { p.totalTopUp = 0; dirty = true; } });
        if (dirty) this.saveProjects(projects);
        // Init per-user balance keys
        const users = this.getUsers();
        users.forEach(u => {
            if (!localStorage.getItem(`agenthub_balance_${u.username}`)) {
                const def = this.DEFAULT_USERS.find(d => d.username === u.username);
                localStorage.setItem(`agenthub_balance_${u.username}`, (def ? def.balance : 100).toString());
            }
            if (!localStorage.getItem(`agenthub_history_${u.username}`)) {
                localStorage.setItem(`agenthub_history_${u.username}`, '[]');
            }
        });
    },

    // --- Login (DB-backed) ---
    login(username, password) {
        return fetch(BASE + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
            credentials: 'include',                          // receive the HttpOnly cookie
            signal: AbortSignal.timeout(5000)
        })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!data.ok) return { ok: false, error: data.error || 'Invalid credentials', locked: !!data.locked };
                var u = data.user;
                var mustChangePw = !!(data.mustChangePassword || (u && u.mustChangePassword));
                var session = {
                    userId: u.id,
                    username: u.username,
                    displayName: u.displayName,
                    role: u.role,
                    projectId: u.projectId,
                    mustChangePassword: mustChangePw,
                    loginTime: new Date().toISOString(),
                };
                localStorage.setItem(Auth.SESSION_KEY, JSON.stringify(session));
                // the session token lives only in the HttpOnly cookie — never in localStorage
                try { localStorage.removeItem(Auth.TOKEN_KEY); } catch (_) {}
                // CSRF token is echoed back in the X-CSRF-Token header
                if (data.csrfToken) localStorage.setItem(Auth.CSRF_KEY, data.csrfToken);
                // mirror balance/project to top-level keys; index.html reads agenthub_balance on boot
                localStorage.setItem('agenthub_balance', u.balance.toString());
                localStorage.setItem('agenthub_history', JSON.stringify([]));
                if (u.projectId) localStorage.setItem('agenthub_project', u.projectId);
                return { ok: true, session, mustChangePassword: mustChangePw };
            })
            .catch(function (e) {
                // เซิร์ฟเวอร์เป็นที่เดียวที่ยืนยันตัวตนได้ — ห้าม fallback ไป localStorage
                console.warn('[Auth] API unavailable:', e.message);
                return { ok: false, error: 'ติดต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง' };
            });
    },

    // --- Session ---
    // Normalize a role from any source to 'admin' / 'trainer' / 'user' (trainer = superadmin).
    _normalizeRole: function (r) {
        var v = String(r || '').toLowerCase().trim();
        if (v === 'admin')   return 'admin';
        if (v === 'trainer') return 'trainer';
        return 'user';
    },
    /** True while the session-scoped `petabyte_active` cookie is alive, i.e. the browser hasn't closed since login. */
    _hasActiveCookie() {
        try {
            return document.cookie.split(';').some(function (c) {
                return c.trim() === 'petabyte_active=1';
            });
        } catch (_) { return false; }
    },
    getSession() {
        try {
            const s = JSON.parse(localStorage.getItem(this.SESSION_KEY) || 'null');
            // "close browser = logout": a localStorage session is only valid while the marker cookie lives
            if (s && !this._hasActiveCookie()) {
                try {
                    localStorage.removeItem(this.SESSION_KEY);
                    localStorage.removeItem(this.TOKEN_KEY);
                    localStorage.removeItem(this.CSRF_KEY);
                } catch (_) {}
                return null;
            }
            if (s && s.role) s.role = this._normalizeRole(s.role);
            return s;
        } catch { return null; }
    },

    // requiredRole: a role string or an array of roles
    check(requiredRole) {
        const session = this.getSession();
        if (!session) { window.location.href = '/login'; return false; }
        // must change password before anything else
        if (session.mustChangePassword) {
            window.location.href = '/change-password';
            return false;
        }
        const allowed = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
        if (!allowed.includes(session.role)) {
            window.location.href = (session.role === 'admin' || session.role === 'trainer') ? '/admin' : '/';
            return false;
        }
        return true;
    },

    /** Change own password; on success clears the local mustChangePassword flag. */
    changePassword: function (newPassword, currentPassword) {
        var session = this.getSession();
        if (!session || !session.userId) {
            return Promise.resolve({ ok: false, error: 'Not logged in' });
        }
        return fetch(BASE + '/api/users/' + session.userId + '/password', {
            method: 'PUT',
            headers: this.authHeaders(),                   // includes X-CSRF-Token
            credentials: 'include',
            // the server verifies currentPassword for a self-change
            body: JSON.stringify({ password: newPassword, currentPassword: currentPassword || '' }),
        })
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
            .then(function (resp) {
                if (resp.status === 200 && resp.body && resp.body.ok) {
                    // Clear the flag in local session
                    try {
                        var s = JSON.parse(localStorage.getItem(Auth.SESSION_KEY) || 'null');
                        if (s) { s.mustChangePassword = false; localStorage.setItem(Auth.SESSION_KEY, JSON.stringify(s)); }
                    } catch (_) {}
                    return { ok: true };
                }
                return { ok: false, error: (resp.body && resp.body.error) || 'Password change failed' };
            })
            .catch(function (e) { return { ok: false, error: e.message || 'Network error' }; });
    },

    logout() {
        const session = this.getSession();
        if (session && session.role === 'user') {
            localStorage.setItem(`agenthub_balance_${session.username}`, localStorage.getItem('agenthub_balance') || '0');
            localStorage.setItem(`agenthub_history_${session.username}`, localStorage.getItem('agenthub_history') || '[]');
            const users = this.getUsers();
            const idx = users.findIndex(u => u.username === session.username);
            if (idx !== -1) {
                users[idx].balance = parseFloat(localStorage.getItem('agenthub_balance') || '0');
                users[idx].history = JSON.parse(localStorage.getItem('agenthub_history') || '[]');
                this.saveUsers(users);
            }
        }
        // invalidate the server session (best-effort, non-blocking); server clears cookie + row
        try {
            fetch(BASE + '/api/logout', {
                method: 'POST',
                headers: this.authHeaders(),               // includes X-CSRF-Token
                credentials: 'include',
                keepalive: true,                           // survives the navigation below
            });
        } catch (_) { /* ignore */ }
        localStorage.removeItem(this.SESSION_KEY);
        localStorage.removeItem(this.TOKEN_KEY);
        localStorage.removeItem(this.CSRF_KEY);
        window.location.href = '/login';
    },

    // --- Users — async (DB) ---
    fetchUsers() {
        return fetch(BASE + '/api/users', { headers: this.authHeaders() })
            .then(r => r.json())
            .then(d => d.ok ? d.users.map(u => ({
                id: u.id, username: u.username, password: '', displayName: u.display_name,
                role: u.role, plan: u.plan, balance: parseFloat(u.balance),
                projectId: u.project_id, history: [], createdAt: u.created_at
            })) : [])
            .catch(() => this.getUsers());
    },

    // --- Users — sync localStorage (fallback) ---
    getUsers() {
        try { return JSON.parse(localStorage.getItem(this.USERS_KEY) || '[]'); } catch { return []; }
    },
    saveUsers(users) { localStorage.setItem(this.USERS_KEY, JSON.stringify(users)); },

    createUser({ username, password, displayName, projectId, balance }) {
        const users = this.getUsers();
        if (users.find(u => u.username === username)) return { ok: false, error: `Username "${username}" มีอยู่แล้ว` };
        const newUser = {
            username, password, displayName,
            role: 'user', projectId,
            balance: parseFloat(balance) || 100,
            history: [], createdAt: new Date().toISOString(),
        };
        users.push(newUser);
        this.saveUsers(users);
        localStorage.setItem(`agenthub_balance_${username}`, newUser.balance.toString());
        localStorage.setItem(`agenthub_history_${username}`, '[]');
        return { ok: true, user: newUser };
    },

    deleteUser(username) {
        let users = this.getUsers();
        users = users.filter(u => u.username !== username);
        this.saveUsers(users);
    },

    setUserBalance(username, newBalance) {
        const users = this.getUsers();
        const idx = users.findIndex(u => u.username === username);
        if (idx !== -1) {
            users[idx].balance = newBalance;
            this.saveUsers(users);
            localStorage.setItem(`agenthub_balance_${username}`, newBalance.toString());
            const session = this.getSession();
            if (session && session.username === username) localStorage.setItem('agenthub_balance', newBalance.toString());
        }
    },

    setUserProject(username, projectId) {
        const users = this.getUsers();
        const idx = users.findIndex(u => u.username === username);
        if (idx !== -1) {
            users[idx].projectId = projectId;
            this.saveUsers(users);
            const session = this.getSession();
            if (session && session.username === username) {
                session.projectId = projectId;
                localStorage.setItem(this.SESSION_KEY, JSON.stringify(session));
                localStorage.setItem('agenthub_project', projectId);
            }
        }
    },

    // --- Projects — async (DB) ---
    fetchProjects() {
        return fetch(BASE + '/api/projects', { headers: this.authHeaders() })
            .then(r => r.json())
            .then(d => d.ok ? d.projects.map(p => ({
                id: p.id, name: p.name, desc: p.description,
                inputRate: parseFloat(p.input_rate), outputRate: parseFloat(p.output_rate),
                totalTopUp: 0, createdAt: p.created_at
            })) : [])
            .catch(() => this.getProjects());
    },

    // --- Projects — sync localStorage (fallback) ---
    getProjects() {
        try { return JSON.parse(localStorage.getItem(this.PROJECTS_KEY) || '[]'); } catch { return []; }
    },
    saveProjects(projects) { localStorage.setItem(this.PROJECTS_KEY, JSON.stringify(projects)); },

    createProject({ name, desc, inputRate, outputRate }) {
        const projects = this.getProjects();
        const id = 'proj_' + name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now();
        const proj = {
            id, name, desc: desc || '',
            inputRate: parseFloat(inputRate) || 0.5,
            outputRate: parseFloat(outputRate) || 1.5,
            totalTopUp: 0,
            createdAt: new Date().toISOString(),
        };
        projects.push(proj);
        this.saveProjects(projects);
        return proj;
    },

    topupProject(projectId, amount) {
        const projects = this.getProjects();
        const idx = projects.findIndex(p => p.id === projectId);
        if (idx !== -1) {
            projects[idx].totalTopUp = (projects[idx].totalTopUp || 0) + parseFloat(amount);
            this.saveProjects(projects);
            return projects[idx];
        }
        return null;
    },

    // Returns { totalTopUp, distributed, remaining } for a project
    getProjectBudget(projectId) {
        const proj = this.getProjectById(projectId);
        if (!proj) return { totalTopUp: 0, distributed: 0, remaining: 0, costBilled: 0 };
        const users = this.getUsers();
        const members = users.filter(u => u.projectId === projectId);
        const distributed = members.reduce((s, u) => {
            return s + parseFloat(localStorage.getItem(`agenthub_balance_${u.username}`) || u.balance || 0);
        }, 0);
        const costBilled = members.reduce((s, u) => {
            try {
                const hist = JSON.parse(localStorage.getItem(`agenthub_history_${u.username}`) || '[]');
                return s + hist.reduce((ss, h) => ss + (h.cost || 0), 0);
            } catch { return s; }
        }, 0);
        const totalTopUp = proj.totalTopUp || 0;
        const remaining = Math.max(0, totalTopUp - distributed);
        return { totalTopUp, distributed, remaining, costBilled };
    },

    deleteProject(projectId) {
        let projects = this.getProjects();
        projects = projects.filter(p => p.id !== projectId);
        this.saveProjects(projects);
    },

    getProjectById(id) {
        return this.getProjects().find(p => p.id === id) || null;
    },
};

// ES module: the global must be put on window explicitly
window.Auth = Auth;
