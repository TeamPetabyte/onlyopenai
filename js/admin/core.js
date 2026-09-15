// core.js — admin state, init, navigate and the DB fetches for users/projects.

export default {
  currentView: 'overview',
  _selectedProject: null,

  // views a hash may open; 'skills'/'sync' stay for old bookmarks though hidden in the sidebar
  _validViews: ['overview', 'users', 'projects', 'activity', 'login-history',
                'usage', 'balance', 'sync', 'skills', 'lab', 'evals'],

  // อ่าน view จาก hash — รับทั้ง #projects และ #/projects
  _viewFromHash: function () {
    var raw = String(window.location.hash || '').replace(/^#\/?/, '').trim();
    if (!raw) return null;
    return this._validViews.indexOf(raw) >= 0 ? raw : null;
  },

  init: function () {
    Auth.initDefaults();
    var self = this;
    var verEl = document.getElementById('app-version');
    if (verEl) verEl.textContent = (window.AppConfig && window.AppConfig.VERSION) || '';
    // projects first so dropdowns/lookups work everywhere
    this.fetchProjectsFromDB().then(function () {
      // return to the view in the hash; unknown → overview
      var startView = self._viewFromHash() || 'overview';
      self.navigate(startView);
      self.refreshProjectSelects();
    });
    // back/forward and manual hash edits keep sidebar + view in sync with the URL
    window.addEventListener('hashchange', function () {
      var v = self._viewFromHash();
      if (v && v !== self.currentView) self.navigate(v);
    });
    var hbtn = document.getElementById('hamburger-btn');
    if (hbtn) hbtn.addEventListener('click', function () {
      document.getElementById('sidebar').classList.toggle('open');
    });
    // on language switch re-apply labels and re-render so JS-built strings update too
    window.addEventListener('i18n:change', function () {
      if (typeof I18N !== 'undefined') I18N.apply();
      try { self.navigate(self.currentView); } catch (_) {}
    });
  },

  navigate: function (view) {
    // view ฝั่ง training เป็นของ trainer — admin เข้า hash ตรงเด้งกลับ (เกตจริงคือ 403 ฝั่ง server)
    if (view === 'skills' || view === 'lab' || view === 'evals') {
      var _s = (typeof Auth !== 'undefined') && Auth.getSession();
      if (!_s || _s.role !== 'trainer') view = 'overview';
    }
    // leaving Evals: stop the run-progress poller
    if (view !== 'evals' && this._evalPollTimer) {
      clearTimeout(this._evalPollTimer);
      this._evalPollTimer = null;
    }
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
    // 'login-history' เป็น nav เสมือน — ใช้ DOM ของ view-activity ตัวเดียวกัน
    var viewKey = (view === 'login-history') ? 'activity' : view;
    var target = document.getElementById('view-' + viewKey);
    // highlight the clicked sidebar id, not the underlying view
    var nav = document.getElementById('nav-' + view);
    if (target) target.classList.remove('hidden');
    if (nav) nav.classList.add('active');
    this.currentView = view;
    // sync hash ด้วย replaceState — ไม่ปั๊ม history; hashchange listener กันลูป
    try {
      var wantHash = '#' + view;
      if (window.location.hash !== wantHash) {
        if (window.history && typeof window.history.replaceState === 'function') {
          window.history.replaceState(null, '', wantHash);
        } else {
          window.location.hash = wantHash;
        }
      }
    } catch (_) { /* old browsers / file:// */ }
    window.scrollTo(0, 0);
    var self = this;
    // สอง route ใช้ view-activity ร่วมกัน — เปลี่ยนแค่ chrome (title/tab/ปุ่ม clear)
    var titleEl    = document.getElementById('activity-page-title');
    var subEl      = document.getElementById('activity-page-subtitle');
    var tabsEl     = document.getElementById('activity-tabs');
    var clearBtn   = document.getElementById('activity-clear-btn');
    var TTn = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    if (view === 'login-history') {
      if (titleEl) titleEl.textContent = TTn('page.loginHistory.title', 'Login History');
      if (subEl)   subEl.textContent   = TTn('page.loginHistory.sub', 'ประวัติการเข้า/ออกระบบของผู้ใช้ทั้งหมด');
      // .audit-tabs hard-codes display:flex, so a class toggle can't hide it — use inline style
      if (tabsEl)   tabsEl.style.display   = 'none';
      if (clearBtn) clearBtn.style.display = 'none';
    } else if (view === 'activity') {
      if (titleEl) titleEl.textContent = TTn('page.activity.title', 'Activity Log');
      if (subEl)   subEl.textContent   = TTn('page.activity.sub', 'ประวัติการใช้งานของผู้ใช้ · chat / admin actions');
      if (tabsEl)   tabsEl.style.display   = '';   // revert to CSS default (flex)
      if (clearBtn) clearBtn.style.display = '';
    }

    var renders = {
      overview: function () { self.renderOverview(); },
      users: function () { self.renderUsers(); },
      projects: function () { self.renderProjects(); },
      // tab 'audit' ที่ค้างจาก Login History ไม่ valid ใน Activity — รีเซ็ตเป็น 'chat'
      activity: function () {
        self.renderActivity();
        var t = self._currentActivityTab;
        if (!t || t === 'audit') t = 'chat';
        self.switchActivityTab(t);
      },
      // Login History: only the audit pane is visible
      'login-history': function () { self.switchActivityTab('audit'); },
      usage: function () { self.renderCredits(); },       // alias → Credits page (tabs inside)
      balance: function () { self.renderBalance(); },
      sync:    function () { self.renderSync(); },
      skills:  function () { self.renderSkills(); },
      lab:     function () { self.renderLab(); },         // Prompt Lab
      evals:   function () { self.renderEvals(); },       // Eval harness
    };
    if (renders[view]) renders[view]();
    document.getElementById('sidebar').classList.remove('open');
  },

  _cachedDBUsers: [],     // cache for id lookup in action functions
  _cachedDBProjects: [],  // DB projects for the sync helpers

  // อ่าน projects จาก cache DB ก่อน แล้วค่อย localStorage — กัน tab อื่น logout แล้วเห็นของเก่า
  _projectsList: function () {
    if (this._cachedDBProjects && this._cachedDBProjects.length) {
      return this._cachedDBProjects;
    }
    try { return Auth.getProjects ? Auth.getProjects() : []; }
    catch (_) { return []; }
  },

  // Projects from DB, mirrored to localStorage so legacy Auth.getProjects() callers see fresh data.
  fetchProjectsFromDB: function () {
    var self = this;
    return fetch(BASE + '/api/projects', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) return [];
        var projects = d.projects.map(function (p) {
          return {
            id:          p.id,
            name:        p.name,
            desc:        p.description || '',
            inputRate:   parseFloat(p.input_rate)   || 0.5,
            outputRate:  parseFloat(p.output_rate)  || 1.5,
            creditLimit: parseFloat(p.credit_limit) || 0,
            targetRelease: p.target_release || 'v750',
            // balance = คงเหลือ, lifetimeAmount = ยอดเติมสะสม (ไม่ลด); totalTopUp เป็น alias ให้ renderer เก่า
            balance:        parseFloat(p.balance)          || 0,
            lifetimeAmount: parseFloat(p.lifetime_amount)  || 0,
            totalTopUp:     parseFloat(p.balance)          || 0,   // legacy alias
            // server redacts the key; only has_api_key + a short preview
            hasApiKey:    !!p.has_api_key,
            apiKeyPreview: p.api_key_preview || null,
            createdAt:   p.created_at,
          };
        });
        self._cachedDBProjects = projects;
        try { Auth.saveProjects(projects); } catch (_) { /* ignore */ }
        return projects;
      })
      .catch(function () { return []; });
  },

  fetchUsersFromDB: function () {
    return Promise.all([
      fetch(BASE + '/api/users',   { headers: Auth.authHeaders() }).then(function (r) { return r.json(); }),
      fetch(BASE + '/api/history', { headers: Auth.authHeaders() }).then(function (r) { return r.json(); }),
    ])
      .then(function (results) {
        var usersData = results[0].ok ? results[0].users : [];
        var historyData = results[1].ok ? results[1].history : [];
        return usersData.map(function (u) {
          // DB snake_case → camelCase
          var userHistory = historyData
            .filter(function (h) { return h.user_id === u.id; })
            .map(function (h) {
              return {
                id: h.id,
                skillId: h.skill_id,
                skillName: h.skill_name || h.skillName || '—',
                skillEmoji: h.skill_emoji || h.skillEmoji || '🤖',
                prompt: h.prompt || '',
                response: h.response || '',
                inputTokens:  parseInt(h.input_tokens  || h.inputTokens  || 0),
                outputTokens: parseInt(h.output_tokens || h.outputTokens || 0),
                // cached + reasoning sub-totals for cost transparency
                cachedTokens:    parseInt(h.cached_tokens    || h.input_cached_tokens     || h.cachedTokens    || 0),
                reasoningTokens: parseInt(h.reasoning_tokens || h.output_reasoning_tokens || h.reasoningTokens || 0),
                cost: parseFloat(h.cost || 0),
                durationMs: parseInt(h.duration_ms || h.durationMs || 0),
                timestamp: h.created_at || h.timestamp || new Date().toISOString(),
              };
            });
          return {
            id: u.id,
            username: u.username,
            displayName: u.display_name,
            // ส่ง name/surname/acc_status ดิบให้ตารางใหม่ ไม่ต้อง derive จาก displayName
            name:        u.name || '',
            surname:     u.surname || '',
            // ใช้ effective_status จาก server (รู้เรื่อง lock) ก่อน acc_status ดิบ
            accStatus:   u.effective_status || u.acc_status || 'active',
            rawAccStatus: u.acc_status || 'active',
            accStatusId: u.acc_status_id,
            lockedUntil: u.locked_until || null,
            failedAttempts: u.failed_attempts || 0,
            role: u.role,
            plan: u.plan,
            balance: parseFloat(u.balance),
            projectId: u.project_id,
            createdAt: u.created_at,
            // per-user daily spending cap (null = no cap)
            dailyCap: (u.daily_cap === null || u.daily_cap === undefined)
                ? null : parseFloat(u.daily_cap),
            history: userHistory,
          };
        });
      })
      .catch(function () { return []; });
  },

  // sync fallback for action functions that need an id before the async fetch completes
  getUsersWithHistory: function () {
    if (this._cachedDBUsers && this._cachedDBUsers.length > 0) return this._cachedDBUsers;
    return Auth.getUsers().map(function (u) {
      var balance = parseFloat(localStorage.getItem('agenthub_balance_' + u.username) || u.balance || 0);
      var history = [];
      try { history = JSON.parse(localStorage.getItem('agenthub_history_' + u.username) || '[]'); } catch { }
      return Object.assign({}, u, { balance: balance, history: history });
    });
  },
};
