// core.js — state + init + navigate + fetch users/projects
// (ไม่ใช้ helper กลาง)

export default {
  currentView: 'overview',
  _selectedProject: null,

  // allow-list ของ view ที่ hash เปิดได้ — 'skills'/'sync' คงไว้ให้ bookmark เก่า แม้ซ่อนใน sidebar
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
    // เวอร์ชันที่ sidebar — source of truth คือ AppConfig.VERSION
    var verEl = document.getElementById('app-version');
    if (verEl) verEl.textContent = (window.AppConfig && window.AppConfig.VERSION) || '';
    // Load projects from DB first so project dropdowns / lookups work everywhere
    this.fetchProjectsFromDB().then(function () {
      // refresh แล้วกลับ view เดิมจาก hash; ไม่รู้จักตกที่ overview
      var startView = self._viewFromHash() || 'overview';
      self.navigate(startView);
      self.refreshProjectSelects();
    });
    // respond to back/forward button + manual hash edits so the
    // sidebar highlight + visible view stay in sync with the URL.
    window.addEventListener('hashchange', function () {
      var v = self._viewFromHash();
      if (v && v !== self.currentView) self.navigate(v);
    });
    var hbtn = document.getElementById('hamburger-btn');
    if (hbtn) hbtn.addEventListener('click', function () {
      document.getElementById('sidebar').classList.toggle('open');
    });
    // when the language switches, re-apply static labels and
    // re-render the current view so JS-built strings (cards, tables) update too.
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
    // v1.7.3: leaving the Evals view? stop the run-progress poller so it
    // doesn't keep fetching in the background from another tab.
    if (view !== 'evals' && this._evalPollTimer) {
      clearTimeout(this._evalPollTimer);
      this._evalPollTimer = null;
    }
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
    // 'login-history' เป็น nav เสมือน — ใช้ DOM ของ view-activity ตัวเดียวกัน
    var viewKey = (view === 'login-history') ? 'activity' : view;
    var target = document.getElementById('view-' + viewKey);
    // Highlight by the clicked sidebar id, not the underlying view, so the
    // user sees "Login History" stay active when they pick that entry.
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
      // The .audit-tabs class hard-codes `display: flex` without a `.hidden`
      // override, so toggling a class won't hide the bar. Use inline style.
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
      // Login History: only the audit pane should be visible. switchActivityTab
      // also hides chat + action panes so the user sees just the login table.
      'login-history': function () { self.switchActivityTab('audit'); },
      usage: function () { self.renderCredits(); },       // alias → Credits page (tabs inside)
      balance: function () { self.renderBalance(); },
      sync:    function () { self.renderSync(); },        // Phase 17.4
      skills:  function () { self.renderSkills(); },      // Phase 18
      lab:     function () { self.renderLab(); },         // Prompt Lab
      evals:   function () { self.renderEvals(); },       // Eval harness
    };
    if (renders[view]) renders[view]();
    document.getElementById('sidebar').classList.remove('open');
  },

  _cachedDBUsers: [],     // cache for id lookup in action functions
  _cachedDBProjects: [],  // cache so sync helpers (renderUsers' project select etc.) see DB data

  // อ่าน projects จาก cache DB ก่อน แล้วค่อย localStorage — กัน tab อื่น logout แล้วเห็นของเก่า
  _projectsList: function () {
    if (this._cachedDBProjects && this._cachedDBProjects.length) {
      return this._cachedDBProjects;
    }
    try { return Auth.getProjects ? Auth.getProjects() : []; }
    catch (_) { return []; }
  },

  // project list from DB. Mirror cached list to localStorage so
  // any legacy code path (Auth.getProjects) sees up-to-date values until removed.
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
            // balance = คงเหลือ, lifetimeAmount = ยอดเติมสะสม (ไม่ลด); totalTopUp คง alias ไว้ให้ renderer เก่า
            balance:        parseFloat(p.balance)          || 0,
            lifetimeAmount: parseFloat(p.lifetime_amount)  || 0,
            totalTopUp:     parseFloat(p.balance)          || 0,   // legacy alias
            // server now redacts the secret. We only know if it
            // exists (`has_api_key`) and a short preview for display.
            hasApiKey:    !!p.has_api_key,
            apiKeyPreview: p.api_key_preview || null,
            createdAt:   p.created_at,
          };
        });
        self._cachedDBProjects = projects;
        // Mirror to localStorage so legacy Auth.getProjects() callers stay in sync
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
          // Normalize DB snake_case → camelCase so render functions work correctly
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
                // track cached + reasoning sub-totals for cost transparency
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
            // Phase 11 B3: per-user daily spending cap (null = no cap)
            dailyCap: (u.daily_cap === null || u.daily_cap === undefined)
                ? null : parseFloat(u.daily_cap),
            history: userHistory,
          };
        });
      })
      .catch(function () { return []; });
  },

  // Sync fallback (for action functions that need id before async completes)
  getUsersWithHistory: function () {
    if (this._cachedDBUsers && this._cachedDBUsers.length > 0) return this._cachedDBUsers;
    return Auth.getUsers().map(function (u) {
      var balance = parseFloat(localStorage.getItem('agenthub_balance_' + u.username) || u.balance || 0);
      var history = [];
      try { history = JSON.parse(localStorage.getItem('agenthub_history_' + u.username) || '[]'); } catch (e) { }
      return Object.assign({}, u, { balance: balance, history: history });
    });
  },
};
