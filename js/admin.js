/**
 * admin.js — Admin Dashboard Logic for PetabyteAi
 * Features: User Management (add/edit/delete), Project Management, Rate Config, Activity Log
 */

document.addEventListener('DOMContentLoaded', function () {
  if (!Auth.check('admin')) return;
  var session = Auth.getSession();
  var el = document.getElementById('admin-display-name');
  if (el) el.textContent = session.displayName || session.username;
  admin.init();
});

// ── Helpers ───────────────────────────────────────────────
// Phase 16.23: formatTHB kept for back-compat; new code should call
// formatMoney() for consistent thousand-separators.
function formatTHB(n) { return '฿' + parseFloat(n || 0).toFixed(2); }
// Standardised currency formatter — produces "฿2,050.00" with comma
// grouping. Use this everywhere unless a column specifically needs the
// no-comma compact form (e.g. dense table cells).
function formatMoney(n) {
  return '฿' + parseFloat(n || 0)
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Standard date format — "DD/MM/YYYY HH:MM" 24-hour, locale-stable.
// formatDate() (Thai locale, 2-digit year) is kept for back-compat with
// any caller that already uses it.
function formatDateStd(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  var pad = function (n) { return String(n).padStart(2, '0'); };
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear()
       + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
// Phase 16.1: HTML-escape for table cells that render user-supplied data
// (project names, top-up notes, user names). Older code in this file inlines
// untrusted values directly which is XSS-prone — new code should pass through
// here. Kept tiny on purpose; no DOM allocation.
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('th-TH', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}
// Phase 19.5: auto-detect error tone from the leading emoji so we don't
// have to remember to pass `'error'` every time. Cuts down on the
// "❌ foo" toasts that were rendering with neutral/green styling because
// callers forgot the second arg. Explicit type still wins if provided.
function flash(msg, type) {
  var s = String(msg || '');
  if (!type) {
    if (/^\s*(❌|⚠️|🚫|🔒)/.test(s))      type = 'error';
    else if (/^\s*(✅|✓|🎉)/.test(s))     type = 'success';
  }
  type = type || '';
  var el = document.getElementById('flash');
  el.textContent = s;
  el.className = 'flash show' + (type ? ' flash-' + type : '');
  setTimeout(function () { el.classList.remove('show'); }, 2800);
}
function showModal(id) { document.getElementById(id).classList.add('show'); }
function hideModal(id) { document.getElementById(id).classList.remove('show'); }

// ── Admin App ─────────────────────────────────────────────
var admin = {
  currentView: 'overview',
  _selectedProject: null,

  // Phase 19.4: routes that the sidebar can navigate to. The order doesn't
  // matter — used as the allow-list when resolving a URL hash on load
  // (so we don't accept arbitrary `#whatever` values).
  // Phase 20.2: 'skills' and 'sync' are kept in the list so old bookmarks
  // still resolve, but their sidebar entries are hidden (display:none) until
  // the team is ready to surface them.
  _validViews: ['overview', 'users', 'projects', 'activity', 'login-history',
                'usage', 'balance', 'sync', 'skills', 'lab'],

  // Phase 19.4: read the current URL hash and return a valid view name,
  // or null if there's nothing usable. Stripping the leading `#/` lets us
  // accept either `#projects` or `#/projects` (router-style) without fuss.
  _viewFromHash: function () {
    var raw = String(window.location.hash || '').replace(/^#\/?/, '').trim();
    if (!raw) return null;
    return this._validViews.indexOf(raw) >= 0 ? raw : null;
  },

  init: function () {
    Auth.initDefaults();
    var self = this;
    // Show the app version in the sidebar footer (single source of truth:
    // js/config.js AppConfig.VERSION — bump it alongside the git tag when
    // a release ships).
    var verEl = document.getElementById('app-version');
    if (verEl) verEl.textContent = (window.AppConfig && window.AppConfig.VERSION) || '';
    // Load projects from DB first so project dropdowns / lookups work everywhere
    this.fetchProjectsFromDB().then(function () {
      // Phase 19.4: restore the last-visited view from the URL hash so a
      // browser refresh keeps the user where they were. Falls back to
      // 'overview' if the hash is missing or unknown.
      var startView = self._viewFromHash() || 'overview';
      self.navigate(startView);
      self.refreshProjectSelects();
    });
    // Phase 19.4: respond to back/forward button + manual hash edits so the
    // sidebar highlight + visible view stay in sync with the URL.
    window.addEventListener('hashchange', function () {
      var v = self._viewFromHash();
      if (v && v !== self.currentView) self.navigate(v);
    });
    var hbtn = document.getElementById('hamburger-btn');
    if (hbtn) hbtn.addEventListener('click', function () {
      document.getElementById('sidebar').classList.toggle('open');
    });
    // Phase 3 (i18n): when the language switches, re-apply static labels and
    // re-render the current view so JS-built strings (cards, tables) update too.
    window.addEventListener('i18n:change', function () {
      if (typeof I18N !== 'undefined') I18N.apply();
      try { self.navigate(self.currentView); } catch (_) {}
    });
  },

  navigate: function (view) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.remove('active'); });
    // Phase 16.3: 'login-history' is a virtual nav target that maps to the
    // Activity Log view with the audit (login/logout) sub-tab pre-selected.
    // The actual <div id="view-..."> we show is still 'view-activity'.
    var viewKey = (view === 'login-history') ? 'activity' : view;
    var target = document.getElementById('view-' + viewKey);
    // Highlight by the clicked sidebar id, not the underlying view, so the
    // user sees "Login History" stay active when they pick that entry.
    var nav = document.getElementById('nav-' + view);
    if (target) target.classList.remove('hidden');
    if (nav) nav.classList.add('active');
    this.currentView = view;
    // Phase 19.4: sync the URL hash so refresh / share-link returns to the
    // same view. Use replaceState (not assignment) so we don't pollute the
    // history stack — each sidebar click would otherwise be a back-button
    // entry. hashchange listener guards against an infinite loop.
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
    // Phase 16.12: re-skin the shared view-activity element based on which
    // sidebar entry brought us here. The two routes share renderAuditLog/etc
    // but show different chrome (title, subtitle, tab bar visibility, clear
    // button) so the user can't tell they're the same DOM node.
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
      // Phase 16.12.1: if the stored tab is 'audit' (set by a prior visit to
      // Login History), it's no longer a valid Activity Log tab — reset to
      // 'chat'. Otherwise keep whatever sub-tab the user last chose IN
      // Activity Log (chat or action).
      activity: function () {
        self.renderActivity();
        var t = self._currentActivityTab;
        if (!t || t === 'audit') t = 'chat';
        self.switchActivityTab(t);
      },
      // Login History: only the audit pane should be visible. switchActivityTab
      // also hides chat + action panes so the user sees just the login table.
      'login-history': function () { self.switchActivityTab('audit'); },
      usage: function () { self.renderCredits(); },       // Phase 16.11: alias → Credits page (tabs inside)
      balance: function () { self.renderBalance(); },
      sync:    function () { self.renderSync(); },        // Phase 17.4
      skills:  function () { self.renderSkills(); },      // Phase 18
      lab:     function () { self.renderLab(); },         // Phase 29: Prompt Lab
    };
    if (renders[view]) renders[view]();
    document.getElementById('sidebar').classList.remove('open');
  },

  _cachedDBUsers: [],     // cache for id lookup in action functions
  _cachedDBProjects: [],  // cache so sync helpers (renderUsers' project select etc.) see DB data

  // Phase 19.5: read projects through the in-memory DB cache when available
  // and only fall back to localStorage (Auth.getProjects) when the cache is
  // empty. Avoids "Tab A logged out → Tab B saw stale localStorage" surprise
  // by letting fresh DB data win every time renderProjects/openTopUp/etc fire.
  _projectsList: function () {
    if (this._cachedDBProjects && this._cachedDBProjects.length) {
      return this._cachedDBProjects;
    }
    try { return Auth.getProjects ? Auth.getProjects() : []; }
    catch (_) { return []; }
  },

  // Phase 6.2: project list from DB. Mirror cached list to localStorage so
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
            // Phase 20: split current balance vs lifetime topped-up sum.
            //  - balance:        ยอดคงเหลือใช้ได้ตอนนี้ (decreases on spend)
            //  - lifetimeAmount: ยอดสะสมที่ลูกค้าเคยเติมทั้งหมด (never decreases)
            // `totalTopUp` is kept as an alias for balance for back-compat
            // with older renderers that referenced it.
            balance:        parseFloat(p.balance)          || 0,
            lifetimeAmount: parseFloat(p.lifetime_amount)  || 0,
            totalTopUp:     parseFloat(p.balance)          || 0,   // legacy alias
            // Phase 16.5: server now redacts the secret. We only know if it
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
                // Phase 16.9: track cached + reasoning sub-totals for cost transparency
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
            // Phase 16.4: surface raw name parts + acc_status so the new
            // mockup-style user table can render them as separate columns
            // and a coloured status pill without re-deriving from displayName.
            name:        u.name || '',
            surname:     u.surname || '',
            // Phase 16.10: prefer effective_status (server-computed, lock-aware)
            // over raw acc_status. The badge UI reads `accStatus`; toggling
            // logic still has access to the underlying raw_acc_status if needed.
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

  // ── OVERVIEW ──────────────────────────────────────────
  renderOverview: function () {
    var self = this;
    var projects = this._projectsList();
    // Phase 21.11 (Concept B dashboard): pull live per-user rollups from
    // /api/credits (lifetime tokens/spend/requests + today's cap usage) so the
    // dashboard reflects the project-pool model, not stale localStorage wallets.
    Promise.all([
      this.fetchUsersFromDB(),
      fetch(BASE + '/api/credits', { headers: Auth.authHeaders() })
        .then(function (r) { return r.json(); })
        .then(function (d) { return (d && d.ok && d.credits) ? d.credits : []; })
        .catch(function () { return []; }),
    ]).then(function (results) {
      var dbUsers = results[0] || [];
      var credits = results[1] || [];
      self._cachedDBUsers = dbUsers;
      self._cachedCredits = credits;   // shared with renderProjectDetail / Cap page

      // Totals from DB (accurate) — sum lifetime rollups across all users.
      var totalRequests = credits.reduce(function (s, c) { return s + Number(c.lifetimeRequests || 0); }, 0);
      var totalTokens   = credits.reduce(function (s, c) { return s + Number(c.lifetimeTokens   || 0); }, 0);
      var totalSpendAll = credits.reduce(function (s, c) { return s + Number(c.lifetimeSpend    || 0); }, 0);
      // Project-level money totals (Concept B): current pool + lifetime top-up.
      var totalTopUpAll  = projects.reduce(function (s, p) { return s + (p.lifetimeAmount || 0); }, 0);
      var totalBalanceAll = projects.reduce(function (s, p) { return s + (p.balance || p.totalTopUp || 0); }, 0);
      // Phase 16.23: redesigned dashboard mini-cards to match the project
      // stat-card pattern (icon + label-uppercase + bold mono value).
      // Each card has a left accent stripe in the accent colour so they
      // pop in both light and dark themes without looking flat.
      var miniCard = function (icon, label, value, sub) {
        return '<div style="position:relative;padding:18px 20px 18px 22px;'
          + 'background:var(--surface-2);border:1px solid var(--border-default);'
          + 'border-radius:12px;overflow:hidden">'
          // Left accent stripe
          + '<div style="position:absolute;top:0;bottom:0;left:0;width:3px;background:var(--accent)"></div>'
          + '<div style="font-size:.68rem;color:var(--text-3);text-transform:uppercase;'
          +   'letter-spacing:.06em;margin-bottom:8px;font-weight:600">'
          +   icon + ' ' + label + '</div>'
          + '<div style="font-size:1.55rem;font-weight:800;color:var(--text-1);'
          +   'font-family:Geist Mono,monospace;letter-spacing:-.02em;margin-bottom:4px">'
          +   value + '</div>'
          + (sub ? '<div style="font-size:.72rem;color:var(--text-3)">' + sub + '</div>' : '')
          + '</div>';
      };
      var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
      document.getElementById('overview-mini').innerHTML =
          miniCard('👥', TT('dash.users','Users'),           dbUsers.length.toLocaleString(),  projects.length + ' projects')
        + miniCard('🔢', TT('dash.totalTokens','Total Tokens'), totalTokens.toLocaleString(),  TT('dash.tokensSub','สะสมทุก user'))
        + miniCard('💸', TT('dash.totalSpend','Total Spend'), formatMoney(totalSpendAll),       TT('dash.spendSub','ใช้จ่ายสะสมทุก user'))
        // Phase 20: two related but distinct numbers — lifetime sum of every
        // top-up (never decreases) vs. current redeemable balance.
        + miniCard('💰', TT('dash.lifetimeTopup','Lifetime Top-up'), formatMoney(totalTopUpAll), TT('dash.topupSub','ยอดสะสมที่ลูกค้าเคยเติม'))
        + miniCard('🏦', TT('dash.projectBalance','Project Balance'), formatMoney(totalBalanceAll), TT('dash.balanceSub','ยอดคงเหลือกองกลางตอนนี้'));

      var saved = self._selectedProject || (projects[0] && projects[0].id) || null;
      // Phase 16.20: project picker is now a custom dropdown (matches the
      // pattern used in Top-up, Add User, Edit User, etc.) — replaces the
      // native <select> for theme parity. Hidden input keeps the value so
      // existing selectProject() handler still works via getElementById.
      var selectHtml;
      if (projects.length === 0) {
        selectHtml = '<div style="color:var(--text-3);font-size:0.85rem;padding:12px 0">' + t('empty.noProjectShort', 'ยังไม่มี Project') + '</div>';
      } else {
        var savedProj = projects.find(function (x) { return String(x.id) === String(saved); });
        var label = savedProj ? ('📂 ' + savedProj.name) : t('dd.selectProject', '— เลือก Project —');
        selectHtml =
            '<input type="hidden" id="project-selector" value="' + escapeHtml(String(saved || '')) + '" />'
          + '<button type="button" class="dd-trigger" id="overview-project-trigger" '
          +   'style="min-width:260px;font-weight:600" '
          +   'onclick="admin.openOverviewProjectDropdown(event)">'
          +   '<span class="dd-trigger-label" id="overview-project-label">' + escapeHtml(label) + '</span>'
          +   '<svg class="dd-trigger-chevron" width="14" height="14" viewBox="0 0 24 24" '
          +     'fill="none" stroke="currentColor" stroke-width="2.5">'
          +     '<polyline points="6 9 12 15 18 9"/>'
          +   '</svg>'
          + '</button>';
      }

      document.getElementById('overview-user-list').innerHTML =
        '<div style="margin-bottom:18px">' + selectHtml + '</div>'
        + '<div id="proj-detail"></div>';

      // Phase 19.5: .budget-bar / .budget-bar-fill styles moved to
      // css/components.css — no more runtime <style> injection here.

      if (saved) {
        self.renderProjectDetail(saved);
        // Phase 21.5: transaction journal is project-scoped — render
        // alongside the project detail so both stay in sync.
        self.renderTransactions(saved);
      } else {
        self.renderTransactions(null);
      }
      // Phase 21.10: quota requests are global (not per-project) — always render.
      self.renderQuotaRequests();
    });
  },

  selectProject: function (projectId) {
    this._selectedProject = projectId;
    var sel = document.getElementById('project-selector');
    if (sel) sel.value = projectId;
    this.renderProjectDetail(projectId);
    this.renderTransactions(projectId);
  },

  // ── Phase 21.5: Transaction by Date ──────────────────────
  // Two modes:
  //   day   → 1 row per event (created_at desc, default last 7 days)
  //   month → aggregated SUM per (month, user, type) (default last ~2 months)
  // State lives on the instance so toggling Day/Month or re-picking a
  // project remembers what the admin had set.
  _txMode: 'day',
  _txFrom: null,
  _txTo:   null,

  // Compute friendly default date range for a mode.
  _txDefaultRange: function (mode) {
    var today = new Date();
    var bkk = new Date(today.getTime() + 7 * 60 * 60 * 1000);
    var iso = function (d) { return d.toISOString().slice(0, 10); };
    var to = iso(bkk);
    var from;
    if (mode === 'month') {
      // ~ last 60 days so 2-3 months show up
      from = iso(new Date(bkk.getTime() - 60 * 86400000));
    } else {
      from = iso(new Date(bkk.getTime() - 6 * 86400000));     // last 7 days
    }
    return { from: from, to: to };
  },

  setTxMode: function (mode) {
    if (mode !== 'day' && mode !== 'month') return;
    this._txMode = mode;
    // Update toggle button visual state
    var btns = document.querySelectorAll('#tx-card .tx-toggle-btn');
    btns.forEach(function (b) {
      var on = (b.getAttribute('data-mode') === mode);
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // Reset date range to the mode's natural default — admin can still
    // override via the date pickers afterwards.
    var r = this._txDefaultRange(mode);
    this._txFrom = r.from;
    this._txTo   = r.to;
    var inFrom = document.getElementById('tx-from');
    var inTo   = document.getElementById('tx-to');
    if (inFrom) inFrom.value = r.from;
    if (inTo)   inTo.value   = r.to;
    this.renderTransactions(this._selectedProject);
  },

  // Phase 21.7 — Export the current Transaction view (matches the on-screen
  // filters: groupBy, date range, selected project). Triggers a browser
  // download via fetch → blob → anchor.click.
  toggleTxExport: function (evt) {
    if (evt) evt.stopPropagation();
    var menu = document.getElementById('tx-export-menu');
    var btn  = document.querySelector('#tx-export .tx-export-btn');
    if (!menu) return;
    var open = menu.classList.toggle('open');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Close on outside click — one-shot listener.
    if (open && !this._txExportWired) {
      this._txExportWired = true;
      var self = this;
      document.addEventListener('click', function close(e) {
        if (!e.target.closest('#tx-export')) {
          menu.classList.remove('open');
          if (btn) btn.setAttribute('aria-expanded', 'false');
          self._txExportWired = false;
          document.removeEventListener('click', close);
        }
      });
    }
  },

  exportTransactions: function (format) {
    var menu = document.getElementById('tx-export-menu');
    if (menu) menu.classList.remove('open');

    var qs = '?format='  + encodeURIComponent(format)
           + '&groupBy=' + encodeURIComponent(this._txMode || 'day')
           + '&from='    + encodeURIComponent(this._txFrom || '')
           + '&to='      + encodeURIComponent(this._txTo   || '');
    if (this._selectedProject) {
      qs += '&projectId=' + encodeURIComponent(this._selectedProject);
    }

    var url = BASE + '/api/transactions/export' + qs;
    // Use fetch (not <a href>) so we send the Bearer header.
    fetch(url, { headers: Auth.authHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // Filename from Content-Disposition if present, else build it.
        var cd = r.headers.get('Content-Disposition') || '';
        var m  = /filename="([^"]+)"/.exec(cd);
        var fname = m ? m[1] : ('transactions.' + format);
        return r.blob().then(function (blob) { return { blob: blob, fname: fname }; });
      })
      .then(function (res) {
        var blobUrl = URL.createObjectURL(res.blob);
        var a = document.createElement('a');
        a.href = blobUrl;
        a.download = res.fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 1000);
      })
      .catch(function (e) {
        alert(t('err.exportFailedPrefix', 'Export ไม่สำเร็จ: ') + e.message);
      });
  },

  renderTransactions: function (projectId) {
    var self = this;
    var wrap = document.getElementById('tx-table-wrap');
    if (!wrap) return;

    // Wire date inputs (idempotent — onchange survives re-render of wrap).
    var inFrom = document.getElementById('tx-from');
    var inTo   = document.getElementById('tx-to');
    if (inFrom && !inFrom._wired) {
      inFrom._wired = true;
      inFrom.addEventListener('change', function () {
        self._txFrom = inFrom.value;
        self.renderTransactions(self._selectedProject);
      });
    }
    if (inTo && !inTo._wired) {
      inTo._wired = true;
      inTo.addEventListener('change', function () {
        self._txTo = inTo.value;
        self.renderTransactions(self._selectedProject);
      });
    }

    // Default the range on first render
    if (!this._txFrom || !this._txTo) {
      var r = this._txDefaultRange(this._txMode);
      this._txFrom = this._txFrom || r.from;
      this._txTo   = this._txTo   || r.to;
      if (inFrom) inFrom.value = this._txFrom;
      if (inTo)   inTo.value   = this._txTo;
    }

    wrap.innerHTML = '<div class="tx-loading">⏳ กำลังโหลด…</div>';

    var qs = '?from=' + encodeURIComponent(this._txFrom)
           + '&to='   + encodeURIComponent(this._txTo)
           + '&groupBy=' + this._txMode;
    if (projectId) qs += '&projectId=' + encodeURIComponent(projectId);

    this._txPage = 1;   // reset to page 1 on every fresh load (date/mode/project change)

    fetch(BASE + '/api/transactions' + qs, { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          wrap.innerHTML = '<div class="tx-empty">⚠ ' +
                           escapeHtml(d.error || 'Failed to load') + '</div>';
          return;
        }
        if (d.rows.length === 0) {
          wrap.innerHTML = '<div class="tx-empty">📭 ไม่มี transaction ในช่วงนี้</div>';
          return;
        }
        self._txLastData = d;
        wrap.innerHTML = self._renderTxTable(d);
      })
      .catch(function (e) {
        wrap.innerHTML = '<div class="tx-empty">⚠ ' + escapeHtml(e.message) + '</div>';
      });
  },

  // Phase 26: Day-mode pagination — 20 rows/page (Month mode is already a
  // small rollup, so it's never paginated). Re-renders from the cached
  // last-fetched payload — no refetch needed when just turning pages.
  _txPage: 1,
  setTxPage: function (page) {
    if (!this._txLastData) return;
    this._txPage = page;
    var wrap = document.getElementById('tx-table-wrap');
    if (wrap) wrap.innerHTML = this._renderTxTable(this._txLastData);
  },

  // Build the table HTML for either day mode or month mode.
  _renderTxTable: function (d) {
    var isMonth = d.groupBy === 'month';
    var sub = document.getElementById('tx-subtitle');
    if (sub) {
      var TTx = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
      sub.textContent = isMonth
        ? TTx('tx.subMonth', 'สรุปรายเดือนต่อ user')
        : TTx('tx.subDay', 'ประวัติการเติม credit และการใช้งาน');
    }

    var PAGE_SIZE = 20;
    var totalRows = d.rows.length;
    var totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    var page = isMonth ? 1 : Math.min(Math.max(this._txPage || 1, 1), totalPages);
    this._txPage = page;
    var pageRows = isMonth ? d.rows : d.rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    var rows = pageRows.map(function (r) {
      var typeClass = String(r.type || '').toLowerCase();
      var sign = (r.type === 'usage' || r.type === 'adjustment' && (r.amount_signed || 0) < 0) ? 'out' : 'in';
      var amountStr = '฿' + Number(r.amount || 0).toFixed(2);
      var typeBadge = '<span class="tx-type-badge ' + escapeHtml(typeClass) + '">'
                    + escapeHtml(r.type) + '</span>';

      if (isMonth) {
        return '<tr>'
          + '<td class="tx-cell-mono">' + escapeHtml(r.period_label) + '</td>'
          + '<td><div style="font-weight:600">' + escapeHtml(r.display_name || r.username || '—') + '</div>'
          +   '<div style="font-size:.7rem;color:var(--text-3)">@' + escapeHtml(r.username || '') + '</div></td>'
          + '<td>' + typeBadge + '</td>'
          + '<td class="tx-cell-mono" style="text-align:center">' + r.event_count + '</td>'
          + '<td class="tx-cell-amount ' + sign + '">' + amountStr + '</td>'
          + '</tr>';
      } else {
        var dt = new Date(r.created_at);
        var dateStr = dt.toLocaleDateString('th-TH', {
          day:'2-digit', month:'2-digit', year:'2-digit'
        }) + ' ' + dt.toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'});
        var refStr = r.ref_type
          ? '<span class="tx-cell-mono">' + escapeHtml(r.ref_type) +
            (r.ref_id ? '#' + r.ref_id : '') + '</span>'
          : '<span style="color:var(--text-3)">—</span>';
        return '<tr>'
          + '<td class="tx-cell-mono">' + escapeHtml(dateStr) + '</td>'
          + '<td><div style="font-weight:600">' + escapeHtml(r.display_name || r.username || '—') + '</div>'
          +   '<div style="font-size:.7rem;color:var(--text-3)">@' + escapeHtml(r.username || '') + '</div></td>'
          + '<td>' + typeBadge + '</td>'
          + '<td>' + refStr + '</td>'
          + '<td class="tx-cell-amount ' + sign + '">'
          +   (sign === 'in' ? '+' : '−') + amountStr
          + '</td>'
          + '</tr>';
      }
    }).join('');

    var headers = isMonth
      ? ['Month', 'User', 'Type', 'Request', 'Amount']
      : ['Date',  'User', 'Type', 'Request', 'Amount'];
    var ths = headers.map(function (h, i) {
      var align = (i === headers.length - 1) ? ' style="text-align:right"'
                : (i === 3 && isMonth)        ? ' style="text-align:center"' : '';
      return '<th' + align + '>' + h + '</th>';
    }).join('');

    var paginationHtml = '';
    if (!isMonth && totalPages > 1) {
      var btns = [];
      for (var i = 1; i <= totalPages; i++) {
        btns.push('<button class="tx-page-btn' + (i === page ? ' active' : '')
          + '" onclick="admin.setTxPage(' + i + ')">' + i + '</button>');
      }
      paginationHtml = '<div class="tx-pagination">' + btns.join('') + '</div>';
    }

    return '<table class="tx-table">'
      + '<thead><tr>' + ths + '</tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>'
      + '<div class="tx-footer">'
      +   '<span>' + d.count + ' rows · ' + escapeHtml(d.from) + ' → ' + escapeHtml(d.to) + '</span>'
      +   '<span>' + (isMonth ? 'Monthly rollup' : 'Per-event detail') + '</span>'
      + '</div>'
      + paginationHtml;
  },

  // Phase 16.19: redesigned project detail view.
  //   1) Prominent hero with name, project_id pill, rate badges, primary CTA
  //   2) Combined budget overview (big number + 2 progress bars in one card)
  //   3) 3 mini stats (Distributed / Pool / Cost) — no more 4-tile sameness
  //   4) Member rows with avatar + condensed action button (single edit pencil)
  renderProjectDetail: function (projectId) {
    var self = this;
    // Phase 20.2: pull project from the DB cache (Auth.getProjectById reads
    // legacy localStorage which doesn't have `balance` / `lifetimeAmount`).
    var p = (this._cachedDBProjects || []).find(function (x) { return x.id === projectId; })
            || Auth.getProjectById(projectId);
    if (!p) return;
    var container = document.getElementById('proj-detail');
    if (!container) return;
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };

    // Phase 21.11 (Concept B): members come from /api/credits (real DB data),
    // not localStorage wallets. Each carries lifetime tokens/spend + today's
    // cap usage. Money lives in the project pool, so there's no "distributed
    // to users" concept anymore.
    var nz = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
    var users = (this._cachedCredits || []).filter(function (c) { return c.projectId === projectId; });

    //   totalTopUp  ← lifetime accumulated (tbl_balance.project_credits_amount)
    //   pool        ← current project pool (tbl_balance.project_credits)
    //   costBilled  ← Σ member lifetime spend
    var totalTopUp = nz(p.lifetimeAmount != null ? p.lifetimeAmount : p.totalTopUp);
    var pool       = nz(p.balance != null ? p.balance : p.totalTopUp);
    var costBilled = users.reduce(function (s, u) { return s + nz(u.lifetimeSpend); }, 0);

    var usedPct = totalTopUp > 0 ? Math.min(100, (costBilled / totalTopUp) * 100) : 0;
    var poolPct = totalTopUp > 0 ? Math.min(100, (pool / totalTopUp) * 100) : 0;
    var poolColor = pool > 0 ? 'var(--success-hover, #34d399)' : 'var(--danger-hover, #f87171)';
    var budget = { totalTopUp: totalTopUp, pool: pool, costBilled: costBilled };

    // —— Hero header ——————————————————————————————————————
    // Project name, ID pill (monospace, click-to-copy), rate chips, CTA.
    var hero =
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:14px;'
      + 'padding:20px 22px;background:var(--surface-2);border:1px solid var(--border-default);'
      + 'border-radius:14px 14px 0 0;border-bottom:none">'
      +   '<div style="flex:1;min-width:240px">'
      +     '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">'
      +       '<div style="font-size:1.2rem;font-weight:800;color:var(--text-1)">📂 ' + escapeHtml(p.name) + '</div>'
      +       '<span title="คลิกเพื่อ copy" onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + escapeHtml(p.id) + '\').then(()=>flash(\'✓ Copied: ' + escapeHtml(p.id) + '\'))" '
      +         'style="font-family:Geist Mono,monospace;font-size:.72rem;padding:3px 9px;'
      +         'background:var(--accent-soft-bg);color:var(--accent);'
      +         'border:1px solid var(--accent-soft-border);border-radius:6px;cursor:pointer;'
      +         'transition:background .15s">' + escapeHtml(p.id) + '</span>'
      +     '</div>'
      +     '<div style="font-size:.84rem;color:var(--text-3);line-height:1.5">'
      +       (p.desc ? escapeHtml(p.desc) : '<span style="font-style:italic;opacity:.6">No description</span>')
      +     '</div>'
      +     '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">'
      +       '<span style="font-size:.72rem;padding:4px 10px;background:var(--surface-3);'
      +         'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)">'
      +         '📥 In  <b>฿' + p.inputRate + '</b>/1K</span>'
      +       '<span style="font-size:.72rem;padding:4px 10px;background:var(--surface-3);'
      +         'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)">'
      +         '📤 Out  <b>฿' + p.outputRate + '</b>/1K</span>'
      +     '</div>'
      +   '</div>'
      +   '<button class="btn-action btn-primary-sm" style="padding:10px 22px;font-size:.88rem;font-weight:700"'
      +     ' onclick="admin.openTopup(\'' + p.id + '\')">' + TT('btn.topupProject','+ เติมเงิน Project') + '</button>'
      + '</div>';

    // —— Budget overview card (single line, state-aware) ————————————
    //   available = pool-left + spent-so-far  (all money the pool ever held)
    //   3 states:  not-funded (no money ever) · depleted (spent it all) · normal
    var availTotal = budget.pool + budget.costBilled;
    var isFunded   = availTotal > 0;
    var isEmpty    = budget.pool <= 0;
    var usablePct  = isFunded ? (budget.pool / availTotal) * 100 : 0;

    var leftHtml, barPct, barColor, footHtml, poolNumColor;
    if (!isFunded) {
      // never funded — neutral "empty" state, no misleading %
      leftHtml = '<span style="font-size:1.25rem;font-weight:700;color:var(--text-3)">💤 '
               + TT('proj.noCredit','ยังไม่มีเครดิต') + '</span>';
      barPct = 0; barColor = 'var(--text-3)'; poolNumColor = 'var(--text-3)';
      footHtml = '💡 ' + TT('proj.topupHint','กด "+ เติมเงิน Project" เพื่อเริ่มใช้งาน');
    } else if (isEmpty) {
      // funded before but spent everything — clear "depleted" warning
      leftHtml = '<span style="font-size:1.7rem;font-weight:800;color:#dc2626;font-family:Geist Mono,monospace">0%</span>'
               + '<span style="font-size:.78rem;color:#dc2626;font-weight:600;margin-left:8px">⚠ '
               + TT('proj.depleted','เครดิตหมด') + '</span>';
      barPct = 0; barColor = '#dc2626'; poolNumColor = '#dc2626';
      footHtml = TT('proj.depletedHint','เติมเงินเพื่อให้ user ใช้งานต่อได้');
    } else {
      // normal — colour by how much is left
      var col = usablePct >= 50 ? 'var(--success-hover,#34d399)'
              : usablePct >= 20 ? '#f59e0b' : '#dc2626';
      leftHtml = '<span style="font-size:1.7rem;font-weight:800;color:' + col + ';font-family:Geist Mono,monospace;letter-spacing:-.02em">'
               + usablePct.toFixed(1) + '%</span>'
               + '<span style="font-size:.76rem;color:var(--text-3);margin-left:8px">' + TT('proj.usableLeft','คงเหลือใช้ได้') + '</span>';
      barPct = usablePct; barColor = col; poolNumColor = 'var(--text-1)';
      footHtml = TT('proj.usedOfPool','ใช้ไป') + ' ' + formatTHB(budget.costBilled) + ' · ' + usedPct.toFixed(1) + '%';
    }

    var budgetCard =
        '<div style="padding:22px;background:var(--surface-2);border:1px solid var(--border-default);'
      + 'border-radius:0;border-bottom:none;border-top:1px dashed var(--border-subtle)">'
      +   '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:10px;gap:12px;flex-wrap:wrap">'
      +     '<div>' + leftHtml + '</div>'
      +     '<div style="text-align:right">'
      +       '<span style="font-size:1.4rem;font-weight:800;color:' + poolNumColor + ';font-family:Geist Mono,monospace">'
      +         formatTHB(budget.pool) + '</span>'
      +       '<span style="font-size:.7rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-left:6px">' + TT('proj.poolLeft','Pool left') + '</span>'
      +     '</div>'
      +   '</div>'
      // progress bar — empty/dashed when not funded, else filled to barPct
      +   '<div style="height:10px;border-radius:5px;background:var(--surface-4);overflow:hidden'
      +     (!isFunded ? ';border:1px dashed var(--border-default);background:transparent' : '') + '">'
      +     (barPct > 0 ? '<div style="width:' + barPct + '%;height:100%;background:' + barColor + ';transition:width .4s ease"></div>' : '')
      +   '</div>'
      +   '<div style="font-size:.7rem;color:var(--text-3);margin-top:6px">' + footHtml + '</div>'
      + '</div>';

    // —— 3 secondary stat cards ——————————————————————————
    // Top-up is in the hero already; show derived figures here.
    var statCard = function (icon, label, value, valueColor, sub) {
      return '<div style="padding:14px 16px;background:var(--surface-2);'
        + 'border:1px solid var(--border-default);border-radius:10px">'
        + '<div style="font-size:.7rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">' + icon + ' ' + label + '</div>'
        + '<div style="font-size:1.3rem;font-weight:700;color:' + valueColor + ';font-family:Geist Mono,monospace">' + value + '</div>'
        + (sub ? '<div style="font-size:.7rem;color:var(--text-3);margin-top:4px">' + sub + '</div>' : '')
        + '</div>';
    };
    var statsRow =
        '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;padding:14px;'
      + 'background:var(--surface-2);border:1px solid var(--border-default);'
      + 'border-radius:0 0 14px 14px;border-top:1px dashed var(--border-subtle)">'
      +   statCard('💰', TT('proj.lifetimeTopup','Lifetime Top-up'), formatTHB(budget.totalTopUp), 'var(--text-1)',
                   TT('proj.topupSub','ยอดเติมสะสม'))
      +   statCard('💸', TT('proj.spendCumulative','ใช้จ่ายสะสม'), formatTHB(budget.costBilled), 'var(--text-2)',
                   budget.totalTopUp > 0 ? usedPct.toFixed(1) + '% ' + TT('proj.ofTopup','ของยอดเติม') : '—')
      + '</div>';

    // —— Members section ——————————————————————————————————
    var membersTitle =
        '<div style="display:flex;align-items:center;gap:10px;margin:24px 0 12px">'
      +   '<h3 style="font-size:.9rem;color:var(--text-1);font-weight:700;margin:0">' + TT('dash.members','Members') + '</h3>'
      +   '<span style="font-size:.7rem;padding:2px 8px;background:var(--surface-3);'
      +     'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)">'
      +     users.length + '</span>'
      + '</div>';

    var membersBody;
    if (users.length === 0) {
      membersBody = '<div style="padding:32px;text-align:center;color:var(--text-3);font-size:.82rem;'
        + 'background:var(--surface-2);border:1px dashed var(--border-default);border-radius:10px">'
        + '👥 ' + t('empty.noMembersInProject', 'ยังไม่มี member ใน project นี้') + '</div>';
    } else {
      // Phase 21.11 (Concept B): read-only member rows from DB credits data.
      // Columns: Tokens (lifetime) · Spend (lifetime) · Daily Cap · Used today.
      // No edit button — user edits live on the User Management / Cap pages.
      var col = function (label, valueHtml, w) {
        return '<div style="text-align:right;min-width:' + (w || 84) + 'px">'
          + '<div style="font-size:.64rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em">' + label + '</div>'
          + '<div style="margin-top:2px">' + valueHtml + '</div>'
          + '</div>';
      };
      var mono = function (s, color) {
        return '<span style="font-weight:600;color:' + (color || 'var(--text-1)') + ';font-family:Geist Mono,monospace;font-size:.85rem">' + s + '</span>';
      };
      var rows = users.map(function (u, idx) {
        var initial = (u.displayName || u.username || '?').charAt(0).toUpperCase();
        var tokens  = nz(u.lifetimeTokens);
        var spend   = nz(u.lifetimeSpend);
        var hasCap  = !(u.dailyCap === null || u.dailyCap === undefined);
        var base    = hasCap ? nz(u.dailyCap) : null;
        var bonus   = nz(u.bonusBalance);
        var effCap  = hasCap ? base + bonus : null;
        var usedTd  = nz(u.spentToday);

        var capHtml = hasCap
          ? mono('฿' + base.toLocaleString('en-US', { maximumFractionDigits: 0 }))
            + (bonus > 0 ? '<span style="color:#16a34a;font-size:.66rem" title="bonus คงเหลือ"> +' + bonus.toLocaleString('en-US', { maximumFractionDigits: 0 }) + '</span>' : '')
          : '<span style="opacity:.45;font-style:italic;font-size:.8rem">' + TT('val.unlimited','ไม่จำกัด') + '</span>';

        var usedHtml;
        if (!hasCap) {
          usedHtml = mono('฿' + usedTd.toFixed(2), 'var(--text-2)');
        } else {
          var ratio = effCap > 0 ? Math.min(1, usedTd / effCap) : (usedTd > 0 ? 1 : 0);
          var pct = Math.round(ratio * 100);
          var c = ratio >= 1 ? '#dc2626' : ratio >= 0.8 ? '#f59e0b' : '#16a34a';
          usedHtml =
              '<div style="min-width:104px">'
            +   mono('฿' + usedTd.toFixed(0), c) + '<span style="color:var(--text-3);font-size:.72rem"> / ฿' + effCap.toFixed(0) + '</span>'
            +   '<div style="height:4px;border-radius:2px;background:var(--surface-4);overflow:hidden;margin-top:3px">'
            +     '<div style="height:100%;width:' + pct + '%;background:' + c + ';transition:width .3s"></div>'
            +   '</div>'
            + '</div>';
        }

        return '<div style="display:grid;grid-template-columns:auto 1fr auto auto auto auto;'
          + 'gap:14px;align-items:center;padding:12px 16px;'
          + (idx > 0 ? 'border-top:1px solid var(--border-subtle);' : '')
          + 'transition:background .15s">'
          // Avatar circle
          + '<div style="width:36px;height:36px;border-radius:50%;background:var(--accent-soft-bg);'
          +   'color:var(--accent);font-weight:700;font-size:.95rem;'
          +   'display:flex;align-items:center;justify-content:center;'
          +   'border:1px solid var(--accent-soft-border)">' + escapeHtml(initial) + '</div>'
          // Name + username
          + '<div style="min-width:0">'
          +   '<div style="font-weight:600;color:var(--text-1);font-size:.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(u.displayName || u.username) + '</div>'
          +   '<div style="font-size:.7rem;color:var(--text-3);margin-top:1px">@' + escapeHtml(u.username) + '</div>'
          + '</div>'
          + col(TT('col.tokens','Tokens'), mono(tokens.toLocaleString(), 'var(--text-1)'))
          + col(TT('col.spendCumulative','ใช้จ่ายสะสม'), mono('฿' + spend.toFixed(2), 'var(--text-2)'))
          + col(TT('col.dailyCap','Daily Cap'), capHtml)
          + col(TT('col.usedToday','ใช้วันนี้'), usedHtml, 110)
          + '</div>';
      }).join('');
      membersBody = '<div style="background:var(--surface-2);border:1px solid var(--border-default);'
        + 'border-radius:10px;overflow:hidden">' + rows + '</div>';
    }

    container.innerHTML = hero + budgetCard + statsRow + membersTitle + membersBody;
  },

  openTopup: function (projectId) {
    // Phase 16.14: project picker is now a custom dropdown (hidden input + button).
    // Pre-select either the projectId passed in (per-row "+") or the first project.
    var projects = this._projectsList();
    var pid = projectId || (projects[0] && projects[0].id) || '';
    document.getElementById('tu-proj-id').value = pid;
    var p = projects.find(function (x) { return String(x.id) === String(pid); });
    document.getElementById('tu-proj-label').textContent = p ? ('📂 ' + p.name) : t('dd.selectProject', '— Select Project —');

    document.getElementById('tu-amount').value = '';
    var noteEl = document.getElementById('tu-note'); if (noteEl) noteEl.value = '';
    document.getElementById('tu-error').textContent = '';
    showModal('modal-topup');
  },

  openTopupProjectDropdown: function (ev) {
    if (ev) ev.stopPropagation();
    var projects = (this._cachedDBProjects || []).slice()
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    this.openDropdown('tu-proj-trigger', {
      items: projects.map(function (p) { return { value: p.id, label: p.name, emoji: '📂' }; }),
      selected: document.getElementById('tu-proj-id').value || '',
      searchable: true,
      placeholder: t('dd.searchProject', '🔎 ค้นหา project...'),
      onPick: function (value, item) {
        document.getElementById('tu-proj-id').value = value || '';
        document.getElementById('tu-proj-label').textContent =
          item ? ('📂 ' + item.label) : t('dd.selectProject', '— Select Project —');
      },
    });
  },

  submitTopup: function () {
    var projectId = document.getElementById('tu-proj-id').value;
    var amount = parseFloat(document.getElementById('tu-amount').value);
    var noteEl = document.getElementById('tu-note');
    var note   = noteEl ? noteEl.value.trim() : '';
    var errEl  = document.getElementById('tu-error');
    if (isNaN(amount) || amount <= 0) { errEl.textContent = '❌ ' + t('err.invalidAmount', 'กรุณาใส่จำนวนเงินที่ถูกต้อง'); return; }
    var self = this;
    // Phase 16.1 / 21.2: send optional note (server stores it in tbl_topup_project.note)
    var body = { amount: amount };
    if (note) body.note = note;
    fetch(BASE + '/api/projects/' + encodeURIComponent(projectId) + '/topup', {
      method: 'PUT',
      headers: Auth.authHeaders(),
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = '❌ ' + t('err.dbRejected', 'DB ปฏิเสธ: ') + (d.error || 'unknown'); return; }
        // Mirror to localStorage for legacy code paths
        Auth.topupProject(projectId, amount);
        hideModal('modal-topup');
        flash('✅ ' + tf('msg.topupSuccess', { amt: formatTHB(amount), total: formatTHB(parseFloat(d.newBalance)) }, 'เติมเงิน {amt} เข้า project แล้ว (DB total {total})'));
        // Refresh from DB across all relevant views
        self.fetchProjectsFromDB().then(function () {
          // Always refresh whichever view we're on. Cheap; no state lost.
          if (self.currentView === 'projects')      self.renderProjectDetail(projectId);
          else if (self.currentView === 'overview') self.renderOverview();
          else if (self.currentView === 'balance')  self.renderBalance();
          else                                      self.renderOverview();
        });
      })
      .catch(function (e) { errEl.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; });
  },

  // ── BALANCE & TOP-UP (Phase 16.1) ──────────────────────
  // Two-phase render so the page is never blank:
  // ── SYNC STATUS (Phase 17.4) ───────────────────────────
  // Pulls /api/sync-status and renders:
  //   1) Health header — last run, next run ETA, status pill, total rows
  //   2) Per-project table — synced_at + 7-day tokens + cached %
  renderSync: function () {
    var self = this;
    var healthEl = document.getElementById('sync-health');
    var projEl   = document.getElementById('sync-projects');
    if (healthEl) healthEl.innerHTML =
      '<div style="padding:24px;text-align:center;color:var(--text-3)">' + t('common.loading', '⏳ กำลังโหลด...') + '</div>';
    if (projEl)   projEl.innerHTML = '';

    fetch(BASE + '/api/sync-status', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          healthEl.innerHTML = '<div style="padding:24px;color:#e25563">' +
            '⚠ ' + escapeHtml(d.error || 'failed to load') + '</div>';
          return;
        }
        self._renderSyncHealth(d);
        self._renderSyncProjects(d.projects || []);
      })
      .catch(function (e) {
        healthEl.innerHTML = '<div style="padding:24px;color:#e25563">⚠ ' + escapeHtml(e.message) + '</div>';
      });
  },

  _renderSyncHealth: function (d) {
    var el = document.getElementById('sync-health');
    if (!el) return;
    var s = d.state || {};
    var statusKey = d.running ? 'running' : (s.last_status || 'idle');
    // Status pill colour
    var colors = {
      running:  { bg: 'rgba(74,123,214,0.10)',  bd: 'rgba(74,123,214,0.35)',  fg: '#5a8def', label: '🔄 Running' },
      ok:       { bg: 'rgba(55,179,74,0.10)',    bd: 'rgba(55,179,74,0.35)',   fg: '#3fa64d', label: '🟢 OK' },
      partial:  { bg: 'rgba(240,160,64,0.10)',   bd: 'rgba(240,160,64,0.35)',  fg: '#e6a14a', label: '🟡 Partial' },
      error:    { bg: 'rgba(220,53,69,0.10)',    bd: 'rgba(220,53,69,0.35)',   fg: '#e25563', label: '🔴 Error' },
      idle:     { bg: 'var(--surface-3)',        bd: 'var(--border-default)', fg: 'var(--text-3)', label: '⚪ Not run yet' },
    };
    var c = colors[statusKey] || colors.idle;

    var lastRun = s.last_run_at ? formatDateStd(s.last_run_at) : '—';
    var nextEta = '—';
    if (s.last_run_at && d.intervalMin) {
      var next = new Date(new Date(s.last_run_at).getTime() + d.intervalMin * 60_000);
      var diffMin = Math.max(0, Math.floor((next - Date.now()) / 60_000));
      nextEta = diffMin <= 0 ? 'overdue' : '~' + diffMin + ' min';
    }

    var blocks = [
      { label: 'Status',            value:
        '<span style="display:inline-block;padding:4px 12px;border-radius:20px;'
        + 'background:' + c.bg + ';color:' + c.fg + ';border:1px solid ' + c.bd + ';'
        + 'font-size:.82rem;font-weight:600">' + c.label + '</span>' },
      { label: 'Last Run',          value: '<span style="font-family:Geist Mono,monospace;color:var(--text-1)">' + lastRun + '</span>' },
      { label: 'Next Run',          value: '<span style="font-family:Geist Mono,monospace;color:var(--text-2)">' + nextEta + '</span>' },
      { label: 'Interval',          value: '<span style="color:var(--text-2)">' + (d.intervalMin || '?') + ' min</span>' },
      { label: 'Last Duration',     value: '<span style="font-family:Geist Mono,monospace;color:var(--text-2)">' + (s.last_duration_ms != null ? s.last_duration_ms + ' ms' : '—') + '</span>' },
      { label: 'Rows This Run',     value: '<span style="font-family:Geist Mono,monospace;color:var(--text-2)">' + (s.last_rows_inserted || 0) + '</span>' },
      { label: 'Rows Total',        value: '<span style="font-family:Geist Mono,monospace;color:var(--text-2)">' + (s.rows_synced_total || 0).toLocaleString() + '</span>' },
      { label: 'Admin Key',         value: d.adminKeyConfigured ? '<span style="color:#3fa64d">✓ configured</span>' : '<span style="color:#e25563">✗ missing</span>' },
    ];

    el.innerHTML =
        '<h3 class="card-title" style="margin-bottom:14px">Sync Health</h3>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px">'
      +   blocks.map(function (b) {
            return '<div style="padding:10px 14px;background:var(--surface-3);'
              + 'border:1px solid var(--border-subtle);border-radius:8px">'
              + '<div style="font-size:.66rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">' + b.label + '</div>'
              + '<div style="font-size:.92rem;font-weight:600">' + b.value + '</div>'
              + '</div>';
          }).join('')
      + '</div>'
      + (s.last_error
          ? '<div style="margin-top:14px;padding:12px 14px;background:rgba(220,53,69,0.06);border:1px solid rgba(220,53,69,0.30);border-radius:8px;color:#e25563;font-size:.82rem;font-family:Geist Mono,monospace">'
            + '<b>Error:</b> ' + escapeHtml(s.last_error) + '</div>'
          : '');
  },

  _renderSyncProjects: function (rows) {
    var el = document.getElementById('sync-projects');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-3);font-size:.85rem">' + t('empty.noProjectsSystem', 'ยังไม่มี project ในระบบ') + '</div>';
      return;
    }
    var headerStrip =
        '<div style="display:grid;grid-template-columns:1.5fr 1.3fr 1.2fr 1fr;'
      + 'gap:14px;padding:10px 16px;font-size:.66rem;color:var(--text-3);'
      + 'text-transform:uppercase;letter-spacing:.05em;font-weight:700;'
      + 'border-bottom:1px solid var(--border-subtle)">'
      +   '<div>Project</div>'
      +   '<div>Last Synced</div>'
      +   '<div style="text-align:right">Tokens (7d)</div>'
      +   '<div style="text-align:right">Cached %</div>'
      + '</div>';

    var body = rows.map(function (r, idx) {
      var tokens = Number(r.tokens_7d || 0);
      var cached = Number(r.cached_7d || 0);
      var cachedPct = tokens > 0 ? ((cached / tokens) * 100).toFixed(1) + '%' : '—';
      var synced = r.openai_synced_at
        ? formatDateStd(r.openai_synced_at)
        : '<span style="color:var(--text-3);font-style:italic">never</span>';
      var pidPill = r.openai_project_id
        ? '<span style="font-family:Geist Mono,monospace;font-size:.7rem;padding:2px 7px;'
          + 'background:var(--accent-soft-bg);color:var(--accent);'
          + 'border:1px solid var(--accent-soft-border);border-radius:5px;margin-left:8px">'
          + escapeHtml(r.openai_project_id.slice(0, 16) + '…') + '</span>'
        : '';
      return '<div style="display:grid;grid-template-columns:1.5fr 1.3fr 1.2fr 1fr;'
        + 'gap:14px;align-items:center;padding:12px 16px;'
        + (idx > 0 ? 'border-top:1px solid var(--border-subtle);' : '') + '">'
        + '<div>'
        +   '<div style="font-weight:600;color:var(--text-1);font-size:.88rem">'
        +     '📂 ' + escapeHtml(r.project_name || '—') + pidPill + '</div>'
        + '</div>'
        + '<div style="font-size:.82rem;color:var(--text-2);font-family:Geist Mono,monospace">' + synced + '</div>'
        + '<div style="text-align:right;font-family:Geist Mono,monospace;color:var(--text-1);font-weight:600">' + tokens.toLocaleString() + '</div>'
        + '<div style="text-align:right;font-family:Geist Mono,monospace;color:' + (cached > 0 ? '#3fa64d' : 'var(--text-3)') + ';font-weight:600">' + cachedPct + '</div>'
        + '</div>';
    }).join('');

    el.innerHTML = '<div style="background:var(--surface-2);border:1px solid var(--border-default);'
      + 'border-radius:10px;overflow:hidden">' + headerStrip + body + '</div>';
  },

  // Phase 19.3: in-app modal replaces window.confirm() — keeps look & feel
  // consistent across destructive/long-running operations.
  syncNow: function () {
    var err = document.getElementById('sn-error');
    if (err) err.textContent = '';
    var btn = document.getElementById('sn-confirm-btn');
    if (btn) { btn.disabled = false; btn.textContent = t('m.syncNow.btn', 'เริ่ม sync'); }
    showModal('modal-confirm-sync-now');
  },
  cancelSyncNow: function () { hideModal('modal-confirm-sync-now'); },
  confirmSyncNow: function () {
    var self = this;
    var err = document.getElementById('sn-error');
    var btn = document.getElementById('sn-confirm-btn');
    if (btn) { btn.disabled = true; btn.textContent = t('btn.syncingEllipsis', 'กำลัง sync...'); }
    if (err) err.textContent = '';
    var healthEl = document.getElementById('sync-health');
    if (healthEl) healthEl.innerHTML =
      '<div style="padding:24px;text-align:center;color:var(--text-3)">⚡ ' + t('btn.syncingEllipsis', 'กำลัง sync...') + '</div>';
    fetch(BASE + '/api/sync-now', {
      method: 'POST', headers: Auth.authHeaders(),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        hideModal('modal-confirm-sync-now');
        if (!d.ok) { flash('❌ ' + t('msg.syncFailedPrefix', 'Sync failed: ') + (d.error || 'unknown'), 'error'); }
        else if (d.skipped) { flash('⏭ ' + d.reason); }
        else {
          flash('✅ ' + tf('msg.syncDone', { rows: d.rowsInserted || 0, ms: d.durationMs || 0 }, 'Sync เสร็จ · {rows} rows · {ms} ms'));
        }
        self.renderSync();
      })
      .catch(function (e) {
        if (err) err.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('m.syncNow.btn', 'เริ่ม sync'); }
        self.renderSync();
      });
  },

  // ── SKILL PROMPTS (Phase 18) ───────────────────────────
  // Read-only registry view of server/config/skill-prompts.json.
  // CRUD is deliberately not implemented yet — Phase 2 (after PM approves
  // moving to DB) will add full create/update/delete with audit log.
  renderSkills: function () {
    var self = this;
    var statusEl = document.getElementById('skills-status');
    var listEl   = document.getElementById('skills-list');
    if (statusEl) statusEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-3)">' + t('common.loading', '⏳ กำลังโหลด...') + '</div>';
    if (listEl)   listEl.innerHTML = '';

    fetch(BASE + '/api/skills', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          statusEl.innerHTML = '<div style="padding:24px;color:#e25563">⚠ ' + escapeHtml(d.error || 'failed') + '</div>';
          return;
        }
        self._renderSkillsStatus(d.status, d.skills);
        self._renderSkillsList(d.skills);
      })
      .catch(function (e) {
        if (statusEl) statusEl.innerHTML = '<div style="padding:24px;color:#e25563">⚠ ' + escapeHtml(e.message) + '</div>';
      });
  },

  _renderSkillsStatus: function (status, skills) {
    var el = document.getElementById('skills-status');
    if (!el) return;
    var loadedAt = status && status.loadedAt ? formatDateStd(status.loadedAt) : '—';
    var configuredCount = (skills || []).filter(function (s) { return !s.isPlaceholder; }).length;
    var totalCount = (skills || []).length;
    var hasError = status && status.error;

    var statusPill = hasError
      ? '<span style="display:inline-block;padding:4px 12px;border-radius:20px;background:rgba(220,53,69,0.10);color:#e25563;border:1px solid rgba(220,53,69,0.35);font-size:.82rem;font-weight:600">🔴 Load error</span>'
      : configuredCount === totalCount
        ? '<span style="display:inline-block;padding:4px 12px;border-radius:20px;background:rgba(55,179,74,0.10);color:#3fa64d;border:1px solid rgba(55,179,74,0.35);font-size:.82rem;font-weight:600">🟢 All configured</span>'
        : '<span style="display:inline-block;padding:4px 12px;border-radius:20px;background:rgba(240,160,64,0.10);color:#e6a14a;border:1px solid rgba(240,160,64,0.35);font-size:.82rem;font-weight:600">🟡 ' + configuredCount + '/' + totalCount + ' configured</span>';

    var blocks = [
      { label: 'Status',     value: statusPill },
      { label: 'Total',      value: '<span style="font-family:Geist Mono,monospace">' + totalCount + ' skills</span>' },
      { label: 'Configured', value: '<span style="font-family:Geist Mono,monospace;color:#3fa64d">' + configuredCount + '</span>' },
      { label: 'Placeholder',value: '<span style="font-family:Geist Mono,monospace;color:#e6a14a">' + (totalCount - configuredCount) + '</span>' },
      { label: 'Last Loaded',value: '<span style="font-family:Geist Mono,monospace;font-size:.82rem">' + loadedAt + '</span>' },
    ];

    el.innerHTML =
        '<h3 class="card-title" style="margin-bottom:14px">Registry Status</h3>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">'
      +   blocks.map(function (b) {
            return '<div style="padding:10px 14px;background:var(--surface-3);'
              + 'border:1px solid var(--border-subtle);border-radius:8px">'
              + '<div style="font-size:.66rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">' + b.label + '</div>'
              + '<div style="font-size:.95rem;font-weight:600">' + b.value + '</div>'
              + '</div>';
          }).join('')
      + '</div>'
      + (hasError
          ? '<div style="margin-top:14px;padding:12px 14px;background:rgba(220,53,69,0.06);border:1px solid rgba(220,53,69,0.30);border-radius:8px;color:#e25563;font-size:.82rem;font-family:Geist Mono,monospace">'
            + '<b>Load error:</b> ' + escapeHtml(status.error) + '</div>'
          : '');
  },

  _renderSkillsList: function (skills) {
    var el = document.getElementById('skills-list');
    if (!el) return;
    if (!skills || skills.length === 0) {
      el.innerHTML = '<div class="glass-card" style="padding:32px;text-align:center;color:var(--text-3)">'
        + t('empty.noSkillsYetHtml', '🧩 ยังไม่มี skill ในไฟล์ — แก้ <code>server/config/skill-prompts.json</code> แล้วกด <b>Reload</b>') + '</div>';
      return;
    }
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    var cards = skills.map(function (s) {
      var statusBadge = s.isPlaceholder
        ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:20px;background:rgba(240,160,64,0.10);color:#e6a14a;border:1px solid rgba(240,160,64,0.35);font-size:.7rem;font-weight:600">⚠ Placeholder</span>'
        : '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:20px;background:rgba(55,179,74,0.10);color:#3fa64d;border:1px solid rgba(55,179,74,0.30);font-size:.7rem;font-weight:600">✓ Configured</span>';
      var openaiPill = s.openaiPromptId
        ? '<span style="font-family:Geist Mono,monospace;font-size:.7rem;padding:2px 7px;background:var(--accent-soft-bg);color:var(--accent);border:1px solid var(--accent-soft-border);border-radius:5px">' + escapeHtml(s.openaiPromptId) + '</span>'
        : '<span style="color:var(--text-3);font-size:.72rem;font-style:italic">no openai ref</span>';

      var idJs = "'" + String(s.id).replace(/'/g, "\\'") + "'";
      return '<div class="glass-card" style="margin-bottom:14px">'
        + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:10px">'
        +   '<div style="flex:1;min-width:240px">'
        +     '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">'
        +       '<div style="font-size:1.05rem;font-weight:700;color:var(--text-1)">' + escapeHtml(s.label) + '</div>'
        +       statusBadge
        +     '</div>'
        +     '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">'
        +       '<span style="font-family:Geist Mono,monospace;font-size:.74rem;color:var(--text-3)">id: <b style="color:var(--text-2)">' + escapeHtml(s.id) + '</b></span>'
        +       openaiPill
        +     '</div>'
        +     '<div style="font-size:.86rem;color:var(--text-2);line-height:1.5">' + escapeHtml(s.description || '—') + '</div>'
        +   '</div>'
        +   '<div style="display:flex;gap:8px;flex-shrink:0">'
        +     '<button class="btn-action" style="padding:7px 14px" onclick="admin.openPromptLab(' + idJs + ')">🧪 ' + escapeHtml(TT('btn.test', 'ทดสอบ')) + '</button>'
        +     '<button class="btn-action" style="padding:7px 14px" onclick="admin.openPromptLab(' + idJs + ', true)">📋 ' + escapeHtml(TT('btn.history', 'ประวัติ')) + '</button>'
        +     '<button class="btn-action btn-save" style="padding:7px 14px" onclick="admin.openEditSkill(' + idJs + ')">✏️ ' + escapeHtml(TT('btn.edit', 'แก้ไข')) + '</button>'
        +     '<button class="btn-action" style="padding:7px 12px;color:#e25563;border-color:rgba(220,53,69,0.35)" onclick="admin.deleteSkillPrompt(' + idJs + ')">🗑</button>'
        +   '</div>'
        + '</div>'
        + '<details style="margin-top:10px">'
        +   '<summary style="cursor:pointer;font-size:.74rem;color:var(--text-3);font-weight:600;user-select:none">'
        +     '📄 Content preview (' + s.contentLength + ' chars)</summary>'
        +   '<pre style="margin-top:8px;padding:12px;background:var(--surface-3);border:1px solid var(--border-subtle);border-radius:6px;font-family:Geist Mono,monospace;font-size:.75rem;color:var(--text-2);white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto">'
        +     escapeHtml(s.contentPreview) + '</pre>'
        + '</details>'
        + '</div>';
    }).join('');
    el.innerHTML = cards;
  },

  reloadSkills: function () {
    var self = this;
    fetch(BASE + '/api/skills/reload', {
      method: 'POST', headers: Auth.authHeaders(),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { flash('❌ ' + t('msg.reloadFailedPrefix', 'Reload failed: ') + (d.error || 'unknown'), 'error'); return; }
        if (d.status && d.status.error) {
          flash('⚠ ' + t('msg.reloadedWithErrorPrefix', 'Reloaded แต่มี error: ') + d.status.error, 'error');
        } else {
          flash('✅ ' + tf('msg.reloadSuccess', { count: (d.status && d.status.count) || 0 }, 'Reload เรียบร้อย · {count} skills'));
        }
        self.renderSkills();
      })
      .catch(function (e) { flash('❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message, 'error'); });
  },

  // ── Phase 22: add / edit / delete skill prompts from the UI ──────
  _fillSkillModal: function (s) {
    var g = function (id) { return document.getElementById(id); };
    g('es-id').value      = s.id || '';
    g('es-label').value   = s.label || '';
    g('es-desc').value    = s.description || '';
    g('es-openai').value  = s.openaiPromptId || '';
    g('es-content').value = s.content || '';
    g('es-error').textContent = '';
    this._updateSkillCharCount();
  },

  _updateSkillCharCount: function () {
    var el = document.getElementById('es-content');
    var c  = document.getElementById('es-charcount');
    if (el && c) c.textContent = (el.value || '').length.toLocaleString() + ' chars';
  },

  // Phase 33: QA sandbox — run a test prompt through a skill's system
  // prompt without touching the chat budget gate or leaving a session
  // behind in the user's real chat history. See POST /api/skills/:id/test.
  // ── Phase 29: Prompt Lab (full-page test workspace) ────────────────────
  // Replaces the old test/history modals: pick skill + model/effort, see the
  // system prompt under test, run a question, judge the answer and browse
  // history — all on one page (view-lab).

  // Entry point from the Skill Prompts cards: 🧪 opens the lab on that skill,
  // 📋 additionally scrolls down to the history block.
  openPromptLab: function (skillId, showHistory) {
    if (skillId) this._labSkillId = skillId;
    this.navigate('lab');
    if (showHistory) {
      setTimeout(function () {
        var el = document.getElementById('lab-history-card');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 450);
    }
  },

  renderLab: function () {
    var self = this;
    fetch(BASE + '/api/skills', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) return;
        var sel = d.skills || [];
        var el  = document.getElementById('lab-skill');
        if (!el) return;
        var want = self._labSkillId || (sel[0] && sel[0].id) || '';
        el.innerHTML = sel.map(function (s) {
          return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.label || s.id) + '</option>';
        }).join('');
        el.value = want;
        if (!el.value && sel.length) el.value = sel[0].id;
        self._labSkillId = el.value;
        self.onLabSkillChange();
      })
      .catch(function () {});
  },

  onLabSkillChange: function () {
    var el = document.getElementById('lab-skill');
    if (el && el.value) this._labSkillId = el.value;
    // A different skill means the old answer/verdict no longer applies.
    var ans = document.getElementById('lab-answer'); if (ans) ans.textContent = '';
    var meta = document.getElementById('lab-meta');  if (meta) meta.textContent = '';
    this.showVerdictBar('lab', null);
    this._loadLabPrompt();
    this.loadTestHistory();
  },

  // Effort only applies to the gpt-5.6 reasoning family — hide it otherwise.
  onLabModelChange: function (v) {
    var f = document.getElementById('lab-effort-field');
    if (f) f.style.display = (v && v.indexOf('gpt-5.6') === 0) ? '' : 'none';
  },

  // Show which system prompt is being tested (full content + length) so the
  // page explains itself: question vs THIS prompt.
  _loadLabPrompt: function () {
    var id = this._labSkillId;
    if (!id) return;
    fetch(BASE + '/api/skills/' + encodeURIComponent(id), { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok || !d.skill) return;
        var sum = document.getElementById('lab-prompt-summary');
        var pre = document.getElementById('lab-prompt-preview');
        if (sum) sum.textContent = '📄 ' + t('lab.promptSummary', 'System prompt ที่ใช้ทดสอบ')
          + ' — ' + (d.skill.label || d.skill.id) + ' (' + (d.skill.content || '').length.toLocaleString() + ' chars)';
        if (pre) pre.textContent = d.skill.content || '';
      })
      .catch(function () {});
  },

  labRun: function () {
    var self = this;
    var id   = this._labSkillId;
    var g    = function (elId) { return document.getElementById(elId); };
    var prompt = (g('lab-question').value || '').trim();
    var errEl  = g('lab-error');
    if (!id) return;
    if (!prompt) { errEl.textContent = t('err.enterTestPrompt', 'กรุณากรอกคำถามทดสอบ'); return; }
    errEl.textContent = '';

    var btn = g('lab-run-btn');
    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; btn.textContent = t('common.running', 'กำลังรัน...'); }
    var ans = g('lab-answer'); if (ans) ans.textContent = '';
    var meta = g('lab-meta');  if (meta) meta.textContent = '';
    this.showVerdictBar('lab', null);

    fetch(BASE + '/api/skills/' + encodeURIComponent(id) + '/test', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
      body: JSON.stringify({
        prompt: prompt,
        model:  (g('lab-model')  || {}).value,
        effort: (g('lab-effort') || {}).value,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = d.error || t('err.testFailed', 'ทดสอบไม่สำเร็จ'); return; }
        if (ans) ans.textContent = d.answer || t('msg.emptyResponse', '(empty response)');
        if (meta) meta.textContent = (d.inputTokens + d.outputTokens).toLocaleString() + ' tokens'
          + (d.model ? ' · ' + d.model : '');
        self.showVerdictBar('lab', d.logId || null);
        // The run itself created a (pending) history row — refresh the list.
        self.loadTestHistory(true);
      })
      .catch(function (e) { errEl.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '▶ ' + t('btn.run', 'Run'); }
      });
  },

  // ── Phase 28: senior judgement (verdict) + test history ───────────────
  // One shared verdict bar renderer serves both the test modal (prefix 'ts')
  // and the history detail view (prefix 'th'). Every element id is
  // '<prefix>-…' so the two instances never collide.

  _verdictLogIds: {},   // prefix → log_id currently being judged
  _verdictPick:   {},   // prefix → selected verdict value

  _VERDICTS: [
    { v: 'correct',   icon: '✅', key: 'modal.testSkill.vCorrect',   fb: 'ถูกต้อง' },
    { v: 'partial',   icon: '⚠️', key: 'modal.testSkill.vPartial',   fb: 'เกือบถูก' },
    { v: 'incorrect', icon: '❌', key: 'modal.testSkill.vIncorrect', fb: 'ผิด' },
  ],

  // Render the judgement bar into #<prefix>-verdict. `existing` (optional) is
  // a full log record — the history detail passes it to prefill a past verdict.
  showVerdictBar: function (prefix, logId, existing) {
    var box = document.getElementById(prefix + '-verdict');
    if (!box) return;
    if (!logId) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    this._verdictLogIds[prefix] = logId;
    this._verdictPick[prefix]   = null;

    var btns = this._VERDICTS.map(function (d) {
      return '<button type="button" class="btn-action" id="' + prefix + '-v-' + d.v + '" style="padding:6px 13px"'
        + ' onclick="admin.pickVerdict(\'' + prefix + '\',\'' + d.v + '\')">'
        + d.icon + ' ' + escapeHtml(TT(d.key, d.fb)) + '</button>';
    }).join('');

    box.innerHTML =
        '<div style="padding:11px;border:1px solid var(--border-subtle);border-radius:6px;background:var(--surface-3)">'
      +   '<label class="modal-label" style="margin-bottom:6px">' + escapeHtml(TT('modal.testSkill.verdictLabel', 'คำตัดสิน (senior)')) + '</label>'
      +   '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' + btns + '</div>'
      +   '<div id="' + prefix + '-corrected-wrap" style="display:none;margin-bottom:8px">'
      +     '<label class="modal-label">' + escapeHtml(TT('modal.testSkill.correctedLabel', 'เฉลยที่ถูกต้อง')) + '</label>'
      +     '<textarea class="modal-input" id="' + prefix + '-corrected" rows="4" placeholder="'
      +       escapeHtml(TT('modal.testSkill.correctedPh', 'วางคำตอบที่ถูกต้อง — จะกลายเป็นเฉลยใน golden dataset')) + '"></textarea>'
      +   '</div>'
      +   '<div class="modal-row">'
      +     '<div class="modal-field"><label class="modal-label">' + escapeHtml(TT('modal.testSkill.categoryLabel', 'หมวด (ไม่บังคับ)')) + '</label>'
      +       '<input class="modal-input" id="' + prefix + '-category" placeholder="FI / MM / SD / ..." /></div>'
      +     '<div class="modal-field"><label class="modal-label">' + escapeHtml(TT('modal.testSkill.noteLabel', 'โน้ต (ไม่บังคับ)')) + '</label>'
      +       '<input class="modal-input" id="' + prefix + '-vnote" /></div>'
      +   '</div>'
      +   '<div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:8px">'
      +     '<span id="' + prefix + '-verdict-msg" style="font-size:.75rem;color:#3fa64d"></span>'
      +     '<button type="button" class="btn-modal-submit" id="' + prefix + '-verdict-save" onclick="admin.saveVerdict(\'' + prefix + '\')">💾 '
      +       escapeHtml(TT('modal.testSkill.saveVerdict', 'บันทึกคำตัดสิน')) + '</button>'
      +   '</div>'
      + '</div>';
    box.style.display = '';

    if (existing) {
      if (existing.verdict) this.pickVerdict(prefix, existing.verdict);
      var c = document.getElementById(prefix + '-corrected'); if (c) c.value = existing.corrected_answer || '';
      var g = document.getElementById(prefix + '-category');  if (g) g.value = existing.category || '';
      var n = document.getElementById(prefix + '-vnote');     if (n) n.value = existing.verdict_note || '';
    }
  },

  pickVerdict: function (prefix, v) {
    this._verdictPick[prefix] = v;
    this._VERDICTS.forEach(function (d) {
      var b = document.getElementById(prefix + '-v-' + d.v);
      if (!b) return;
      var on = d.v === v;
      b.style.background  = on ? 'var(--accent-soft-bg)' : '';
      b.style.borderColor = on ? 'var(--accent-soft-border)' : '';
      b.style.color       = on ? 'var(--accent)' : '';
      b.style.fontWeight  = on ? '700' : '';
    });
    // The corrected-answer box only matters when the AI got it (partly) wrong.
    var wrap = document.getElementById(prefix + '-corrected-wrap');
    if (wrap) wrap.style.display = (v === 'partial' || v === 'incorrect') ? '' : 'none';
  },

  saveVerdict: function (prefix) {
    var self  = this;
    var logId = this._verdictLogIds[prefix];
    var v     = this._verdictPick[prefix];
    var msg   = document.getElementById(prefix + '-verdict-msg');
    if (!logId) return;
    if (!v) { if (msg) { msg.style.color = '#e25563'; msg.textContent = t('err.pickVerdict', 'เลือกคำตัดสินก่อน'); } return; }
    var gv  = function (suffix) { var el = document.getElementById(prefix + suffix); return el ? el.value : ''; };
    var btn = document.getElementById(prefix + '-verdict-save');
    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
    fetch(BASE + '/api/skill-test-logs/' + logId + '/verdict', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
      body: JSON.stringify({
        verdict: v,
        correctedAnswer: gv('-corrected'),
        note: gv('-vnote'),
        category: gv('-category'),
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { if (msg) { msg.style.color = '#e25563'; msg.textContent = d.error || t('err.saveFailed', 'บันทึกไม่สำเร็จ'); } return; }
        if (msg) { msg.style.color = '#3fa64d'; msg.textContent = '✓ ' + t('modal.testSkill.verdictSaved', 'บันทึกแล้ว'); }
        // Refresh the history list so the row badge/stats reflect the verdict
        // (both the run area 'lab' and the history detail 'lh' live on the
        // lab page next to the list).
        if (prefix === 'lab' || prefix === 'lh') self.loadTestHistory(true);
      })
      .catch(function (e) { if (msg) { msg.style.color = '#e25563'; msg.textContent = e.message; } })
      .finally(function () { if (btn) { btn.disabled = false; btn.style.opacity = '1'; } });
  },

  // keepDetail=true → don't collapse the open detail pane (used after saving
  // a verdict from the detail view so the senior keeps their place).
  loadTestHistory: function (keepDetail) {
    var self    = this;
    var skillId = this._labSkillId;
    if (!skillId) return;
    var verdict = (document.getElementById('lab-filter') || {}).value || '';
    var errEl   = document.getElementById('lab-hist-error');
    var listEl  = document.getElementById('lab-list');
    if (!keepDetail) {
      var det = document.getElementById('lab-detail');
      if (det) { det.style.display = 'none'; det.innerHTML = ''; }
    }
    if (listEl) listEl.innerHTML = '<div style="padding:14px;color:var(--text-3);font-size:.8rem">'
      + t('common.loading', '⏳ กำลังโหลด...') + '</div>';
    fetch(BASE + '/api/skill-test-logs?skill=' + encodeURIComponent(skillId)
        + (verdict ? '&verdict=' + verdict : ''), { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { if (errEl) errEl.textContent = d.error || t('err.loadFailed', 'โหลดไม่สำเร็จ'); return; }
        self._renderTestHistory(d.rows || [], d.stats || {});
      })
      .catch(function (e) { if (errEl) errEl.textContent = e.message; });
  },

  _verdictBadge: function (v) {
    if (v === 'correct')   return '<span style="font-weight:700">✅</span>';
    if (v === 'partial')   return '<span style="font-weight:700">⚠️</span>';
    if (v === 'incorrect') return '<span style="font-weight:700">❌</span>';
    return '<span style="color:var(--text-3)">⏳</span>';
  },

  _renderTestHistory: function (rows, stats) {
    var listEl  = document.getElementById('lab-list');
    var statsEl = document.getElementById('lab-stats');
    if (statsEl) statsEl.innerHTML = t('modal.testHistory.total', 'รวม') + ' <b>' + (stats.total || 0) + '</b>'
      + ' · ✅ ' + (stats.correct || 0) + ' · ⚠️ ' + (stats.partial || 0)
      + ' · ❌ ' + (stats.incorrect || 0) + ' · ⏳ ' + (stats.pending || 0);
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-3);font-size:.8rem">'
        + t('modal.testHistory.empty', 'ยังไม่มีการทดสอบ skill นี้') + '</div>';
      return;
    }
    listEl.innerHTML = rows.map(function (r) {
      var dt   = new Date(r.created_at);
      var when = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return '<div onclick="admin.openTestLogDetail(' + r.log_id + ')"'
        + ' style="display:flex;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--border-subtle);cursor:pointer"'
        + ' onmouseover="this.style.background=\'var(--surface-3)\'" onmouseout="this.style.background=\'\'">'
        + admin._verdictBadge(r.verdict)
        + '<span style="font-size:.72rem;color:var(--text-3);white-space:nowrap">' + when + '</span>'
        + '<span style="font-family:Geist Mono,monospace;font-size:.68rem;color:var(--text-3);white-space:nowrap">' + escapeHtml(r.model || '') + '</span>'
        + (r.category ? '<span style="font-size:.68rem;padding:1px 7px;border-radius:10px;background:var(--accent-soft-bg);color:var(--accent)">' + escapeHtml(r.category) + '</span>' : '')
        + '<span style="flex:1;font-size:.78rem;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(r.question_preview || '') + '</span>'
        + '</div>';
    }).join('');
  },

  openTestLogDetail: function (logId) {
    var self = this;
    fetch(BASE + '/api/skill-test-logs/' + logId, { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          var e = document.getElementById('lab-hist-error');
          if (e) e.textContent = d.error || t('err.loadFailed', 'โหลดไม่สำเร็จ');
          return;
        }
        self._renderTestLogDetail(d.log);
      })
      .catch(function (e2) {
        var e = document.getElementById('lab-hist-error');
        if (e) e.textContent = e2.message;
      });
  },

  _renderTestLogDetail: function (log) {
    var det = document.getElementById('lab-detail');
    if (!det) return;
    var pre = function (label, text) {
      return '<label class="modal-label" style="margin-top:8px">' + escapeHtml(label) + '</label>'
        + '<pre style="margin:0;padding:10px;background:var(--surface-3);border:1px solid var(--border-subtle);border-radius:6px;font-family:\'Geist Mono\',monospace;font-size:.76rem;color:var(--text-2);white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto">'
        + escapeHtml(text || '') + '</pre>';
    };
    det.innerHTML =
        '<div style="font-size:.72rem;color:var(--text-3);margin-bottom:2px">#' + log.log_id + ' · ' + escapeHtml(log.model || '')
      +   (log.effort ? ' / ' + escapeHtml(log.effort) : '')
      +   ' · ' + ((log.input_tokens || 0) + (log.output_tokens || 0)).toLocaleString() + ' tokens</div>'
      + pre(t('modal.testHistory.question', 'โจทย์'), log.question)
      + pre(t('modal.testSkill.answerLabel', 'คำตอบ AI'), log.answer)
      + '<div id="lh-verdict" style="display:none;margin-top:10px"></div>';
    det.style.display = '';
    this.showVerdictBar('lh', log.log_id, log);
    det.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  openAddSkill: function () {
    document.getElementById('es-title').textContent = t('modal.addSkill.title', '➕ เพิ่ม Skill ใหม่');
    document.getElementById('es-mode').value = 'add';
    document.getElementById('es-id').readOnly = false;
    this._fillSkillModal({});
    showModal('modal-edit-skill');
    var ec = document.getElementById('es-content');
    if (ec && !ec._cc) { ec._cc = true; ec.addEventListener('input', this._updateSkillCharCount); }
    setTimeout(function () { document.getElementById('es-id').focus(); }, 50);
  },

  openEditSkill: function (id) {
    var self = this;
    fetch(BASE + '/api/skills/' + encodeURIComponent(id), { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { flash('❌ ' + t('msg.loadSkillFailedPrefix', 'โหลด skill ไม่สำเร็จ: ') + (d.error || 'unknown'), 'error'); return; }
        document.getElementById('es-title').textContent = t('modal.editSkill.title', '✏️ แก้ไข Skill');
        document.getElementById('es-mode').value = 'edit';
        document.getElementById('es-id').readOnly = true;  // id is the key — fixed on edit
        self._fillSkillModal(d.skill);
        showModal('modal-edit-skill');
        var ec = document.getElementById('es-content');
        if (ec && !ec._cc) { ec._cc = true; ec.addEventListener('input', self._updateSkillCharCount); }
      })
      .catch(function (e) { flash('❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message, 'error'); });
  },

  submitEditSkill: function () {
    var self = this;
    var g = function (id) { return document.getElementById(id); };
    var errEl = g('es-error');
    var payload = {
      id:             (g('es-id').value || '').trim(),
      label:          (g('es-label').value || '').trim(),
      description:    (g('es-desc').value || '').trim(),
      openaiPromptId: (g('es-openai').value || '').trim(),
      content:        g('es-content').value || '',
    };
    if (!payload.id)               { errEl.textContent = t('err.enterSkillId', 'กรุณากรอก Skill ID'); return; }
    if (!payload.content.trim())   { errEl.textContent = t('err.enterContent', 'กรุณากรอก Content (system prompt)'); return; }
    errEl.textContent = '';

    var btn = document.querySelector('#modal-edit-skill .btn-modal-submit');
    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }

    fetch(BASE + '/api/skills', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = d.error || t('err.saveFailed', 'บันทึกไม่สำเร็จ'); return; }
        hideModal('modal-edit-skill');
        flash(d.created ? '✅ ' + t('msg.skillAdded', 'เพิ่ม skill เรียบร้อย (มีผลทันที)') : '✅ ' + t('msg.skillSaved', 'บันทึก skill เรียบร้อย (มีผลทันที)'));
        self.renderSkills();
      })
      .catch(function (e) { errEl.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; })
      .finally(function () { if (btn) { btn.disabled = false; btn.style.opacity = '1'; } });
  },

  deleteSkillPrompt: function (id) {
    var self = this;
    if (!confirm(tf('confirm.deleteSkill', { id: id }, 'ลบ skill "{id}" ออกจาก registry?\n(ไฟล์บนเครื่องนี้จะถูกแก้ทันที)'))) return;
    fetch(BASE + '/api/skills/' + encodeURIComponent(id), {
      method: 'DELETE', headers: Auth.authHeaders(),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { flash('❌ ' + t('msg.deleteSkillFailedPrefix', 'ลบไม่สำเร็จ: ') + (d.error || 'unknown'), 'error'); return; }
        flash(tf('msg.skillDeleted', { id: id }, '🗑 ลบ skill "{id}" เรียบร้อย'));
        self.renderSkills();
      })
      .catch(function (e) { flash('❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message, 'error'); });
  },

  //   1) If we have any cached projects (from init() or a prior page visit),
  //      render the balance table immediately. The user sees data instantly.
  //   2) In parallel, fetch fresh /api/projects + /api/topup-history,
  //      then re-render both tables with the latest figures.
  // Called by navigate('balance') and after each successful top-up.
  renderBalance: function () {
    var self = this;
    var balEl = document.getElementById('balance-table');
    var hisEl = document.getElementById('topup-history-table');

    // Phase 1: cached render (instant)
    if (this._cachedDBProjects && this._cachedDBProjects.length) {
      this._renderBalanceTable(this._cachedDBProjects);
    } else if (balEl) {
      balEl.innerHTML = '<tbody><tr><td colspan="3" style="text-align:center;color:var(--text-3);padding:24px">⏳ กำลังโหลด...</td></tr></tbody>';
    }
    if (hisEl) hisEl.innerHTML = '<tbody><tr><td colspan="4" style="text-align:center;color:var(--text-3);padding:24px">⏳ กำลังโหลด...</td></tr></tbody>';

    // Phase 2: fresh fetch (always)
    Promise.all([
      this.fetchProjectsFromDB().catch(function (e) {
        console.error('[balance] projects fetch failed:', e);
        return null;
      }),
      fetch(BASE + '/api/topup-history?limit=200', { headers: Auth.authHeaders() })
        .then(function (r) { return r.json(); })
        .then(function (d) { return d.ok ? d.data : []; })
        .catch(function (e) { console.error('[balance] history fetch failed:', e); return []; }),
    ]).then(function (results) {
      // results[0] is null only if fetchProjectsFromDB threw — fall back to cache.
      var projects = results[0] || self._cachedDBProjects || [];
      var history  = results[1] || [];
      self._renderBalanceTable(projects);
      self._renderTopupHistoryTable(history);
    });
  },

  // Format helper local to the balance view — uses "THB" + thousands separator
  // to match the mockup ("THB 2,050.00"). The global formatTHB() ("฿2050.00")
  // is kept untouched so the rest of the dashboard's spacing/styling stays the same.
  _formatBahtFmt: function (n) {
    var v = parseFloat(n || 0);
    return 'THB ' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  _renderBalanceTable: function (projects) {
    var el = document.getElementById('balance-table');
    if (!el) return;
    if (!projects.length) {
      el.innerHTML = '<tbody><tr><td colspan="3" style="text-align:center;color:var(--text-3);padding:24px">' + t('empty.noProjectsTable', 'ยังไม่มี project') + '</td></tr></tbody>';
      return;
    }
    var self = this;
    var rows = projects.map(function (p) {
      var bal = parseFloat(p.totalTopUp || 0);
      return '<tr>'
        + '<td><b>' + escapeHtml(p.name) + '</b>'
            + (p.desc ? '<div style="font-size:.72rem;color:var(--text-3);margin-top:2px">' + escapeHtml(p.desc) + '</div>' : '')
        + '</td>'
        + '<td class="val" style="font-weight:700;color:var(--text-1)">' + self._formatBahtFmt(bal) + '</td>'
        + '<td style="text-align:right">'
            + '<button class="btn-action btn-primary-sm" style="padding:4px 12px;font-size:1rem;line-height:1" '
            + 'title="Top up" onclick="admin.openTopup(\'' + p.id + '\')">+</button>'
        + '</td>'
        + '</tr>';
    }).join('');
    el.innerHTML =
        '<thead><tr>'
      +   '<th>Project Name</th>'
      +   '<th>Project Credit</th>'
      +   '<th style="text-align:right">Top up</th>'
      + '</tr></thead><tbody>' + rows + '</tbody>';
  },

  _renderTopupHistoryTable: function (history) {
    var el = document.getElementById('topup-history-table');
    if (!el) return;
    if (!history.length) {
      el.innerHTML = '<tbody><tr><td colspan="4" style="text-align:center;color:var(--text-3);padding:24px">' + t('empty.noTopupHistory', 'ยังไม่มีประวัติการเติมเงิน') + '</td></tr></tbody>';
      return;
    }
    var self = this;
    var rows = history.map(function (h) {
      var d = new Date(h.createdAt);
      var when = isNaN(d.getTime()) ? '—'
        : (d.getDate().toString().padStart(2, '0') + '/'
         + (d.getMonth() + 1).toString().padStart(2, '0') + '/'
         + d.getFullYear() + ' '
         + d.getHours().toString().padStart(2, '0') + ':'
         + d.getMinutes().toString().padStart(2, '0'));
      var amount = parseFloat(h.amount || 0);
      var details = 'Top up ' + self._formatBahtFmt(amount)
        + (h.note ? '<div style="font-size:.72rem;color:var(--text-3);margin-top:2px;font-style:italic">' + escapeHtml(h.note) + '</div>' : '');
      return '<tr>'
        + '<td>' + when + '</td>'
        + '<td>' + details + '</td>'
        + '<td>' + escapeHtml(h.projectName || h.projectId || '—') + '</td>'
        + '<td>' + escapeHtml(h.userName || ('user#' + h.userId)) + '</td>'
        + '</tr>';
    }).join('');
    el.innerHTML =
        '<thead><tr>'
      +   '<th>Date &amp; Time</th>'
      +   '<th>Details</th>'
      +   '<th>Project</th>'
      +   '<th>User</th>'
      + '</tr></thead><tbody>' + rows + '</tbody>';
  },

  // ── CREDITS PAGE (Phase 16.11) ─────────────────────────
  // Two sub-tabs: Credit Management (default) + Usage Analytics.
  // Credit Management is a delta-model editor — setting a user credit moves
  // money between the project pool and the user wallet atomically.
  _currentCreditsTab: 'credit',

  renderCredits: function () {
    // Hide whichever pane isn't selected; render content for selected tab.
    this.switchCreditsTab(this._currentCreditsTab || 'credit');
  },

  refreshCreditsTab: function () {
    this.switchCreditsTab(this._currentCreditsTab || 'credit');
  },

  switchCreditsTab: function (tab) {
    this._currentCreditsTab = tab;
    var tabs = document.querySelectorAll('#view-usage .audit-tab');
    var panes = { credit: 'pane-credit', usage: 'pane-usage' };
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.keys(panes).forEach(function (k) {
      var el = document.getElementById(panes[k]);
      if (el) el.classList.toggle('hidden', k !== tab);
    });
    // Phase 21.10: poll the Cap Management table so "used today" + project
    // pool stay live while admin watches. Clear when leaving the tab.
    if (this._capPollTimer) { clearInterval(this._capPollTimer); this._capPollTimer = null; }
    if (tab === 'credit') {
      this.renderCreditManagement();
      var self = this;
      this._capPollTimer = setInterval(function () {
        // Only refresh while the Credits page + credit tab are actually visible.
        var pane = document.getElementById('pane-credit');
        var view = document.getElementById('view-usage');
        var visible = pane && !pane.classList.contains('hidden')
                   && view && !view.classList.contains('hidden');
        if (visible) self.renderCreditManagement(true);
        else { clearInterval(self._capPollTimer); self._capPollTimer = null; }
      }, 20000);
    }
    if (tab === 'usage')  this.renderUsage();
  },

  // Cached snapshot from /api/credits so the Edit modal can read project
  // balance and previous user credit without another round-trip.
  _cachedCredits: [],

  renderCreditManagement: function (silent) {
    var self = this;
    var tableEl = document.getElementById('credit-table');
    if (!tableEl) return;
    // silent=true (poll refresh): keep current rows on screen, no spinner flicker.
    if (!silent) {
      tableEl.innerHTML = '<tbody><tr><td colspan="6" style="text-align:center;color:var(--text-3);padding:24px">' + t('common.loading', '⏳ กำลังโหลด...') + '</td></tr></tbody>';
    }
    fetch(BASE + '/api/credits', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok || !Array.isArray(d.credits)) {
          tableEl.innerHTML = '<tbody><tr><td colspan="6" style="text-align:center;color:var(--text-3);padding:24px">' + t('empty.noDataFound', '⚠️ ไม่พบข้อมูล') + '</td></tr></tbody>';
          return;
        }
        self._cachedCredits = d.credits;
        self._renderCreditTable(d.credits);
      })
      .catch(function (e) {
        tableEl.innerHTML = '<tbody><tr><td colspan="6" style="text-align:center;color:#d04545;padding:24px">⚠ ' + escapeHtml(e.message) + '</td></tr></tbody>';
      });
  },

  // Phase 21.10 (Concept B) — Cap Management table.
  // Money lives in the project pool; per-user `daily_cap` is the limit.
  // Columns: Username | Project | Project Pool | Daily Cap | [edit].
  _renderCreditTable: function (rows) {
    var el = document.getElementById('credit-table');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<thead><tr><th>' + t('col.username', 'Username') + '</th><th>' + t('col.project', 'Project') + '</th><th>' + t('col.projectPool', 'Project Pool') + '</th><th>' + t('col.dailyCap', 'Daily Cap') + '</th><th>' + t('col.usedTodayCap', 'ใช้วันนี้ / Cap') + '</th><th></th></tr></thead>'
        + '<tbody><tr><td colspan="6" style="text-align:center;color:var(--text-3);padding:24px">' + t('empty.noUsersShort', 'ยังไม่มี user') + '</td></tr></tbody>';
      return;
    }
    var fmt = function (n) {
      return 'THB ' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    var fmtB = function (n) {
      return '฿' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    };
    var TTc = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    var tbody = rows.map(function (r) {
      var noProject = !r.projectId;
      var hasCap = !(r.dailyCap === null || r.dailyCap === undefined);
      var base = hasCap ? parseFloat(r.dailyCap) : null;
      var bonus = parseFloat(r.bonusBalance || 0);
      var effective = hasCap ? base + bonus : null;
      var spent = parseFloat(r.spentToday || 0);

      var capCell = !hasCap
        ? '<span style="opacity:.45;font-style:italic">' + TTc('val.unlimited','ไม่จำกัด') + '</span>'
        : '<b style="color:var(--text-1)">' + fmtB(base) + '</b>'
          + (bonus > 0 ? '<span style="color:#16a34a;font-size:.7rem" title="bonus คงเหลือ"> +' + fmtB(bonus) + ' bonus</span>' : '')
          + '<span style="color:var(--text-3);font-size:.72rem"> ' + TTc('unit.perDay','/วัน') + '</span>';

      // Real-time "used today" cell with progress bar.
      var usedCell;
      if (!hasCap) {
        usedCell = '<span style="font-family:Geist Mono,monospace;color:var(--text-2)">' + fmtB(spent) + '</span>'
                 + '<span style="color:var(--text-3);font-size:.7rem"> ' + TTc('lbl.used','ใช้แล้ว') + '</span>';
      } else {
        var ratio = effective > 0 ? Math.min(1, spent / effective) : (spent > 0 ? 1 : 0);
        var pct = Math.round(ratio * 100);
        var barColor = ratio >= 1 ? '#dc2626' : ratio >= 0.8 ? '#f59e0b' : '#16a34a';
        usedCell =
            '<div style="display:flex;flex-direction:column;gap:4px;min-width:120px">'
          +   '<div style="font-family:Geist Mono,monospace;font-size:.8rem">'
          +     '<b style="color:' + barColor + '">' + fmtB(spent) + '</b>'
          +     '<span style="color:var(--text-3)"> / ' + fmtB(effective) + '</span>'
          +     '<span style="color:var(--text-3);font-size:.7rem"> · ' + pct + '%</span>'
          +   '</div>'
          +   '<div style="height:5px;border-radius:3px;background:var(--surface-3);overflow:hidden">'
          +     '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';transition:width .3s"></div>'
          +   '</div>'
          + '</div>';
      }

      return '<tr>'
        + '<td><b>' + escapeHtml(r.displayName || r.username) + '</b>'
            + '<div style="font-size:.7rem;color:var(--text-3);margin-top:2px">@' + escapeHtml(r.username) + '</div></td>'
        + '<td>' + escapeHtml(r.projectName || '—') + '</td>'
        + '<td class="val">' + (noProject ? '—' : fmt(r.projectBalance)) + '</td>'
        + '<td class="val">' + capCell + '</td>'
        + '<td>' + (noProject ? '—' : usedCell) + '</td>'
        + '<td style="text-align:right">'
            + '<button class="btn-icon-edit" title="' + escapeHtml(t('tt.setDailyCap', 'ตั้ง Daily Cap')) + '" ' + (noProject ? 'disabled style="opacity:.4;cursor:not-allowed"' : '')
            + ' onclick="admin.openEditCap(' + r.userId + ')">'
            + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
            + '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>'
            + '</button></td>'
        + '</tr>';
    }).join('');
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    el.innerHTML =
        '<thead><tr>'
      +   '<th>' + TT('col.username','Username') + '</th>'
      +   '<th>' + TT('col.project','Project') + '</th>'
      +   '<th>' + TT('col.projectPool','Project Pool') + '</th>'
      +   '<th>' + TT('col.dailyCap','Daily Cap') + '</th>'
      +   '<th>' + TT('col.usedTodayCap','ใช้วันนี้ / Cap') + '</th>'
      +   '<th></th>'
      + '</tr></thead><tbody>' + tbody + '</tbody>';
  },

  // Phase 21.10 (Concept B) — open the Daily Cap editor for a user.
  openEditCap: function (userId) {
    var row = (this._cachedCredits || []).find(function (x) { return x.userId === userId; });
    if (!row) { flash('❌ ' + t('err.userNotFound', 'ไม่พบ user'), 'error'); return; }
    if (!row.projectId) { flash('❌ ' + t('err.userNoProject', 'user ยังไม่มี project'), 'error'); return; }
    document.getElementById('ec-user-id').value = userId;
    document.getElementById('ec-user-display').textContent = (row.displayName || row.username) + '  @' + row.username;
    document.getElementById('ec-project-name').textContent = row.projectName || '—';
    document.getElementById('ec-pool-display').textContent = '฿' + parseFloat(row.projectBalance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var hasCap = !(row.dailyCap === null || row.dailyCap === undefined);
    document.getElementById('ec-new-cap').value = hasCap ? parseFloat(row.dailyCap) : '';
    document.getElementById('ec-nolimit').checked = !hasCap;
    document.getElementById('ec-error').textContent = '';
    var btn = document.getElementById('ec-submit-btn');
    if (btn) btn.disabled = false;
    showModal('modal-edit-credit');
  },

  submitEditCap: function () {
    var self = this;
    var userId = parseInt(document.getElementById('ec-user-id').value, 10);
    var noLimit = document.getElementById('ec-nolimit').checked;
    var capRaw = document.getElementById('ec-new-cap').value.trim();
    var errEl = document.getElementById('ec-error');
    errEl.textContent = '';

    var dailyCap;
    if (noLimit || capRaw === '') {
      dailyCap = null;                       // remove cap
    } else {
      dailyCap = Number(capRaw);
      if (!isFinite(dailyCap) || dailyCap < 0) {
        errEl.textContent = '❌ ' + t('err.dailyCapInvalid', 'Daily Cap ต้องเป็นตัวเลข ≥ 0 (หรือเลือก "ไม่จำกัด")');
        return;
      }
    }

    var btn = document.getElementById('ec-submit-btn');
    btn.disabled = true;
    fetch(BASE + '/api/users/' + userId + '/daily-cap', {
      method: 'PUT',
      headers: Auth.authHeaders(),
      body: JSON.stringify({ dailyCap: dailyCap }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = '❌ ' + (d.error || 'failed'); btn.disabled = false; return; }
        hideModal('modal-edit-credit');
        flash(dailyCap === null
          ? '✅ ' + t('msg.dailyCapRemoved', 'ลบ Daily Cap แล้ว (ไม่จำกัด)')
          : '✅ ' + tf('msg.dailyCapSet', { cap: dailyCap }, 'ตั้ง Daily Cap = ฿{cap}/วัน เรียบร้อย'));
        self.renderCreditManagement();
      })
      .catch(function (e) {
        errEl.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        btn.disabled = false;
      });
  },

  // ── USERS PAGE (Phase 16.4 layout) ─────────────────────
  // Sticky filter state — survives re-renders triggered by edits.
  // Empty Set = "show all". A Set of project ids = "show only those projects".
  // The special id "__none__" represents "no project assigned".
  _userProjectFilter: null,   // Set | null (null = uninitialised, treated as "all")

  // Phase 16.24: User Management refactored from table to row-cards.
  // Same data, same filter dropdown — but consistent with the row-style
  // used on Overview / Projects / Credits Management pages.
  // The filter trigger now lives in a header bar above the rows
  // (Credits-page pattern) rather than inside a <th>.
  renderUsers: function () {
    var self = this;
    var tableEl = document.getElementById('user-table');
    if (tableEl) tableEl.innerHTML =
      '<div style="padding:32px;text-align:center;color:var(--text-3);font-size:.85rem;'
      + 'background:var(--surface-2);border:1px solid var(--border-default);border-radius:10px">'
      + '⏳ กำลังโหลด...</div>';

    this.fetchUsersFromDB().then(function (users) {
      self._cachedDBUsers = users;
      users = users.filter(function (u) { return u.role !== 'admin'; });
      var totalUsers = users.length;

      var filter = self._userProjectFilter;
      if (filter && filter.size > 0) {
        users = users.filter(function (u) {
          var key = u.projectId ? String(u.projectId) : '__none__';
          return filter.has(key);
        });
      }

      // —— Filter header bar (matches Credits / Usage Analytics pattern) ——
      var hasActive = filter && filter.size > 0;
      var filterLabel = hasActive ? ('Filtered (' + filter.size + ')') : 'ทุก Project';
      var filterChevron = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>';
      var filterBar =
          '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">'
        +   '<label style="color:var(--text-3);font-size:.85rem;font-weight:600">📂 Project:</label>'
        +   '<span class="user-project-filter-trigger dd-trigger" onclick="admin.toggleUserProjectFilter(event)" '
        +     'style="cursor:pointer;min-width:200px;' + (hasActive ? 'border-color:var(--accent-soft-border);color:var(--accent);' : '') + '">'
        +     '<span class="dd-trigger-label">' + escapeHtml(filterLabel) + '</span>'
        +     '<span class="dd-trigger-chevron">' + filterChevron + '</span>'
        +   '</span>'
        +   '<span style="color:var(--text-3);font-size:.78rem">'
        +     (hasActive
                ? tf('lbl.showingUsersFiltered', { shown: users.length, total: totalUsers }, '· แสดง {shown} จาก {total} users')
                : tf('lbl.showingUsersTotal', { shown: users.length, total: totalUsers }, '· แสดง {shown}/{total} users'))
        +   '</span>'
        + '</div>';

      if (users.length === 0) {
        if (tableEl) tableEl.innerHTML = filterBar
          + '<div style="padding:32px;text-align:center;color:var(--text-3);font-size:.85rem;'
          + 'background:var(--surface-2);border:1px dashed var(--border-default);border-radius:10px">'
          + '👤 ' + (hasActive ? t('empty.noUsersMatchFilter', 'ไม่พบ user ที่ตรงกับตัวกรอง') : t('empty.noUsersSystem', 'ยังไม่มี user ในระบบ'))
          + '</div>';
        return;
      }

      // —— Column header strip (above the rows) ——
      var gridCols = 'auto 1.4fr 1.2fr .8fr auto auto';
      var headerStrip =
          '<div style="display:grid;grid-template-columns:' + gridCols + ';'
        + 'gap:14px;padding:10px 16px;font-size:.66rem;color:var(--text-3);'
        + 'text-transform:uppercase;letter-spacing:.05em;font-weight:700;'
        + 'border-bottom:1px solid var(--border-subtle)">'
        +   '<div style="width:38px"></div>'                  // avatar column placeholder
        +   '<div>Username / Name</div>'
        +   '<div>Project</div>'
        +   '<div>Created</div>'
        +   '<div style="min-width:78px;text-align:center">Status</div>'
        +   '<div style="width:36px"></div>'                  // action column placeholder
        + '</div>';

      // —— Member rows ——
      var rows = users.map(function (u, idx) {
        var fullName = ((u.name || '') + ' ' + (u.surname || '')).trim() || '—';
        var projectName = self._projectNameById(u.projectId) || '—';
        var statusBadge = self._renderStatusBadge(u.accStatus, u.username);
        var created = u.createdAt ? formatDateStd(u.createdAt).split(' ')[0] : '—';
        var initial = (fullName !== '—' ? fullName : u.username || '?').charAt(0).toUpperCase();
        return '<div style="display:grid;grid-template-columns:' + gridCols + ';'
          + 'gap:14px;align-items:center;padding:12px 16px;'
          + (idx > 0 ? 'border-top:1px solid var(--border-subtle);' : '') + '">'
          // Avatar
          + '<div style="width:38px;height:38px;border-radius:50%;background:var(--accent-soft-bg);'
          +   'color:var(--accent);font-weight:700;font-size:.95rem;'
          +   'display:flex;align-items:center;justify-content:center;'
          +   'border:1px solid var(--accent-soft-border)">' + escapeHtml(initial) + '</div>'
          // Username + Name
          + '<div style="min-width:0">'
          +   '<div style="font-weight:600;color:var(--text-1);font-size:.88rem;'
          +     'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(u.username) + '</div>'
          +   '<div style="font-size:.74rem;color:var(--text-3);margin-top:1px;'
          +     'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(fullName) + '</div>'
          + '</div>'
          // Project
          + '<div style="font-size:.84rem;color:var(--text-2);min-width:0;'
          +   'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'
          +   (u.projectId ? '📂 ' + escapeHtml(projectName) : '<span style="opacity:.5">— No project —</span>')
          + '</div>'
          // Created
          + '<div style="font-size:.82rem;color:var(--text-3);font-family:Geist Mono,monospace">' + created + '</div>'
          // Status badge
          + '<div style="min-width:78px;text-align:center">' + statusBadge + '</div>'
          // Action
          + '<button class="btn-icon-edit" title="Edit user" aria-label="Edit user ' + escapeHtml(u.username) + '" '
          +   'onclick="admin.openEditUser(\'' + escapeHtml(u.username) + '\')">'
          +   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
          +   '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>'
          + '</button>'
          + '</div>';
      }).join('');

      if (tableEl) tableEl.innerHTML = filterBar
        + '<div style="background:var(--surface-2);border:1px solid var(--border-default);'
        + 'border-radius:10px;overflow:hidden">'
        + headerStrip + rows
        + '</div>';
    });
  },

  _projectNameById: function (id) {
    if (!id) return '';
    var list = this._cachedDBProjects || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i].name;
    return id;
  },

  _renderStatusBadge: function (status, username) {
    // Map acc_status text -> coloured pill matching the mockup.
    //   active   -> green     inactive -> muted gray     locked -> red
    // Phase 16.8: badge is now clickable — calls toggleUserStatus(username).
    // We pass username (not userId) because table cells already work in
    // username-keyed scope and the cached user list is keyed the same way.
    var s = String(status || 'active').toLowerCase();
    var label = s.charAt(0).toUpperCase() + s.slice(1);
    // Phase 16.8.1: 'inactive' switched from muted gray to red — admins want
    // it to read as a clear "this account is OFF". 'locked' keeps the same
    // red since it also means "blocked from login"; the label text on the
    // pill (Inactive vs Locked) is what distinguishes them.
    var colors = {
      active:   { bg: 'rgba(55,179,74,0.10)',   fg: '#3fa64d', bd: 'rgba(55,179,74,0.30)' },
      inactive: { bg: 'rgba(220,53,69,0.10)',   fg: '#e25563', bd: 'rgba(220,53,69,0.30)' },
      locked:   { bg: 'rgba(220,53,69,0.10)',   fg: '#e25563', bd: 'rgba(220,53,69,0.30)' },
    };
    var c = colors[s] || colors.inactive;
    var titleAttr = s === 'locked'
      ? 'title="' + escapeHtml(t('tt.lockedUser', 'ถูก lock จาก failed login — เปิด Edit User เพื่อปลดล็อก')) + '"'
      : 'title="' + escapeHtml(s === 'active' ? t('tt.clickToDisable', 'คลิกเพื่อปิดการใช้งาน') : t('tt.clickToEnable', 'คลิกเพื่อเปิดการใช้งาน')) + '"';
    var onclick = username
      ? 'onclick="admin.toggleUserStatus(\'' + escapeHtml(username) + '\', event)"'
      : '';
    return '<span ' + onclick + ' ' + titleAttr
      + ' style="display:inline-block;padding:3px 10px;border-radius:10px;'
      + 'background:' + c.bg + ';color:' + c.fg + ';border:1px solid ' + c.bd + ';'
      + 'font-size:.74rem;font-weight:600;'
      + (username ? 'cursor:pointer;user-select:none;' : '')
      + 'transition:transform .12s ease, opacity .12s ease"'
      + ' onmouseover="this.style.transform=\'translateY(-1px)\'"'
      + ' onmouseout="this.style.transform=\'\'">'
      + escapeHtml(label) + '</span>';
  },

  // Phase 16.8: badge click → custom confirm modal (no more browser confirm()).
  // Pending action stash so confirmStatusToggle() knows what to PUT.
  _pendingStatusToggle: null,    // { user, next:'active'|'inactive', nextId:1|2 }

  toggleUserStatus: function (username, ev) {
    if (ev) ev.stopPropagation();
    var u = (this._cachedDBUsers || []).find(function (x) { return x.username === username; });
    if (!u) { flash('❌ ' + t('err.userNotFound', 'ไม่พบ user'), 'error'); return; }
    var current = String(u.accStatus || 'active').toLowerCase();

    // Decide next state + theme. Toggling TO 'locked' manually is intentionally
    // not offered here — locked is reached only via failed-login policy. Admin
    // can still lock through Edit User modal if they really need to.
    var theme, next, nextId, title, explain, btnClass, btnText;
    if (current === 'active') {
      theme = 'warning';
      next = 'inactive'; nextId = 2;
      title = t('modal.disableUser.title', '⏸ ปิดการใช้งาน User');
      explain = t('modal.disableUser.body', 'ผู้ใช้จะ login ไม่ได้จนกว่าจะถูกเปิดอีกครั้ง<br>Session ที่กำลังเปิดอยู่จะยังคงใช้งานได้จนกว่าจะหมดอายุ');
      btnClass = 'btn-modal-warning';
      btnText = t('btn.disableAction', 'ปิดการใช้งาน');
    } else if (current === 'inactive') {
      theme = 'success';
      next = 'active'; nextId = 1;
      title = t('modal.enableUser.title', '▶ เปิดใช้งาน User');
      explain = t('modal.enableUser.body', 'ผู้ใช้จะกลับมา login ได้ตามปกติ');
      btnClass = 'btn-modal-success';
      btnText = t('btn.enableAction', 'เปิดใช้งาน');
    } else if (current === 'locked') {
      theme = 'info';
      next = 'active'; nextId = 1;
      title = t('modal.unlockUser.title', '🔓 ปลดล็อก User');
      explain = t('modal.unlockUser.body', 'บัญชีนี้ถูก lock จาก failed login attempts<br>การยืนยันจะเคลียร์ failed-attempt counter และเปิดใช้งานต่อ');
      btnClass = 'btn-modal-info';
      btnText = t('btn.unlockAction', 'ปลดล็อก');
    } else {
      flash('❌ unknown status: ' + current, 'error'); return;
    }

    // Theme the target box border/bg to match the action mood
    var boxColors = {
      warning: { bg: 'rgba(240,160,64,0.06)',  bd: 'rgba(240,160,64,0.25)' },
      success: { bg: 'rgba(63,166,77,0.06)',   bd: 'rgba(63,166,77,0.25)' },
      info:    { bg: 'rgba(74,123,214,0.06)',  bd: 'rgba(74,123,214,0.25)' },
    }[theme];

    // Stash pending action so confirm handler can find it
    this._pendingStatusToggle = { user: u, next: next, nextId: nextId };

    // Populate modal
    document.getElementById('cts-title').textContent = title;
    document.getElementById('cts-username').textContent = '@' + u.username;
    document.getElementById('cts-displayname').textContent =
      ((u.name || '') + ' ' + (u.surname || '')).trim() || '—';
    document.getElementById('cts-current').innerHTML =
      this._renderStatusBadge(current, null);
    document.getElementById('cts-next').innerHTML =
      this._renderStatusBadge(next, null);
    document.getElementById('cts-explain').innerHTML = explain;
    document.getElementById('cts-error').textContent = '';
    var target = document.getElementById('cts-target');
    target.style.background = boxColors.bg;
    target.style.border = '1px solid ' + boxColors.bd;
    var btn = document.getElementById('cts-confirm-btn');
    btn.className = btnClass;
    btn.textContent = btnText;
    btn.disabled = false;

    showModal('modal-confirm-status-toggle');
  },

  confirmStatusToggle: function () {
    var p = this._pendingStatusToggle;
    if (!p) return;
    var self = this;
    var btn = document.getElementById('cts-confirm-btn');
    var errEl = document.getElementById('cts-error');
    btn.disabled = true;
    errEl.textContent = '';

    fetch(BASE + '/api/users/' + p.user.id, {
      method: 'PUT',
      headers: Auth.authHeaders(),
      body: JSON.stringify({ accStatusId: p.nextId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = '❌ ' + (d.error || 'update failed'); btn.disabled = false; return; }
        // Update the cached user so subsequent badge clicks see the new state
        // without waiting for the re-fetch.
        p.user.accStatus = p.next;
        p.user.accStatusId = p.nextId;
        hideModal('modal-confirm-status-toggle');
        flash('✅ ' + tf('msg.statusChanged', { username: p.user.username, status: p.next }, '@{username} → {status}'));
        self._pendingStatusToggle = null;
        self.renderUsers();
      })
      .catch(function (e) {
        errEl.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        btn.disabled = false;
      });
  },

  // ── Project filter dropdown (multi-select with search + Done) ──
  _renderProjectFilterHeader: function () {
    var filter = this._userProjectFilter;
    var hasActive = filter && filter.size > 0;
    var label = hasActive ? ('Project (' + filter.size + ')') : 'Project';
    return '<span class="user-project-filter-trigger" onclick="admin.toggleUserProjectFilter(event)" '
      + 'style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;'
      + (hasActive ? 'color:#5a7fff' : '') + '">'
      + escapeHtml(label) + ' <span style="font-size:.7rem">▼</span></span>';
  },

  toggleUserProjectFilter: function (ev) {
    if (ev) ev.stopPropagation();
    var existing = document.getElementById('user-project-filter-popup');
    var trigger = ev && ev.target && ev.target.closest
      ? ev.target.closest('.user-project-filter-trigger')
      : document.querySelector('.user-project-filter-trigger');
    if (existing) {
      existing.remove();
      if (trigger) trigger.classList.remove('dd-open');
      return;
    }
    if (!trigger) return;

    var projects = (this._cachedDBProjects || []).slice();
    projects.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });

    var current = this._userProjectFilter ? new Set(this._userProjectFilter) : new Set();
    var rect = trigger.getBoundingClientRect();
    // Phase 16.25: re-use the generic .dd-popup styling so this multi-select
    // matches every other dropdown in the app. The only thing different from
    // the single-select helper is the "Done" footer (multi-select needs an
    // explicit apply); we render checkbox items via custom .dd-item markup.
    var pop = document.createElement('div');
    pop.id = 'user-project-filter-popup';
    pop.className = 'dd-popup';
    pop.style.top   = (window.scrollY + rect.bottom + 6) + 'px';
    pop.style.left  = (window.scrollX + rect.left) + 'px';
    pop.style.width = Math.max(rect.width, 260) + 'px';

    pop.innerHTML =
        '<input type="text" id="user-pf-search" class="dd-search" placeholder="🔎 Search project..."/>'
      + '<div id="user-pf-list" class="dd-list"></div>'
      + '<div style="display:flex;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border-subtle)">'
      +   '<button onclick="admin._clearUserProjectFilter()" '
      +     'style="flex:0 0 auto;padding:7px 14px;font-size:.78rem;background:transparent;'
      +     'border:1px solid var(--border-default);color:var(--text-2);border-radius:6px;cursor:pointer;'
      +     'font-weight:500;font-family:inherit;transition:background .12s">Clear</button>'
      +   '<button onclick="admin._applyUserProjectFilter()" '
      +     'style="flex:1;padding:7px 14px;font-size:.82rem;background:var(--accent);color:var(--text-on-accent);'
      +     'border:1px solid var(--accent);border-radius:6px;cursor:pointer;font-weight:600;font-family:inherit;'
      +     'transition:background .12s">Done</button>'
      + '</div>';

    document.body.appendChild(pop);
    trigger.classList.add('dd-open');

    // Custom check icon shown only on selected rows (matches generic dd style).
    var checkSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" style="flex-shrink:0;color:var(--accent)">'
                 + '<polyline points="20 6 9 17 4 12"/></svg>';

    function renderList(searchTerm) {
      var listEl = document.getElementById('user-pf-list');
      if (!listEl) return;
      var q = (searchTerm || '').trim().toLowerCase();
      var items = [{ id: '__none__', name: '— No project —', _all: true }].concat(projects);
      if (q) items = items.filter(function (p) { return p._all || (p.name || '').toLowerCase().indexOf(q) !== -1; });
      if (items.length === 0) {
        listEl.innerHTML = '<div class="dd-empty">No match</div>';
        return;
      }
      listEl.innerHTML = items.map(function (p, idx) {
        var sel = current.has(String(p.id));
        var divider = (p._all && items.length > 1) ? '<div class="dd-divider"></div>' : '';
        var emoji = p._all ? '' : '📂 ';
        return '<div class="dd-item' + (sel ? ' dd-selected' : '') + '" '
          + 'data-pid="' + escapeHtml(String(p.id)) + '" '
          + 'onclick="admin._toggleUserPfItem(this)" '
          + 'style="cursor:pointer">'
          // Checkbox-style indicator (square outline filled when selected)
          + '<span style="width:16px;height:16px;border-radius:4px;'
          +   'border:1.5px solid ' + (sel ? 'var(--accent)' : 'var(--border-strong)') + ';'
          +   'background:' + (sel ? 'var(--accent)' : 'transparent') + ';'
          +   'display:flex;align-items:center;justify-content:center;flex-shrink:0;'
          +   'transition:all .12s">'
          +   (sel ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>' : '')
          + '</span>'
          + '<span style="flex:1">' + emoji
          + (p._all ? '<span style="color:var(--text-3)">' + escapeHtml(p.name) + '</span>' : escapeHtml(p.name))
          + '</span>'
          + '</div>' + divider;
      }).join('');
    }
    renderList('');
    pop._selected = current;

    var search = document.getElementById('user-pf-search');
    if (search) {
      search.focus();
      search.addEventListener('input', function () { renderList(search.value); });
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          pop.remove();
          if (trigger) trigger.classList.remove('dd-open');
        }
      });
    }

    setTimeout(function () {
      function onDocClick(e) {
        var p = document.getElementById('user-project-filter-popup');
        if (!p) { document.removeEventListener('mousedown', onDocClick); return; }
        if (!p.contains(e.target) && !e.target.closest('.user-project-filter-trigger')) {
          p.remove();
          if (trigger) trigger.classList.remove('dd-open');
          document.removeEventListener('mousedown', onDocClick);
        }
      }
      document.addEventListener('mousedown', onDocClick);
    }, 0);
  },

  _toggleUserPfItem: function (el) {
    // Phase 16.25: items are now <div> rows (not <input checkbox>) so we
    // toggle the dd-selected class + re-render the chip to reflect state.
    var pop = document.getElementById('user-project-filter-popup');
    if (!pop || !pop._selected) return;
    var pid = el.getAttribute('data-pid');
    if (pop._selected.has(pid)) pop._selected.delete(pid);
    else                        pop._selected.add(pid);
    // Visual feedback without rebuilding the entire list: toggle class +
    // swap the inner checkbox-style indicator on this row only.
    var nowSelected = pop._selected.has(pid);
    el.classList.toggle('dd-selected', nowSelected);
    var box = el.querySelector('span');
    if (box) {
      box.style.borderColor = nowSelected ? 'var(--accent)' : 'var(--border-strong)';
      box.style.background  = nowSelected ? 'var(--accent)' : 'transparent';
      box.innerHTML = nowSelected
        ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg>'
        : '';
    }
  },

  _applyUserProjectFilter: function () {
    var pop = document.getElementById('user-project-filter-popup');
    if (pop && pop._selected) this._userProjectFilter = pop._selected;
    if (pop) pop.remove();
    var trigger = document.querySelector('.user-project-filter-trigger');
    if (trigger) trigger.classList.remove('dd-open');
    this.renderUsers();
  },

  _clearUserProjectFilter: function () {
    this._userProjectFilter = null;
    var pop = document.getElementById('user-project-filter-popup');
    if (pop) pop.remove();
    var trigger = document.querySelector('.user-project-filter-trigger');
    if (trigger) trigger.classList.remove('dd-open');
    this.renderUsers();
  },

  // ── EDIT USER MODAL (Phase 16.4) ───────────────────────
  // Centralises all per-user actions that used to live inline in the table:
  //   project assignment, balance, daily cap, account status, reset password, delete.
  openEditUser: function (username) {
    var u = (this._cachedDBUsers || []).find(function (x) { return x.username === username; });
    if (!u) { flash('❌ ' + t('err.userNotFound', 'ไม่พบ user'), 'error'); return; }

    // Identity card
    document.getElementById('eu-username').value = username;
    document.getElementById('eu-username-display').textContent = username;
    document.getElementById('eu-userid-display').textContent =
      'user id ' + (u.id != null ? u.id : '—');
    var ava = document.getElementById('eu-avatar');
    if (ava) ava.textContent = (u.name || u.username || '?').charAt(0).toUpperCase();

    // Phase 21.5: editable name + surname (was display-only "name-display")
    document.getElementById('eu-name').value    = u.name    || '';
    document.getElementById('eu-surname').value = u.surname || '';

    // Phase 16.14: hidden input + dd-trigger label (custom dropdown).
    var projects = this._cachedDBProjects || [];
    var projectId = u.projectId ? String(u.projectId) : '';
    document.getElementById('eu-project').value = projectId;
    var projObj = projects.find(function (p) { return String(p.id) === projectId; });
    document.getElementById('eu-project-label').textContent =
      projObj ? ('📂 ' + projObj.name) : t('dd.noProjectAssigned', '— ไม่มี Project —');

    var status = String(u.accStatus || 'active').toLowerCase();
    document.getElementById('eu-status').value = status;
    document.getElementById('eu-status-label').textContent =
      status.charAt(0).toUpperCase() + status.slice(1);

    // Phase 21.10: daily cap is managed on the dedicated Cap Management page
    // (Credits tab), NOT here — this modal is identity/profile only.

    document.getElementById('eu-error').textContent = '';
    showModal('modal-edit-user');
  },

  // Project dropdown for Edit User modal
  openEditUserProjectDropdown: function (ev) {
    if (ev) ev.stopPropagation();
    var projects = (this._cachedDBProjects || []).slice()
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    this.openDropdown('eu-project-trigger', {
      items: projects.map(function (p) { return { value: p.id, label: p.name, emoji: '📂' }; }),
      selected: document.getElementById('eu-project').value || '',
      searchable: true,
      placeholder: t('dd.searchProject', '🔎 ค้นหา project...'),
      allowEmpty: { label: t('dd.noProjectAssigned', '— ไม่มี Project —') },
      onPick: function (value, item) {
        document.getElementById('eu-project').value = value || '';
        document.getElementById('eu-project-label').textContent =
          item && !item._all ? ('📂 ' + item.label) : t('dd.noProjectAssigned', '— ไม่มี Project —');
      },
    });
  },

  // Status dropdown for Edit User modal
  openEditUserStatusDropdown: function (ev) {
    if (ev) ev.stopPropagation();
    this.openDropdown('eu-status-trigger', {
      items: [
        { value: 'active',   label: 'Active' },
        { value: 'inactive', label: 'Inactive' },
        { value: 'locked',   label: 'Locked' },
      ],
      selected: document.getElementById('eu-status').value || 'active',
      onPick: function (value, item) {
        document.getElementById('eu-status').value = value;
        document.getElementById('eu-status-label').textContent = item ? item.label
          : (value.charAt(0).toUpperCase() + value.slice(1));
      },
    });
  },

  submitEditUser: function () {
    var self = this;
    var username = document.getElementById('eu-username').value;
    var u = (this._cachedDBUsers || []).find(function (x) { return x.username === username; });
    if (!u) { document.getElementById('eu-error').textContent = '❌ ' + t('err.userNotFound', 'ไม่พบ user'); return; }

    // Phase 21.5: identity-only updates (name, surname, project, status).
    // Credit + dailyCap removed — they're handled in Credit Management.
    var name      = document.getElementById('eu-name').value.trim();
    var surname   = document.getElementById('eu-surname').value.trim();
    var projectId = document.getElementById('eu-project').value || null;
    var status    = document.getElementById('eu-status').value;
    var errEl     = document.getElementById('eu-error');
    errEl.textContent = '';

    if (!name)    { errEl.textContent = '❌ ' + t('err.enterFirstname', 'กรุณากรอกชื่อ');     return; }
    if (!surname) { errEl.textContent = '❌ ' + t('err.enterLastname', 'กรุณากรอกนามสกุล');  return; }
    if (name.length    > 50) { errEl.textContent = '❌ ' + t('err.firstnameTooLong', 'ชื่อยาวเกินไป (สูงสุด 50)');    return; }
    if (surname.length > 50) { errEl.textContent = '❌ ' + t('err.lastnameTooLong', 'นามสกุลยาวเกินไป (สูงสุด 50)'); return; }

    var statusIdMap = { active: 1, inactive: 2, locked: 3 };
    var accStatusId = statusIdMap[status] || 1;

    fetch(BASE + '/api/users/' + u.id, {
      method: 'PUT',
      headers: Auth.authHeaders(),
      body: JSON.stringify({
        name:        name,
        surname:     surname,
        projectId:   projectId,
        accStatusId: accStatusId,
      }),
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || 'PUT user failed');
        hideModal('modal-edit-user');
        flash('✅ ' + tf('msg.userSaved', { username: username }, 'บันทึก user @{username} เรียบร้อย'));
        self.renderUsers();
      })
      .catch(function (e) { errEl.textContent = '❌ ' + (e.message || 'error'); });
  },

  // Phase 16.5 → Phase 19.3: clear the stored API key for a project.
  // Now uses an in-app modal (not window.confirm) to keep the look/feel
  // consistent with delete-user, delete-project, etc. The modal stores
  // the pending projectId so the confirm handler doesn't need a closure.
  _pendingClearApiKey: null,
  clearProjectApiKey: function (projectId) {
    var proj = (this._cachedDBProjects || []).find(function (p) { return p.id === projectId; });
    this._pendingClearApiKey = projectId;
    var setText = function (id, val) {
      var el = document.getElementById(id);
      if (el) el.textContent = val == null ? '—' : val;
    };
    setText('cak-name', proj ? (proj.name || projectId) : projectId);
    setText('cak-id', projectId);
    var err = document.getElementById('cak-error');
    if (err) err.textContent = '';
    var btn = document.getElementById('cak-confirm-btn');
    if (btn) { btn.disabled = false; btn.textContent = t('m.clearKey.btn', 'ลบ API key'); }
    showModal('modal-confirm-clear-apikey');
  },
  cancelClearApiKey: function () {
    this._pendingClearApiKey = null;
    hideModal('modal-confirm-clear-apikey');
  },
  confirmClearApiKey: function () {
    var projectId = this._pendingClearApiKey;
    if (!projectId) { hideModal('modal-confirm-clear-apikey'); return; }
    var self = this;
    var btn = document.getElementById('cak-confirm-btn');
    var err = document.getElementById('cak-error');
    if (btn) { btn.disabled = true; btn.textContent = t('btn.deletingEllipsis', 'กำลังลบ...'); }
    if (err) err.textContent = '';
    fetch(BASE + '/api/projects/' + encodeURIComponent(projectId), {
      method: 'PUT',
      headers: Auth.authHeaders(),
      body: JSON.stringify({ apiKey: null }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          if (err) err.textContent = '❌ ' + (d.error || 'clear failed');
          if (btn) { btn.disabled = false; btn.textContent = t('m.clearKey.btn', 'ลบ API key'); }
          return;
        }
        hideModal('modal-confirm-clear-apikey');
        self._pendingClearApiKey = null;
        flash('✅ ' + t('msg.apiKeyDeleted', 'ลบ API key เรียบร้อย'));
        self.fetchProjectsFromDB().then(function () {
          if (self.currentView === 'projects') self.renderProjects();
          var openModal = document.getElementById('modal-edit-project');
          if (openModal && openModal.classList.contains('show')) {
            self.openEditProject(projectId);
          }
        });
      })
      .catch(function (e) {
        if (err) err.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('m.clearKey.btn', 'ลบ API key'); }
      });
  },

  editUserResetPassword: function () {
    var username = document.getElementById('eu-username').value;
    if (username) this.resetPassword(username);
  },
  editUserDelete: function () {
    var username = document.getElementById('eu-username').value;
    if (username) {
      hideModal('modal-edit-user');
      this.deleteUser(username);
    }
  },

  // Phase 19.3: legacy in-row balance/daily-cap/project editors were
  // replaced by the unified Edit User modal in Phase 16.4. The functions
  // applyBalance / applyBalanceById / applyDailyCap / updateUserProject
  // were dead code (their DOM ids no longer exist) and have been removed.
  // openEditUser() is the single entry point for all of those edits now.

  // ── RESET PASSWORD (Phase 19.3: in-app modal + await response) ──
  // Flow:
  //   1. resetPassword(username) → populate + open #modal-reset-password
  //   2. admin types new pw, optional show/hide toggle
  //   3. confirmResetPassword() validates *client-side* (matches server
  //      policy: 8+ chars, must contain letter + digit) before PUTting,
  //      AWAITS the response, and only flashes ✅ once the DB confirmed.
  //   4. Cancel just hides the modal — no destructive side effects.
  //
  // Replaces the old browser prompt() flow which: used min-length 4 (server
  // enforces 8+), fire-and-forget the fetch, and flashed success even when
  // the server rejected the password. End result for admin was "looks ok"
  // but the user's password never actually changed.
  _pendingResetPw: null,

  resetPassword: function (username) {
    var users = this.getUsersWithHistory();
    var u = users.find(function (x) { return x.username === username; });
    if (!u || !u.id) { flash('❌ ' + t('err.userIdNotFound', 'ไม่พบ user_id (DB row)'), 'error'); return; }

    this._pendingResetPw = {
      username: u.username,
      id: u.id,
      displayName: u.displayName || '—',
    };

    var setText = function (id, val) {
      var el = document.getElementById(id);
      if (el) el.textContent = val == null ? '—' : val;
    };
    setText('rp-username', '@' + u.username);
    setText('rp-displayname', u.displayName || '—');

    var inp = document.getElementById('rp-password');
    if (inp) { inp.value = ''; inp.type = 'password'; }
    var tog = document.getElementById('rp-toggle');
    if (tog) tog.textContent = '👁';

    var err = document.getElementById('rp-error');
    if (err) err.textContent = '';
    var btn = document.getElementById('rp-confirm-btn');
    if (btn) { btn.disabled = false; btn.textContent = t('btn.savePlain', 'บันทึก'); }

    showModal('modal-reset-password');
    setTimeout(function () { if (inp) inp.focus(); }, 50);
  },

  toggleResetPwVisibility: function () {
    var inp = document.getElementById('rp-password');
    var tog = document.getElementById('rp-toggle');
    if (!inp || !tog) return;
    if (inp.type === 'password') {
      inp.type = 'text';
      tog.textContent = '🙈';
      tog.setAttribute('aria-pressed', 'true');   // visible
    } else {
      inp.type = 'password';
      tog.textContent = '👁';
      tog.setAttribute('aria-pressed', 'false');  // hidden
    }
  },

  cancelResetPassword: function () {
    this._pendingResetPw = null;
    hideModal('modal-reset-password');
  },

  // Mirrors server policy in validatePasswordStrength() — keep in sync.
  _validatePw: function (pw) {
    if (!pw || typeof pw !== 'string') return t('err.pwRequired', 'ต้องกรอกรหัสผ่าน');
    if (pw.length < 8)   return t('err.pwMin8Chars', 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
    if (pw.length > 128) return t('err.pwMax128', 'รหัสผ่านต้องไม่เกิน 128 ตัวอักษร');
    if (!/[A-Za-z]/.test(pw)) return t('err.pwNeedLetter', 'ต้องมีตัวอักษรอย่างน้อย 1 ตัว');
    if (!/[0-9]/.test(pw))    return t('err.pwNeedNumber', 'ต้องมีตัวเลขอย่างน้อย 1 ตัว');
    return null;
  },

  confirmResetPassword: function () {
    var pending = this._pendingResetPw;
    if (!pending) { hideModal('modal-reset-password'); return; }
    var inp = document.getElementById('rp-password');
    var err = document.getElementById('rp-error');
    var btn = document.getElementById('rp-confirm-btn');
    var pw = inp ? inp.value : '';

    var msg = this._validatePw(pw);
    if (msg) { if (err) err.textContent = '❌ ' + msg; return; }

    if (err) err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = t('btn.savingEllipsis', 'กำลังบันทึก...'); }

    // Reuse the user-update endpoint. We MUST send the other fields the
    // server expects (displayName, role, plan, balance, projectId) — fetch
    // a fresh copy first so we don't accidentally overwrite values that
    // changed since the table render.
    var users = this.getUsersWithHistory();
    var u = users.find(function (x) { return x.id === pending.id; });
    if (!u) {
      if (err) err.textContent = '❌ ' + t('err.userNotFoundRefresh', 'ไม่พบ user (โปรด refresh แล้วลองใหม่)');
      if (btn) { btn.disabled = false; btn.textContent = t('btn.savePlain', 'บันทึก'); }
      return;
    }

    var self = this;
    fetch(BASE + '/api/users/' + u.id, {
      method: 'PUT',
      headers: Auth.authHeaders(),
      body: JSON.stringify({
        displayName: u.displayName,
        role:        u.role || 'user',
        plan:        u.plan || 'starter',
        balance:     u.balance,
        projectId:   u.projectId,
        password:    pw,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          if (err) err.textContent = '❌ ' + (d.error || t('err.dbRejectedShort', 'DB ปฏิเสธ'));
          if (btn) { btn.disabled = false; btn.textContent = t('btn.savePlain', 'บันทึก'); }
          return;
        }
        hideModal('modal-reset-password');
        self._pendingResetPw = null;
        flash('✅ ' + tf('msg.pwReset', { username: pending.username }, 'รีเซ็ตรหัสผ่านของ @{username} เรียบร้อย'));
      })
      .catch(function (e) {
        if (err) err.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('btn.savePlain', 'บันทึก'); }
      });
  },

  // ── DELETE USER (Phase 14.1: in-app modal + real-time refresh) ──
  // Flow:
  //   1. deleteUser(username)   → populate + open #modal-confirm-delete-user
  //   2. user clicks "ลบถาวร"  → confirmDeleteUser() runs DELETE, AWAITS
  //      the response, then re-fetches DB via renderUsers() so the row
  //      disappears from the table without a page refresh.
  //   3. user clicks "ยกเลิก"   → cancelDeleteUser() just hides the modal.
  //
  // _pendingDelete holds { username, id, displayName, role, balance } while
  // the modal is open so confirmDeleteUser() doesn't need another lookup.
  _pendingDelete: null,

  deleteUser: function (username) {
    var users = this.getUsersWithHistory();
    var u = users.find(function (x) { return x.username === username; });
    if (!u || !u.id) { flash('❌ ' + t('err.userIdNotFound', 'ไม่พบ user_id (DB row)'), 'error'); return; }

    this._pendingDelete = {
      username: u.username,
      id: u.id,
      displayName: u.displayName || '—',
      role: u.role || '—',
      balance: u.balance,
    };

    // Populate modal body
    var set = function (id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
    set('cd-username',    '@' + u.username);
    set('cd-displayname', u.displayName || '—');
    set('cd-role',        (u.role || '—').toUpperCase());
    set('cd-balance',     formatTHB(u.balance));

    var err = document.getElementById('cd-error');
    if (err) err.textContent = '';
    var btn = document.getElementById('cd-confirm-btn');
    if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }

    showModal('modal-confirm-delete-user');
  },

  cancelDeleteUser: function () {
    this._pendingDelete = null;
    hideModal('modal-confirm-delete-user');
  },

  confirmDeleteUser: function () {
    var self = this;
    var p = this._pendingDelete;
    if (!p) { hideModal('modal-confirm-delete-user'); return; }

    var btn = document.getElementById('cd-confirm-btn');
    var err = document.getElementById('cd-error');
    if (err) err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = t('btn.deletingEllipsis', 'กำลังลบ...'); }

    fetch(BASE + '/api/users/' + p.id, {
      method: 'DELETE',
      headers: Auth.authHeaders(),
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
      .then(function (res) {
        if (!res.body || !res.body.ok) {
          var msg = (res.body && res.body.error) || ('HTTP ' + res.status);
          if (err) err.textContent = '❌ ' + msg;
          if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }
          return;
        }
        // Mirror to legacy localStorage store so any non-DB code path stays in sync
        try { Auth.deleteUser(p.username); } catch (_) {}
        self._pendingDelete = null;
        hideModal('modal-confirm-delete-user');
        flash('✅ ' + tf('msg.userDeleted', { username: p.username }, 'ลบ @{username} แล้ว'));
        // Real-time refresh: re-fetch users from DB and re-render table.
        // renderUsers() already calls fetchUsersFromDB() internally, so the
        // soft-deleted row (is_deleted=TRUE) is filtered out server-side.
        self.renderUsers();
        self.refreshProjectSelects();
        // Also refresh overview tile counts if we happen to be on overview
        if (self.currentView === 'overview') self.renderOverview();
      })
      .catch(function (e) {
        if (err) err.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }
      });
  },

  // ── ADD USER (modal) ──────────────────────────────────
  openAddUser: function () {
    ['au-username', 'au-password', 'au-confirm', 'au-firstname', 'au-lastname'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    var cap = document.getElementById('au-dailycap');
    if (cap) cap.value = '50';   // sensible default daily cap; clear for unlimited
    var hint = document.getElementById('au-pw-hint');
    if (hint) { hint.style.color = '#555'; hint.textContent = t('hint.pwPolicy', 'Must be 8 or more characters and contain at least 1 number (0-9) and 1 upper case letter (A-Z)'); }
    document.getElementById('au-error').textContent = '';
    // Phase 16.14: reset hidden project input + label (custom dropdown)
    var pf = document.getElementById('au-project');
    if (pf) pf.value = '';
    var pl = document.getElementById('au-project-label');
    if (pl) pl.textContent = t('dd.selectProject', '— เลือก Project —');
    showModal('modal-add-user');
  },

  openAddUserProjectDropdown: function (ev) {
    if (ev) ev.stopPropagation();
    var projects = (this._cachedDBProjects || []).slice()
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    this.openDropdown('au-project-trigger', {
      items: projects.map(function (p) { return { value: p.id, label: p.name, emoji: '📂' }; }),
      selected: document.getElementById('au-project').value || '',
      searchable: true,
      placeholder: t('dd.searchProject', '🔎 ค้นหา project...'),
      allowEmpty: { label: t('dd.selectProject', '— เลือก Project —') },
      onPick: function (value, item) {
        document.getElementById('au-project').value = value || '';
        document.getElementById('au-project-label').textContent =
          item && !item._all ? ('📂 ' + item.label) : t('dd.selectProject', '— เลือก Project —');
      },
    });
  },

  submitAddUser: function () {
    var username = document.getElementById('au-username').value.trim();
    var password = document.getElementById('au-password').value;
    var confirm = document.getElementById('au-confirm').value;
    var firstname = document.getElementById('au-firstname').value.trim();
    var lastname = document.getElementById('au-lastname').value.trim();
    var projectId = document.getElementById('au-project').value;
    var capRaw = document.getElementById('au-dailycap').value.trim();
    var dailyCap = capRaw === '' ? null : parseFloat(capRaw);   // blank = no cap (unlimited)
    var errEl = document.getElementById('au-error');

    if (!username) { errEl.textContent = '❌ ' + t('err.enterUsername', 'กรุณากรอก Username'); return; }
    if (!firstname || !lastname) { errEl.textContent = '❌ ' + t('err.enterNameSurname', 'กรุณากรอก Name และ Surname'); return; }
    if (!projectId) { errEl.textContent = '❌ ' + t('err.selectProject', 'กรุณาเลือก Project'); return; }
    if (password.length < 8) { errEl.textContent = '❌ ' + t('err.pwMin8', 'Password ต้องมีอย่างน้อย 8 ตัว'); return; }
    if (!/[A-Z]/.test(password)) { errEl.textContent = '❌ ' + t('err.pwUpper', 'Password ต้องมีตัวพิมพ์ใหญ่อย่างน้อย 1 ตัว'); return; }
    if (!/[0-9]/.test(password)) { errEl.textContent = '❌ ' + t('err.pwNumber', 'Password ต้องมีตัวเลขอย่างน้อย 1 ตัว'); return; }
    if (password !== confirm) { errEl.textContent = '❌ ' + t('err.pwMismatch', 'Password ไม่ตรงกัน'); return; }
    if (dailyCap !== null && (!isFinite(dailyCap) || dailyCap < 0)) {
      errEl.textContent = '❌ ' + t('err.dailyCapInvalid2', 'Daily Cap ต้องเป็นตัวเลข ≥ 0 หรือเว้นว่าง (= ไม่จำกัด)'); return;
    }

    var self = this;
    var displayName = firstname + ' ' + lastname;
    var safeUsername = username.toLowerCase().replace(/[^a-z0-9._@+\-]/g, '_');

    // ── Save to PostgreSQL ─────────────────────────────
    // projectId is a VARCHAR in DB (e.g. 'proj_sap_dev') — don't parseInt!
    // createUser schema requires string or omitted (null is rejected), so
    // build the payload conditionally: include projectId only when truthy.
    var payload = {
      username: safeUsername, password: password, displayName: displayName,
      dailyCap: dailyCap,   // Concept B: per-user daily limit (null = unlimited)
    };
    if (projectId) payload.projectId = projectId;

    fetch(BASE + '/api/users', {
      method: 'POST',
      headers: Auth.authHeaders(),
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { errEl.textContent = '❌ ' + (data.error || t('err.createUserFailed', 'ไม่สามารถสร้าง user ได้')); return; }
        hideModal('modal-add-user');
        flash('✅ ' + tf('msg.userCreated', { name: displayName, username: safeUsername }, 'สร้าง user "{name}" (@{username}) เรียบร้อย'));
        self.renderUsers();
        self.refreshProjectSelects();
      })
      .catch(function (e) { errEl.textContent = '❌ Server error: ' + e.message; });
  },

  // ── Password Helpers ──────────────────────────────────
  generatePassword: function () {
    var upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    var lower = 'abcdefghjkmnpqrstuvwxyz';
    var digits = '23456789';
    var special = '@#$!';
    var all = upper + lower + digits + special;
    var pw = '';
    pw += upper[Math.floor(Math.random() * upper.length)];
    pw += digits[Math.floor(Math.random() * digits.length)];
    pw += special[Math.floor(Math.random() * special.length)];
    for (var i = 3; i < 12; i++) pw += all[Math.floor(Math.random() * all.length)];
    pw = pw.split('').sort(function () { return Math.random() - 0.5; }).join('');
    var pwEl = document.getElementById('au-password');
    var cfEl = document.getElementById('au-confirm');
    if (pwEl) { pwEl.value = pw; pwEl.type = 'text'; }
    if (cfEl) { cfEl.value = pw; cfEl.type = 'text'; }
    this.checkPwStrength();
    flash('🔑 Generated: ' + pw);
  },

  togglePw: function (inputId, eyeId) {
    var inp = document.getElementById(inputId);
    var eye = document.getElementById(eyeId);
    if (!inp) return;
    // Phase 19.5: also flip aria-pressed on the button so screen readers
    // know whether the password is currently visible.
    var btn = eye && eye.closest ? eye.closest('button') : null;
    if (inp.type === 'password') {
      inp.type = 'text';
      if (eye) eye.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>';
      if (btn) btn.setAttribute('aria-pressed', 'true');
    } else {
      inp.type = 'password';
      if (eye) eye.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
      if (btn) btn.setAttribute('aria-pressed', 'false');
    }
  },

  checkPwStrength: function () {
    var pw = (document.getElementById('au-password') || {}).value || '';
    var hint = document.getElementById('au-pw-hint');
    if (!hint) return;
    if (pw.length === 0) {
      hint.style.color = '#555';
      hint.textContent = t('hint.pwPolicy', 'Must be 8 or more characters and contain at least 1 number (0-9) and 1 upper case letter (A-Z)');
    } else if (pw.length < 8 || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) {
      hint.style.color = '#e05555';
      hint.textContent = '❌ ' + (pw.length < 8 ? t('pw.needMin8', 'ต้องมีอย่างน้อย 8 ตัว') : !/[A-Z]/.test(pw) ? t('pw.needUpper', 'ต้องมีตัวพิมพ์ใหญ่') : t('pw.needNumber', 'ต้องมีตัวเลข'));
    } else {
      hint.style.color = '#4ade80';
      hint.textContent = t('pw.strengthGood', '✅ Password strength: Good');
    }
  },

  copyToClipboard: function (inputId) {
    var inp = document.getElementById(inputId);
    if (!inp || !inp.value) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(inp.value)
        .then(function () { flash(t('msg.copiedClipboard', '📋 Copied to clipboard')); })
        .catch(function () { flash('❌ ' + t('err.copyFailed', 'ไม่สามารถ copy ได้')); });
    } else {
      inp.type = 'text';
      inp.select();
      try { document.execCommand('copy'); flash(t('msg.copiedClipboard', '📋 Copied to clipboard')); } catch (e) { flash('❌ ' + t('err.copyFailed', 'ไม่สามารถ copy ได้')); }
    }
  },

  pastePassword: function () {
    var pw = (document.getElementById('au-password') || {}).value;
    var conf = document.getElementById('au-confirm');
    if (conf && pw) { conf.value = pw; }
  },

  // ── PROJECTS ──────────────────────────────────────────
  renderProjects: function () {
    var self = this;
    var container = document.getElementById('project-list');
    if (container) container.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-3);font-size:.85rem">' + t('common.loadingProjectsDb', '⏳ กำลังโหลด projects จาก DB...') + '</div>';
    // Always pull fresh from DB so create/edit/delete reflect immediately
    this.fetchProjectsFromDB().then(function (projects) {
      self._renderProjectsHtml(projects, container);
    });
  },

  _renderProjectsHtml: function (projects, container) {
    var self = this;
    var users = this.getUsersWithHistory();

    if (projects.length === 0) {
      container.innerHTML = '<div class="glass-card" style="text-align:center;padding:48px 24px">'
        + '<div style="font-size:2.5rem;margin-bottom:12px">📂</div>'
        + '<div style="color:var(--text-3);font-size:0.9rem">' + t('empty.noProjectsHtml', 'ยังไม่มี Project<br>กดปุ่ม <strong style="color:var(--text-3)">+ Add Project</strong> เพื่อสร้างใหม่') + '</div>'
        + '</div>';
      return;
    }

    // Phase 16.21: Projects page redesign.
    //   - Hero with big folder icon + project name + click-to-copy project_id pill
    //   - Rate / member chips
    //   - 4 stat cards with icons + colored values
    //   - Edit/Delete buttons icon-only at hero top-right
    //
    // Phase 16.22: per-project member rows REMOVED — this page now focuses
    // strictly on project management (rate / budget / metadata). Per-user
    // credit & assignment lives in the dedicated User Management page and
    // the Credits page; surfacing it again here was redundant.
    // Phase 21.1: defensive Number coerce — same fix as renderProjectDetail.
    // localStorage / cache values can sometimes be the literal string "NaN"
    // or undefined, which then propagates through reduce() and surfaces as
    // "NaN" in the stat cards.
    var nz = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
    container.innerHTML = projects.map(function (p) {
      var members = users.filter(function (u) { return u.projectId === p.id; });
      var totalReq = members.reduce(function (s, u) {
          return s + ((u.history && u.history.length) || 0);
      }, 0);
      var totalTok = members.reduce(function (s, u) {
          return s + (u.history || []).reduce(function (ss, h) {
              return ss + nz(h.inputTokens) + nz(h.outputTokens);
          }, 0);
      }, 0);
      var totalCost = members.reduce(function (s, u) {
          return s + (u.history || []).reduce(function (ss, h) {
              return ss + nz(h.cost);
          }, 0);
      }, 0);
      var totalBal = members.reduce(function (s, u) { return s + nz(u.balance); }, 0);

      // —— Stat card helper ——
      var statCard = function (icon, label, value, valueColor) {
        return '<div style="padding:14px 16px;background:var(--surface-2);'
          + 'border:1px solid var(--border-default);border-radius:10px">'
          + '<div style="font-size:.66rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">' + icon + ' ' + label + '</div>'
          + '<div style="font-size:1.25rem;font-weight:700;color:' + valueColor + ';font-family:Geist Mono,monospace">' + value + '</div>'
          + '</div>';
      };

      // —— Hero header with project_id pill ——
      var hero =
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;'
        + 'gap:14px;padding-bottom:16px;margin-bottom:18px;border-bottom:1px solid var(--border-subtle)">'
        +   '<div style="flex:1;min-width:240px">'
        +     '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">'
        +       '<div style="font-size:1.15rem;font-weight:800;color:var(--text-1)">📂 ' + escapeHtml(p.name) + '</div>'
        // Click-to-copy project_id pill (matches Overview redesign)
        +       '<span title="' + escapeHtml(t('tt.clickToCopy', 'คลิกเพื่อ copy')) + '" '
        +         'onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + escapeHtml(p.id) + '\').then(()=>flash(\'✓ Copied: ' + escapeHtml(p.id) + '\'))" '
        +         'style="font-family:Geist Mono,monospace;font-size:.7rem;padding:3px 9px;'
        +         'background:var(--accent-soft-bg);color:var(--accent);'
        +         'border:1px solid var(--accent-soft-border);border-radius:6px;cursor:pointer">'
        +         escapeHtml(p.id) + '</span>'
        +       '<span style="font-size:.68rem;color:var(--text-2);padding:3px 10px;'
        +         'background:var(--surface-3);border:1px solid var(--border-default);'
        +         'border-radius:20px">👥 ' + members.length + ' member' + (members.length === 1 ? '' : 's') + '</span>'
        +     '</div>'
        +     '<div style="font-size:.84rem;color:var(--text-3);line-height:1.5;margin-bottom:10px">'
        +       (p.desc ? escapeHtml(p.desc) : '<span style="font-style:italic;opacity:.6">' + escapeHtml(t('lbl.noDescription', 'No description')) + '</span>')
        +     '</div>'
        +     '<div style="display:flex;gap:8px;flex-wrap:wrap">'
        +       '<span style="font-size:.7rem;padding:4px 10px;background:var(--surface-3);'
        +         'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)">'
        +         '📥 In <b>฿' + p.inputRate + '</b>/1K</span>'
        +       '<span style="font-size:.7rem;padding:4px 10px;background:var(--surface-3);'
        +         'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)">'
        +         '📤 Out <b>฿' + p.outputRate + '</b>/1K</span>'
        // Phase 20: split the single Budget chip into two — lifetime (sticky
        // monotone-increasing accumulator) and current balance (decreases on
        // spend). Lifetime is the headline for tier evaluation.
        +       '<span style="font-size:.7rem;padding:4px 10px;background:var(--surface-3);'
        +         'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)" title="' + escapeHtml(t('tt.lifetimeTopupHint', 'ยอดสะสมที่ลูกค้าเคยเติม (ไม่ลดลง)')) + '">'
        +         '💰 Lifetime <b>฿' + (p.lifetimeAmount || 0).toFixed(2) + '</b></span>'
        +       '<span style="font-size:.7rem;padding:4px 10px;background:var(--surface-3);'
        +         'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)" title="' + escapeHtml(t('tt.usableNowHint', 'ยอดคงเหลือใช้ได้ตอนนี้')) + '">'
        +         '🏦 Balance <b>฿' + (p.balance || 0).toFixed(2) + '</b></span>'
        +       (p.creditLimit ? ('<span style="font-size:.7rem;padding:4px 10px;background:var(--surface-3);'
                                  + 'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)">'
                                  + '⛔ Limit/user <b>฿' + p.creditLimit + '</b></span>') : '')
        +     '</div>'
        +   '</div>'
        // Icon-only Edit + Delete buttons
        +   '<div style="display:flex;gap:8px">'
        +     '<button class="btn-icon-action btn-icon-edit-large" title="' + escapeHtml(t('tt.editProject', 'แก้ไข Project')) + '" '
        +       'onclick="admin.openEditProject(\'' + p.id + '\')">'
        +       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
        +       '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>'
        +       '<span style="margin-left:6px;font-size:.78rem">' + escapeHtml(t('btn.edit', 'แก้ไข')) + '</span>'
        +     '</button>'
        +     '<button class="btn-icon-action btn-icon-danger-large" title="' + escapeHtml(t('tt.deleteProject', 'ลบ Project')) + '" '
        +       'onclick="admin.deleteProject(\'' + p.id + '\')">'
        +       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
        +       '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>'
        +       '<span style="margin-left:6px;font-size:.78rem">' + escapeHtml(t('btn.deletePlain', 'ลบ')) + '</span>'
        +     '</button>'
        +   '</div>'
        + '</div>';

      // —— Stats grid (last element on the card; no bottom margin) ——
      var statsGrid =
          '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">'
        +   statCard('📡', 'Requests',           totalReq.toLocaleString(),     'var(--text-1)')
        +   statCard('🔢', 'Tokens',             totalTok.toLocaleString(),     'var(--text-1)')
        +   statCard('💸', 'Cost Billed',        formatTHB(totalCost),          'var(--text-2)')
        +   statCard('🪙', 'Credit Outstanding', formatTHB(totalBal),
                     totalBal > 0 ? 'var(--success-hover, #34d399)' : 'var(--text-2)')
        + '</div>';

      // Phase 16.22: members list intentionally not rendered here.
      return '<div class="glass-card" style="margin-bottom:18px">'
        + hero
        + statsGrid
        + '</div>';
    }).join('');
  },

  openEditProject: function (projectId) {
    var p = Auth.getProjectById(projectId);
    if (!p) return;
    document.getElementById('ep-proj-id').value = projectId;
    document.getElementById('ep-name').value = p.name || '';
    document.getElementById('ep-desc').value = p.desc || '';
    document.getElementById('ep-input-rate').value = p.inputRate || 0.5;
    document.getElementById('ep-output-rate').value = p.outputRate || 1.5;
    document.getElementById('ep-credit-limit').value = p.creditLimit || 0;

    // Phase 16.2: API key field. We never display the stored secret — only
    // a status pill ("has key" / "no key"). The <input> always opens empty;
    // typing a new value overwrites the stored one, leaving it blank keeps
    // the old one (handled by COALESCE on the server).
    var keyEl    = document.getElementById('ep-api-key');
    var statusEl = document.getElementById('ep-api-key-status');
    if (keyEl) keyEl.value = '';
    if (statusEl) {
      // Phase 16.5: server redacts the secret. We get just `hasApiKey` (boolean)
      // and `apiKeyPreview` (e.g. "sk-svcac…XXXX") for display.
      var realKey = !!p.hasApiKey;
      statusEl.innerHTML = realKey
        ? '<span style="color:#5cb85c">✓</span> ' + escapeHtml(t('lbl.hasApiKey', 'มี API key อยู่แล้ว'))
            + ' <span style="color:var(--text-3);font-family:monospace">'
            + escapeHtml(p.apiKeyPreview || '') + '</span>'
            + ' <button type="button" onclick="admin.clearProjectApiKey(\''
            + escapeHtml(p.id) + '\')" style="margin-left:8px;padding:2px 8px;'
            + 'font-size:.7rem;background:transparent;color:#d04545;'
            + 'border:1px solid rgba(208,69,69,0.3);border-radius:4px;cursor:pointer">'
            + '🗑️ Clear</button>'
        : '<span style="color:#d09a3e">⚠</span> ' + escapeHtml(t('lbl.noApiKeyWarn', 'ยังไม่มี API key — chat router จะ fallback ไปใช้ global key'));
      statusEl.style.background = realKey
        ? 'rgba(92,184,92,0.08)' : 'rgba(208,154,62,0.10)';
      statusEl.style.border = realKey
        ? '1px solid rgba(92,184,92,0.25)' : '1px solid rgba(208,154,62,0.30)';
    }

    document.getElementById('ep-error').textContent = '';
    showModal('modal-edit-project');
  },

  submitEditProject: function () {
    var projectId = document.getElementById('ep-proj-id').value;
    var name = document.getElementById('ep-name').value.trim();
    var desc = document.getElementById('ep-desc').value.trim();
    var inputRate = parseFloat(document.getElementById('ep-input-rate').value);
    var outputRate = parseFloat(document.getElementById('ep-output-rate').value);
    var creditLit = parseFloat(document.getElementById('ep-credit-limit').value) || 0;
    var apiKeyEl = document.getElementById('ep-api-key');
    var apiKeyNew = apiKeyEl ? apiKeyEl.value.trim() : '';
    var errEl = document.getElementById('ep-error');

    if (!name) { errEl.textContent = '❌ ' + t('err.enterProjectName', 'กรุณาใส่ชื่อ Project'); return; }
    if (isNaN(inputRate) || isNaN(outputRate)) { errEl.textContent = '❌ ' + t('err.invalidRate', 'ค่า Rate ไม่ถูกต้อง'); return; }
    // Light client-side sanity — backend caps length at 256 (real OpenAI
    // service-account keys are ~167 chars, project keys similar)
    if (apiKeyNew && apiKeyNew.length > 256) {
      errEl.textContent = '❌ ' + t('err.apiKeyTooLong', 'API key ยาวเกินกำหนด (max 256 chars)'); return;
    }
    if (apiKeyNew && !/^sk-/.test(apiKeyNew)) {
      errEl.textContent = '⚠ ' + t('warn.apiKeyFormat', 'API key ปกติขึ้นต้นด้วย "sk-" — กรุณาตรวจสอบ'); return;
    }

    var self = this;
    var body = {
      name: name, description: desc,
      inputRate: inputRate, outputRate: outputRate, creditLimit: creditLit,
    };
    // Only include apiKey if admin actually typed one — empty = keep existing
    // (backend uses COALESCE($2, project_api_key) so omitted = unchanged)
    if (apiKeyNew) body.apiKey = apiKeyNew;

    fetch(BASE + '/api/projects/' + encodeURIComponent(projectId), {
      method: 'PUT',
      headers: Auth.authHeaders(),
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = '❌ ' + t('err.dbRejected', 'DB ปฏิเสธ: ') + (d.error || 'unknown'); return; }
        hideModal('modal-edit-project');
        flash('✅ ' + tf('msg.projectUpdated', { name: name }, 'อัปเดต Project "{name}" เรียบร้อย (saved to DB)'));
        self.fetchProjectsFromDB().then(function () {
          self.renderProjects();
          self.refreshProjectSelects();
        });
      })
      .catch(function (e) { errEl.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; });
  },

  // ── REMOVE USER FROM PROJECT (Phase 14.1: modal + DB call + refresh) ──
  // Bug fix: legacy code only updated localStorage via Auth.setUserProject —
  // the DB was never actually touched. Now we PUT /api/users/:id with
  // projectId:null (which updateUserSchema accepts as "unassign"), AWAIT,
  // then re-render so the "Members" list reflects the DB truth.
  _pendingRemoveFromProject: null,

  removeFromProject: function (username) {
    var users = this.getUsersWithHistory();
    var u = users.find(function (x) { return x.username === username; });
    if (!u || !u.id) { flash('❌ ' + t('err.userIdNotFound', 'ไม่พบ user_id (DB row)'), 'error'); return; }
    var proj = u.projectId ? Auth.getProjectById(u.projectId) : null;

    this._pendingRemoveFromProject = { username: u.username, id: u.id };

    var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    set('cru-username',    '@' + u.username);
    set('cru-displayname', u.displayName || '—');
    set('cru-project',     proj ? proj.name : t('empty.none', '— (ไม่มี)'));

    var err = document.getElementById('cru-error'); if (err) err.textContent = '';
    var btn = document.getElementById('cru-confirm-btn');
    if (btn) { btn.disabled = false; btn.textContent = t('m.removeUser.confirm', 'ยืนยันย้ายออก'); }

    showModal('modal-confirm-remove-user-from-project');
  },

  cancelRemoveFromProject: function () {
    this._pendingRemoveFromProject = null;
    hideModal('modal-confirm-remove-user-from-project');
  },

  confirmRemoveFromProject: function () {
    var self = this;
    var p = this._pendingRemoveFromProject;
    if (!p) { hideModal('modal-confirm-remove-user-from-project'); return; }

    var btn = document.getElementById('cru-confirm-btn');
    var err = document.getElementById('cru-error');
    if (err) err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = t('btn.movingEllipsis', 'กำลังย้าย…'); }

    // projectId:null = unassign. updateUser schema accepts nullable.
    fetch(BASE + '/api/users/' + p.id, {
      method: 'PUT',
      headers: Auth.authHeaders(),
      body: JSON.stringify({ projectId: null }),
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
      .then(function (res) {
        if (!res.body || !res.body.ok) {
          var msg = (res.body && res.body.error) || ('HTTP ' + res.status);
          if (err) err.textContent = '❌ ' + msg;
          if (btn) { btn.disabled = false; btn.textContent = t('m.removeUser.confirm', 'ยืนยันย้ายออก'); }
          return;
        }
        // Mirror to localStorage
        try { Auth.setUserProject(p.username, null); } catch (_) {}
        self._pendingRemoveFromProject = null;
        hideModal('modal-confirm-remove-user-from-project');
        flash('✅ ' + tf('msg.ownerMoved', { username: p.username }, 'ย้าย @{username} ออกจาก project แล้ว'));
        // Re-fetch users so project member lists are accurate
        self.fetchUsersFromDB().then(function (users) {
          self._cachedDBUsers = users;
          self.renderProjects();
        });
      })
      .catch(function (e) {
        if (err) err.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('m.removeUser.confirm', 'ยืนยันย้ายออก'); }
      });
  },

  // ── DELETE PROJECT (Phase 14.1: modal + await + real-time refresh) ──
  // Server rejects with a descriptive error if the project has chat history
  // (history is user data — never silently deleted). We show that error
  // inside the modal rather than flashing it, so admin understands what
  // needs to happen before retry.
  _pendingDeleteProject: null,

  deleteProject: function (projectId) {
    var p = Auth.getProjectById(projectId);
    if (!p) { flash('❌ ' + t('err.projectNotFound', 'ไม่พบ project'), 'error'); return; }

    // Count DB members for the summary — cache falls back gracefully.
    var members = (this._cachedDBUsers || []).filter(function (u) { return u.projectId === projectId; });
    // Credits: the project list has credits in p.credits if available, else 0.
    var credits = (typeof p.credits === 'number' ? p.credits : 0);

    this._pendingDeleteProject = { id: projectId, name: p.name, memberCount: members.length };

    var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    set('cdp-name',    p.name);
    set('cdp-id',      projectId);
    set('cdp-members', String(members.length));
    set('cdp-credits', formatTHB(credits));

    // Tweak warning text if members > 0
    var warn = document.getElementById('cdp-warning');
    if (warn) {
      warn.innerHTML = members.length > 0
        ? '⚠ ' + tf('confirm.removeMembersWarn', { n: members.length }, 'มีสมาชิก {n} คนใน project นี้ — ทุกคนจะถูกย้ายออก (ไม่ได้ถูกลบ)<br>Balance ของ project จะถูกล้าง')
        : t('confirm.deleteProjectPlain', 'Project จะถูก soft-delete — Balance ของ project จะถูกล้าง');
    }

    var err = document.getElementById('cdp-error'); if (err) err.textContent = '';
    var btn = document.getElementById('cdp-confirm-btn');
    if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }

    showModal('modal-confirm-delete-project');
  },

  cancelDeleteProject: function () {
    this._pendingDeleteProject = null;
    hideModal('modal-confirm-delete-project');
  },

  confirmDeleteProject: function () {
    var self = this;
    var p = this._pendingDeleteProject;
    if (!p) { hideModal('modal-confirm-delete-project'); return; }

    var btn = document.getElementById('cdp-confirm-btn');
    var err = document.getElementById('cdp-error');
    if (err) err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = t('btn.deletingEllipsis', 'กำลังลบ...'); }

    fetch(BASE + '/api/projects/' + encodeURIComponent(p.id), {
      method: 'DELETE',
      headers: Auth.authHeaders(),
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, body: d }; }); })
      .then(function (res) {
        if (!res.body || !res.body.ok) {
          var msg = (res.body && res.body.error) || ('HTTP ' + res.status);
          if (err) err.textContent = '❌ ' + msg;
          if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }
          return;
        }
        try { Auth.deleteProject(p.id); } catch (_) {}
        self._pendingDeleteProject = null;
        hideModal('modal-confirm-delete-project');
        flash('✅ ' + tf('msg.projectDeleted', { name: p.name }, 'ลบ Project "{name}" แล้ว'));
        // Real-time refresh: fetch projects + users (members now unassigned)
        Promise.all([self.fetchProjectsFromDB(), self.fetchUsersFromDB()])
          .then(function (results) {
            self._cachedDBUsers = results[1] || [];
            self.renderProjects();
            self.refreshProjectSelects();
          });
      })
      .catch(function (e) {
        if (err) err.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }
      });
  },

  // ── ADD PROJECT (modal) ────────────────────────────────
  // Create form intentionally only asks for name + description.
  // The server applies default rates (inputRate=฿0.50 / outputRate=฿1.50 per 1K)
  // and creditLimit=0. Admin can fine-tune later via Edit Project modal.
  openAddProject: function () {
    ['ap-name', 'ap-desc'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('ap-error').textContent = '';
    showModal('modal-add-project');
  },

  submitAddProject: function () {
    var name = document.getElementById('ap-name').value.trim();
    var desc = document.getElementById('ap-desc').value.trim();
    var errEl = document.getElementById('ap-error');

    if (!name) { errEl.textContent = '❌ ' + t('err.enterProjectName', 'กรุณาใส่ชื่อ Project'); return; }

    var self = this;
    fetch(BASE + '/api/projects', {
      method: 'POST', headers: Auth.authHeaders(),
      // inputRate / outputRate / creditLimit omitted → server applies defaults
      body: JSON.stringify({ name: name, description: desc }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = '❌ ' + t('err.dbRejected', 'DB ปฏิเสธ: ') + (d.error || 'unknown'); return; }
        hideModal('modal-add-project');
        // Surface the OpenAI linking result. The project row always lands in the
        // DB; but if the OpenAI Admin API call failed, openai_project_id is null
        // and usage/quota won't sync until it's linked — warn instead of a silent ✅.
        if (d.openai && d.openai.synced === false) {
          flash('⚠ ' + tf('msg.projectCreatedOpenAiFail', { name: name, err: d.openai.error || 'unknown' }, 'สร้าง Project "{name}" ใน DB แล้ว แต่เชื่อม OpenAI ไม่สำเร็จ: {err} — ยังไม่มี OpenAI project id'), 'error');
        } else {
          flash('✅ ' + tf('msg.projectCreated', { name: name }, 'สร้าง Project "{name}" เรียบร้อย')
            + (d.openai && d.openai.project_id ? ' · OpenAI: ' + d.openai.project_id : ''));
        }
        self.fetchProjectsFromDB().then(function () {
          self.renderProjects();
          self.refreshProjectSelects();
        });
      })
      .catch(function (e) { errEl.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; });
  },

  refreshProjectSelects: function () {
    // Phase 16.14: au-project is now a hidden <input>; its dropdown items
    // are sourced from this._cachedDBProjects at click time, so this helper
    // is mostly a no-op. Kept as a stub so existing callers don't break.
  },

  // ── ACTIVITY LOG ──────────────────────────────────────
  renderActivity: function () {
    var container = document.getElementById('activity-log');
    container.innerHTML = '<div style="text-align:center;padding:28px;color:var(--text-3);font-size:.85rem">' + t('common.loadingFromDbData', '⏳ กำลังโหลดข้อมูลจาก DB...') + '</div>';
    this.fetchUsersFromDB().then(function (users) {
      var allLogs = [];
      users.forEach(function (u) {
        u.history.forEach(function (h) {
          allLogs.push(Object.assign({}, h, { username: u.username, displayName: u.displayName }));
        });
      });
      allLogs.sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });

      if (allLogs.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>' + t('empty.noActivity', 'ยังไม่มี activity ใดๆ') + '</p></div>';
        return;
      }
      // Phase 19.3: escape every untrusted string (displayName, username,
      // skillName come from DB and users can pick their own display name —
      // unescaped → stored XSS in admin view).
      container.innerHTML = allLogs.map(function (h) {
        var emoji = escapeHtml(h.skillEmoji || '🤖');
        var name  = escapeHtml(h.displayName || h.username || '');
        var uname = escapeHtml(h.username || '');
        var skill = escapeHtml(h.skillName || '—');
        return '<div class="log-entry">'
          + '<div>'
          + '<div class="log-user">' + emoji + ' ' + name + ' <span style="color:var(--text-3);font-weight:400">(@' + uname + ')</span></div>'
          + '<div class="log-skill">' + skill + ' · ' + (h.inputTokens || 0).toLocaleString() + ' in / ' + (h.outputTokens || 0).toLocaleString() + ' out tokens</div>'
          + '<div class="log-time">' + formatDate(h.timestamp) + '</div>'
          + '</div>'
          + '<div class="log-cost">' + formatTHB(h.cost) + '</div>'
          + '</div>';
      }).join('');
    }).catch(function () {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><p>' + t('empty.loadFailedServer', 'ไม่สามารถโหลดข้อมูลได้ — ตรวจสอบว่า server กำลังรันอยู่') + '</p></div>';
    });
  },

  // ── Activity Log sub-tabs ───────────────────────────────
  _currentActivityTab: 'chat',
  switchActivityTab: function (tab) {
    this._currentActivityTab = tab;
    // Phase 19.3: scope query to the Activity Log view — `.audit-tab` is
    // reused inside Credits/Usage views and the unscoped selector toggled
    // those tabs too when admin switched chat/audit/action.
    var tabs  = document.querySelectorAll('#view-activity .audit-tab');
    var panes = { chat: 'pane-chat', audit: 'pane-audit', action: 'pane-action' };
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.keys(panes).forEach(function (k) {
      var el = document.getElementById(panes[k]);
      if (el) el.classList.toggle('hidden', k !== tab);
    });
    if (tab === 'audit')  this.renderAuditLog();
    if (tab === 'action') this.renderActionLog();
    if (tab === 'chat')   this.renderActivity();
  },

  refreshActivityTab: function () {
    this.switchActivityTab(this._currentActivityTab || 'chat');
  },

  // ── Login / Logout history (tbl_audit_log) ─────────────
  // Phase 16.10.2: filter to event_type='login_ok' only. tbl_audit_log also
  // stores 'logout' / 'login_fail' / 'lockout' / 'login_blocked' rows — each
  // of those has its own log_in_time (= when the event happened) and a NULL
  // log_out_time, so they used to render as "ghost login" rows in this view.
  // The logout info we want IS already captured in the login_ok row's
  // log_out_date/time columns (stamped by /api/logout). One row per session.
  renderAuditLog: function () {
    var body = document.getElementById('audit-log-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="5" class="audit-empty">' + t('common.loadingFromDb', '⏳ กำลังโหลดจาก DB...') + '</td></tr>';
    fetch(BASE + '/api/audit-log?event=login_ok', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok || !Array.isArray(d.logs)) {
          body.innerHTML = '<tr><td colspan="5" class="audit-empty">' + t('empty.noAuditData', '⚠️ ไม่พบข้อมูล audit log') + '</td></tr>';
          return;
        }
        if (d.logs.length === 0) {
          body.innerHTML = '<tr><td colspan="5" class="audit-empty">' + t('empty.noLoginHistory', '📋 ยังไม่มีประวัติการเข้าออกระบบ') + '</td></tr>';
          return;
        }
        body.innerHTML = d.logs.map(function (l) {
          var inDt  = l.log_in_time  ? new Date(l.log_in_time)  : null;
          var outDt = l.log_out_time ? new Date(l.log_out_time) : null;
          var dur = '—';
          if (inDt && outDt && outDt > inDt) {
            var ms = outDt - inDt;
            var mins = Math.floor(ms / 60000);
            var secs = Math.floor((ms % 60000) / 1000);
            dur = (mins >= 60)
              ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm'
              : (mins > 0 ? mins + 'm ' + secs + 's' : secs + 's');
          }
          var inFmt  = inDt  ? formatDate(inDt.toISOString())  : '—';
          // Phase 16.10: NULL log_out_time means we haven't recorded a logout
          // yet — render a plain "—" instead of "ยังออนไลน์" (the old label
          // was misleading because legacy data also has NULLs from sessions
          // that ended without going through /api/logout). When user really
          // is online the new SQL keeps log_out_time NULL until logout fires.
          var outFmt = outDt ? formatDate(outDt.toISOString()) : '<span style="color:var(--text-3)">—</span>';
          // Phase 19.3: escape user-provided fields (display_name, username,
          // name) before inlining into HTML.
          var safeName  = escapeHtml(l.display_name || l.name || '—');
          var safeUname = escapeHtml(l.username || '—');
          return '<tr>' +
            '<td data-label="User"><span class="audit-name">' + safeName + '</span></td>' +
            '<td data-label="Username"><span class="audit-username">@' + safeUname + '</span></td>' +
            '<td data-label="' + escapeHtml(t('col.login', 'เข้าสู่ระบบ')) + '">' + inFmt + '</td>' +
            '<td data-label="' + escapeHtml(t('col.logout', 'ออกจากระบบ')) + '">' + outFmt + '</td>' +
            '<td data-label="' + escapeHtml(t('col.duration', 'ระยะเวลา')) + '"><span class="audit-duration">' + dur + '</span></td>' +
            '</tr>';
        }).join('');
      })
      .catch(function () {
        body.innerHTML = '<tr><td colspan="5" class="audit-empty">' + t('empty.serverConnFail', '⚠️ ไม่สามารถเชื่อมต่อ server ได้') + '</td></tr>';
      });
  },

  // ── Admin actions history (tbl_action_admin) ───────────
  // Phase 14.3: rich details from change_json (before → after diff).
  //
  // Action label map — keeps the UI strings in one place. `variant` maps
  // to CSS class: 'success' (create/topup) / 'danger' (delete) / 'warn'
  // (money/password changes) / neutral (updates/reads).
  _actionLabels: {
    create_user:          { icon: '➕', text: 'สร้าง User',           variant: 'success' },
    update_user:          { icon: '✏️', text: 'แก้ไข User',            variant: '' },
    delete_user:          { icon: '🗑️', text: 'ลบ User',              variant: 'danger'  },
    update_balance:       { icon: '💰', text: 'แก้ยอดเงิน User',      variant: 'warn'    },
    admin_reset_password: { icon: '🔑', text: 'รีเซ็ตรหัสผ่าน',       variant: 'warn'    },
    change_own_password:  { icon: '🔑', text: 'เปลี่ยนรหัสตัวเอง',    variant: ''        },
    update_role:          { icon: '🎭', text: 'เปลี่ยน Role',         variant: 'warn'    },
    update_status:        { icon: '🚦', text: 'เปลี่ยนสถานะ',         variant: 'warn'    },
    update_daily_cap:     { icon: '📊', text: 'ตั้ง Daily Cap',       variant: ''        },
    update_project:       { icon: '📝', text: 'แก้ไข Project',        variant: ''        },
    create_project:       { icon: '📁', text: 'สร้าง Project',        variant: 'success' },
    delete_project:       { icon: '🗂️', text: 'ลบ Project',          variant: 'danger'  },
    topup_project:        { icon: '💸', text: 'เติมเงิน Project',     variant: 'success' },
  },

  // Field-name pretty labels for the diff renderer (Thai where it helps)
  _fieldLabels: {
    name:            'ชื่อ',
    surname:         'นามสกุล',
    display_name:    'ชื่อแสดงผล',
    username:        'Username',
    role:            'Role',
    role_id:         'Role',
    balance:         'Balance',
    project_id:      'Project',
    project_credits: 'Project Credits',
    acc_status_id:   'สถานะ',
    daily_cap:       'Daily Cap',
    password_reset:  'รีเซ็ตรหัสผ่าน',
    project_name:    'ชื่อ Project',
    description:     'คำอธิบาย',
    input_rate:      'Input Rate',
    output_rate:     'Output Rate',
    credit_limit:    'Credit Limit',
    api_key_changed: 'เปลี่ยน API Key',
    sessions_revoked:'Sessions ที่ถูกตัด',
  },

  _esc: function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  _fmtVal: function (v) {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    var s = String(v);
    if (s.length > 40) s = s.slice(0, 40) + '…';
    return this._esc(s);
  },

  _fieldName: function (k) {
    var fallback = this._fieldLabels[k] || k;
    return t('field.' + k, fallback);
  },

  // Build the "รายละเอียด" cell content from change_json.
  // Shows changed fields as "ชื่อฟิลด์: before → after" plus extras,
  // and a collapsed <details> with the raw JSON for forensics.
  _renderDiff: function (cj) {
    if (!cj || typeof cj !== 'object') {
      return '<span class="diff-none">' + t('diff.noDetail', '— ไม่มีรายละเอียด —') + '</span>';
    }
    var self = this;
    var before = cj.before || {};
    var after  = cj.after  || {};
    var extra  = cj.extra  || null;

    // Collect all changed keys (union of before/after)
    var keys = {};
    Object.keys(before).forEach(function (k) { keys[k] = true; });
    Object.keys(after).forEach(function (k) { keys[k] = true; });
    var keyList = Object.keys(keys);

    var rows = keyList.map(function (k) {
      var bv = before[k], av = after[k];
      // Fields that only have an "after" (create, add) → show as "added"
      if (!(k in before)) {
        return '<span class="diff-row"><span class="diff-key">' + self._esc(self._fieldName(k)) + ':</span> ' +
               '<span class="diff-val-after">+ ' + self._fmtVal(av) + '</span></span>';
      }
      // Fields that only have a "before" (delete snapshot) → show as "removed"
      if (!(k in after)) {
        return '<span class="diff-row"><span class="diff-key">' + self._esc(self._fieldName(k)) + ':</span> ' +
               '<span class="diff-val-before">' + self._fmtVal(bv) + '</span></span>';
      }
      // Normal diff
      return '<span class="diff-row">' +
             '<span class="diff-key">' + self._esc(self._fieldName(k)) + ':</span> ' +
             '<span class="diff-val-before">' + self._fmtVal(bv) + '</span>' +
             '<span class="diff-arrow">→</span>' +
             '<span class="diff-val-after">' + self._fmtVal(av) + '</span>' +
             '</span>';
    });

    var extraHtml = '';
    if (extra && typeof extra === 'object') {
      var parts = Object.keys(extra).map(function (k) {
        return '<b>' + self._esc(self._fieldName(k)) + ':</b> ' + self._fmtVal(extra[k]);
      });
      if (parts.length) extraHtml = '<span class="diff-extra">ℹ ' + parts.join(' · ') + '</span>';
    }

    var main = rows.length > 0
      ? rows.join(' ')
      : (extraHtml ? '' : '<span class="diff-none">' + t('diff.noFieldChanges', '— ไม่มีฟิลด์เปลี่ยนแปลง —') + '</span>');

    // Raw JSON pane — always available for forensic drill-down
    var rawJson = JSON.stringify(cj, null, 2);
    var rawPane = '<details class="diff-raw"><summary>' + escapeHtml(t('diff.viewRawJson', 'ดู raw JSON')) + '</summary>' +
                  '<pre>' + this._esc(rawJson) + '</pre></details>';

    return '<div class="diff-summary">' + main + extraHtml + rawPane + '</div>';
  },

  _renderTarget: function (l) {
    if (!l.target_type) return '<span class="diff-none">—</span>';
    if (l.target_type === 'user') {
      // target_id is a user_id; we don't always have the username joined,
      // but change_json often has it. Look in after/before for hints.
      var cj = l.change_json || {};
      var hint = (cj.after && cj.after.username) || (cj.before && cj.before.username);
      var label = '👤 User #' + (l.target_id != null ? l.target_id : '?');
      if (hint) label += ' <span class="action-target-code">@' + this._esc(hint) + '</span>';
      return label;
    }
    if (l.target_type === 'project') {
      var cj2 = l.change_json || {};
      var pid = (cj2.extra && cj2.extra.project_id)
             || (cj2.after && cj2.after.project_id)
             || (cj2.before && cj2.before.project_id);
      var pname = (cj2.after && cj2.after.project_name)
               || (cj2.before && cj2.before.project_name)
               || (cj2.after && cj2.after.name);
      var s = '📁 ' + (pname ? this._esc(pname) : 'Project');
      if (pid) s += ' <span class="action-target-code">' + this._esc(pid) + '</span>';
      return s;
    }
    return this._esc(l.target_type) + (l.target_id != null ? (' #' + l.target_id) : '');
  },

  renderActionLog: function () {
    var self = this;
    var body = document.getElementById('action-log-body');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="5" class="audit-empty">' + t('common.loadingFromDb', '⏳ กำลังโหลดจาก DB...') + '</td></tr>';

    // Phase 16.14: filters are hidden inputs now (custom dropdowns above)
    var actionVal = (document.getElementById('action-log-filter-type') || {}).value || '';
    var targetVal = (document.getElementById('action-log-filter-target') || {}).value || '';
    var params = [];
    if (actionVal) params.push('action=' + encodeURIComponent(actionVal));
    if (targetVal) params.push('target=' + encodeURIComponent(targetVal));
    params.push('limit=200');
    var url = BASE + '/api/action-log?' + params.join('&');

    fetch(url, { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var countEl = document.getElementById('action-log-count');
        if (!d.ok || !Array.isArray(d.logs)) {
          body.innerHTML = '<tr><td colspan="5" class="audit-empty">' + t('empty.noActionLogData', '⚠️ ไม่พบข้อมูล action log') + '</td></tr>';
          if (countEl) countEl.textContent = '';
          return;
        }
        if (countEl) countEl.textContent = d.logs.length + ' record' + (d.logs.length === 1 ? '' : 's');
        if (d.logs.length === 0) {
          body.innerHTML = '<tr><td colspan="5" class="audit-empty">' + t('empty.noActionLogFiltered', '📋 ยังไม่มีประวัติการแก้ไขโดย admin ตามตัวกรองที่เลือก') + '</td></tr>';
          return;
        }
        body.innerHTML = d.logs.map(function (l) {
          var dt = l.edit_time ? formatDate(new Date(l.edit_time).toISOString()) : (l.edit_date || '—');
          // Admin cell
          var adminHtml = '<span class="audit-name">' + self._esc(l.display_name || '—') + '</span>' +
                          '<br><span class="audit-username" style="font-size:.74rem">@' + self._esc(l.username || '—') + '</span>';

          // Action cell (pill with icon)
          var meta = self._actionLabels[l.action_type] || { icon: '•', text: l.action_type || 'unknown', variant: '' };
          var actionText = t('action.' + l.action_type, meta.text);
          var actionHtml = '<span class="action-label ' + meta.variant + '">' +
                           meta.icon + ' ' + self._esc(actionText) + '</span>';

          // Target cell
          var targetHtml = self._renderTarget(l);

          // Details cell — before/after diff
          var diffHtml = self._renderDiff(l.change_json);

          return '<tr>' +
            '<td data-label="Admin">' + adminHtml + '</td>' +
            '<td data-label="Action">' + actionHtml + '</td>' +
            '<td data-label="Target">' + targetHtml + '</td>' +
            '<td data-label="' + escapeHtml(t('col.detailShort', 'รายละเอียด')) + '">' + diffHtml + '</td>' +
            '<td data-label="' + escapeHtml(t('col.datetime', 'วันที่/เวลา')) + '">' + dt + '</td>' +
            '</tr>';
        }).join('');
      })
      .catch(function (e) {
        body.innerHTML = '<tr><td colspan="5" class="audit-empty">' + t('empty.serverConnFail', '⚠️ ไม่สามารถเชื่อมต่อ server ได้') + ' (' + self._esc(e.message) + ')</td></tr>';
      });
  },

  // Phase 19.3: typed-confirmation modal (admin must type "DELETE").
  // Replaces window.confirm() which was 1-click destructive — too easy
  // to wipe every user's history by accident.
  clearAllHistory: function () {
    var inp = document.getElementById('ch-confirm-input');
    if (inp) inp.value = '';
    var err = document.getElementById('ch-error');
    if (err) err.textContent = '';
    var btn = document.getElementById('ch-confirm-btn');
    if (btn) { btn.disabled = true; btn.textContent = t('btn.deleteAll', 'ลบทั้งหมด'); }
    showModal('modal-confirm-clear-history');
    setTimeout(function () { if (inp) inp.focus(); }, 50);
  },
  onClearHistoryInput: function () {
    var inp = document.getElementById('ch-confirm-input');
    var btn = document.getElementById('ch-confirm-btn');
    if (!inp || !btn) return;
    btn.disabled = (inp.value || '').trim() !== 'DELETE';
  },
  cancelClearAllHistory: function () { hideModal('modal-confirm-clear-history'); },
  confirmClearAllHistory: function () {
    var inp = document.getElementById('ch-confirm-input');
    var err = document.getElementById('ch-error');
    var btn = document.getElementById('ch-confirm-btn');
    if (!inp || (inp.value || '').trim() !== 'DELETE') {
      if (err) err.textContent = '❌ ' + t('err.typeDeleteConfirm', 'พิมพ์ DELETE เพื่อยืนยัน');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = t('btn.deletingEllipsis', 'กำลังลบ...'); }
    if (err) err.textContent = '';
    var self = this;
    fetch(BASE + '/api/history', { method: 'DELETE', headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          if (err) err.textContent = '❌ ' + (d.error || 'unknown');
          if (btn) { btn.disabled = false; btn.textContent = t('btn.deleteAll', 'ลบทั้งหมด'); }
          return;
        }
        hideModal('modal-confirm-clear-history');
        flash('✅ ' + t('msg.activityLogCleared', 'ล้าง Activity Log ทั้งหมดแล้ว'));
        self.renderActivity();
      })
      .catch(function (e) {
        if (err) err.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('btn.deleteAll', 'ลบทั้งหมด'); }
      });
  },

  // ── USAGE ANALYTICS ───────────────────────────────────
  // Phase 16.13: sticky project filter for Usage Analytics tab.
  // null/'' = show all users across all projects.
  // string  = show only users assigned to that project_id.
  _usageProjectFilter: '',

  setUsageProjectFilter: function (projectId) {
    this._usageProjectFilter = projectId || '';
    this.renderUsage();
  },

  // ── Generic custom dropdown (Phase 16.14) ──────────────
  // Reusable single-select dropdown that matches the dark theme.
  // Used by Usage Analytics filter + all project/status pickers in modals.
  //
  // Usage:
  //   admin.openDropdown('trigger-id', {
  //     items:        [{ value: 'abc', label: 'ABC',  emoji: '📂' }, ...],
  //     selected:     'abc',                 // current value (optional)
  //     searchable:   true,                  // show search input
  //     placeholder:  '🔎 ค้นหา...',
  //     allowEmpty:   { label: '— None —' }, // adds a "clear" entry on top
  //     onPick:       function (value, item) { ... }
  //   });
  //
  // The popup is appended to <body> with `position: absolute` set inline,
  // so it lives outside the trigger's container and can escape modal overflow.
  _activeDropdown: null,   // tracks the open popup so toggle can close it

  openDropdown: function (triggerId, opts) {
    // If a dropdown is already open, close it (toggle behaviour)
    var prev = this._activeDropdown;
    this._closeDropdown();
    if (prev && prev.triggerId === triggerId) return;   // toggle off

    var trigger = document.getElementById(triggerId);
    if (!trigger) return;

    var self = this;
    var items     = (opts && opts.items) || [];
    var selected  = opts && opts.selected != null ? String(opts.selected) : '';
    var onPick    = (opts && opts.onPick) || function () {};
    var searchable= !!(opts && opts.searchable);
    var allowEmpty= opts && opts.allowEmpty;
    var placeholder = (opts && opts.placeholder) || '🔎 Search...';

    // Position under trigger; allow modal-z by stacking high.
    var rect = trigger.getBoundingClientRect();
    var pop = document.createElement('div');
    pop.className = 'dd-popup';
    pop.id = '__dd_popup_active';
    pop.style.top   = (window.scrollY + rect.bottom + 6) + 'px';
    pop.style.left  = (window.scrollX + rect.left) + 'px';
    pop.style.width = Math.max(rect.width, 220) + 'px';
    // Modals use z-index 1000+; the popup must outrank them.
    pop.style.zIndex = '10001';
    pop.innerHTML =
        (searchable ? '<input type="text" class="dd-search" placeholder="' + escapeHtml(placeholder) + '"/>' : '')
      + '<div class="dd-list"></div>';
    document.body.appendChild(pop);
    trigger.classList.add('dd-open');

    var listEl   = pop.querySelector('.dd-list');
    var searchEl = pop.querySelector('.dd-search');
    var checkSvg = '<svg class="dd-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">'
                 + '<polyline points="20 6 9 17 4 12"/></svg>';

    function render(query) {
      query = (query || '').trim().toLowerCase();
      var rendered = items.slice();
      if (query) {
        rendered = rendered.filter(function (it) {
          return (it.label || '').toLowerCase().indexOf(query) !== -1;
        });
      }
      var allEntry = allowEmpty ? { value: '', label: allowEmpty.label, _all: true } : null;
      var combined = allEntry ? [allEntry].concat(rendered) : rendered;

      if (combined.length === 0) {
        listEl.innerHTML = '<div class="dd-empty">' + escapeHtml(t('dd.noResults', 'ไม่พบรายการ')) + '</div>';
        return;
      }
      listEl.innerHTML = combined.map(function (it, idx) {
        var sel = (selected === String(it.value || '')) ? ' dd-selected' : '';
        var emoji = it.emoji ? (it.emoji + ' ') : '';
        var labelHtml = it._all
          ? '<span style="color:var(--text-3)">' + escapeHtml(it.label) + '</span>'
          : emoji + escapeHtml(it.label);
        var divider = (it._all && combined.length > 1) ? '<div class="dd-divider"></div>' : '';
        return '<div class="dd-item' + sel + '" data-value="' + escapeHtml(String(it.value || '')) + '" data-idx="' + idx + '">'
          + checkSvg
          + '<span style="flex:1">' + labelHtml + '</span>'
          + '</div>' + divider;
      }).join('');
      // Wire click on items (handler captures closure variables — can't use inline onclick reliably for arbitrary onPick)
      Array.prototype.forEach.call(listEl.querySelectorAll('.dd-item'), function (el) {
        el.addEventListener('mousedown', function (e) {
          e.preventDefault();   // avoid blurring the search input mid-click
          var v = el.getAttribute('data-value');
          var idx = parseInt(el.getAttribute('data-idx'), 10);
          var picked = combined[idx] || null;
          self._closeDropdown();
          onPick(v, picked);
        });
      });
    }
    render('');

    if (searchEl) {
      searchEl.focus();
      searchEl.addEventListener('input', function () { render(searchEl.value); });
      searchEl.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') self._closeDropdown();
        if (e.key === 'Enter') {
          var first = listEl.querySelector('.dd-item');
          if (first) {
            var v = first.getAttribute('data-value');
            var idx = parseInt(first.getAttribute('data-idx'), 10);
            self._closeDropdown();
            onPick(v, null);
          }
        }
      });
    }

    function onDocClick(e) {
      if (!pop.contains(e.target) && !e.target.closest('#' + triggerId)) {
        self._closeDropdown();
      }
    }
    // Defer to next tick so the current click that opened the popup doesn't immediately close it.
    setTimeout(function () { document.addEventListener('mousedown', onDocClick); }, 0);

    this._activeDropdown = {
      triggerId: triggerId,
      pop: pop,
      cleanup: function () { document.removeEventListener('mousedown', onDocClick); }
    };
  },

  _closeDropdown: function () {
    var d = this._activeDropdown;
    if (!d) return;
    if (d.pop && d.pop.parentNode) d.pop.parentNode.removeChild(d.pop);
    var trigger = document.getElementById(d.triggerId);
    if (trigger) trigger.classList.remove('dd-open');
    if (d.cleanup) d.cleanup();
    this._activeDropdown = null;
  },

  // Action-Log filters (Phase 16.14) — use generic dropdown
  _actionFilterTypeItems: [
    { value: 'create_user',          label: 'สร้าง User',          emoji: '➕' },
    { value: 'update_user',          label: 'แก้ไข User',          emoji: '✏️' },
    { value: 'delete_user',          label: 'ลบ User',              emoji: '🗑️' },
    { value: 'update_balance',       label: 'แก้ยอดเงิน',          emoji: '💰' },
    { value: 'admin_reset_password', label: 'รีเซ็ตรหัสผ่าน',     emoji: '🔑' },
    { value: 'change_own_password',  label: 'เปลี่ยนรหัสตัวเอง', emoji: '🔑' },
    { value: 'create_project',       label: 'สร้าง Project',       emoji: '📁' },
    { value: 'update_project',       label: 'แก้ไข Project',       emoji: '📝' },
    { value: 'delete_project',       label: 'ลบ Project',           emoji: '🗂️' },
    { value: 'topup_project',        label: 'เติมเงิน Project',   emoji: '💸' },
  ],
  _actionFilterTargetItems: [
    { value: 'user',    label: 'User',    emoji: '👤' },
    { value: 'project', label: 'Project', emoji: '📁' },
  ],

  openActionFilterTypeDropdown: function (ev) {
    if (ev) ev.stopPropagation();
    var self = this;
    this.openDropdown('action-log-filter-type-trigger', {
      items: this._actionFilterTypeItems.map(function (it) {
        return Object.assign({}, it, { label: t('action.' + it.value, it.label) });
      }),
      selected: document.getElementById('action-log-filter-type').value || '',
      searchable: true,
      placeholder: t('dd.searchAction', '🔎 ค้นหา action...'),
      allowEmpty: { label: t('filter.allAction', '🔎 ทุก Action') },
      onPick: function (value, item) {
        document.getElementById('action-log-filter-type').value = value || '';
        document.getElementById('action-log-filter-type-label').textContent =
          item && !item._all ? ((item.emoji ? item.emoji + ' ' : '') + item.label) : t('filter.allAction', '🔎 ทุก Action');
        self.renderActionLog();
      },
    });
  },

  openActionFilterTargetDropdown: function (ev) {
    if (ev) ev.stopPropagation();
    var self = this;
    this.openDropdown('action-log-filter-target-trigger', {
      items: this._actionFilterTargetItems,
      selected: document.getElementById('action-log-filter-target').value || '',
      allowEmpty: { label: t('filter.allTarget', 'ทุก Target') },
      onPick: function (value, item) {
        document.getElementById('action-log-filter-target').value = value || '';
        document.getElementById('action-log-filter-target-label').textContent =
          item && !item._all ? ((item.emoji ? item.emoji + ' ' : '') + item.label) : t('filter.allTarget', 'ทุก Target');
        self.renderActionLog();
      },
    });
  },

  // Overview page project picker (Phase 16.20) — uses generic dropdown
  openOverviewProjectDropdown: function (ev) {
    if (ev) ev.stopPropagation();
    var self = this;
    var projects = (this._cachedDBProjects || []).slice()
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    this.openDropdown('overview-project-trigger', {
      items: projects.map(function (p) { return { value: p.id, label: p.name, emoji: '📂' }; }),
      selected: this._selectedProject || (projects[0] && projects[0].id) || '',
      searchable: true,
      placeholder: t('dd.searchProject', '🔎 ค้นหา project...'),
      onPick: function (value, item) {
        var hidden = document.getElementById('project-selector');
        if (hidden) hidden.value = value || '';
        var label = document.getElementById('overview-project-label');
        if (label) label.textContent = item ? ('📂 ' + item.label) : t('dd.selectProject', '— เลือก Project —');
        self.selectProject(value);
      },
    });
  },

  // ── Usage Analytics project filter (uses generic dropdown) ──
  toggleUsageProjectDropdown: function (ev) {
    if (ev) ev.stopPropagation();
    var self = this;
    var projects = (this._cachedDBProjects || []).slice()
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    this.openDropdown('usage-filter-trigger', {
      items: projects.map(function (p) { return { value: p.id, label: p.name, emoji: '📂' }; }),
      selected:    this._usageProjectFilter || '',
      searchable:  true,
      placeholder: t('dd.searchProject', '🔎 ค้นหา project...'),
      allowEmpty:  { label: t('filter.allProject', '— ทุก Project —') },
      onPick: function (value) { self.setUsageProjectFilter(value || ''); },
    });
  },

  renderUsage: function () {
    var self = this;
    var grid = document.getElementById('usage-summary-grid');
    var list = document.getElementById('usage-user-list');
    var listTitle = document.getElementById('usage-user-list-title');
    var banner = document.getElementById('usage-project-banner');
    var metaEl = document.getElementById('usage-filter-meta');
    if (grid) grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:16px;color:var(--text-3);font-size:.85rem">' + t('common.loading', '⏳ กำลังโหลด...') + '</div>';
    if (list) list.innerHTML = '';
    this.fetchUsersFromDB().then(function (users) {
      // ไม่แสดง admin ใน Usage Analytics
      users = users.filter(function (u) { return u.role !== 'admin'; });
      var projects = self._projectsList();

      // Phase 16.14: custom dropdown — sync the trigger label with state.
      var labelEl = document.getElementById('usage-filter-label');
      if (labelEl) {
        if (self._usageProjectFilter) {
          var p = projects.find(function (x) { return String(x.id) === String(self._usageProjectFilter); });
          labelEl.textContent = p ? '📂 ' + p.name : t('filter.allProject', '— ทุก Project —');
        } else {
          labelEl.textContent = t('filter.allProject', '— ทุก Project —');
        }
      }

      var allUsersInSystem = users.length;
      var selectedProjId = self._usageProjectFilter;
      var selectedProj   = selectedProjId
        ? projects.find(function (p) { return String(p.id) === String(selectedProjId); })
        : null;

      if (selectedProjId) {
        users = users.filter(function (u) { return String(u.projectId) === String(selectedProjId); });
      }

      // Banner with project-level context — only visible when filtered
      if (banner) {
        if (selectedProj) {
          var projTokens = users.reduce(function (s, u) {
            return s + u.history.reduce(function (ss, h) { return ss + (h.inputTokens || 0) + (h.outputTokens || 0); }, 0);
          }, 0);
          var projSpent = users.reduce(function (s, u) {
            return s + u.history.reduce(function (ss, h) { return ss + (h.cost || 0); }, 0);
          }, 0);
          banner.classList.remove('hidden');
          banner.innerHTML =
              '<div style="padding:14px 18px;border-radius:10px;'
            +   'background:linear-gradient(135deg,rgba(99,102,241,0.10),rgba(168,85,247,0.06));'
            +   'border:1px solid rgba(99,102,241,0.25);'
            +   'display:flex;align-items:center;gap:18px;flex-wrap:wrap">'
            +   '<div style="font-size:1.5rem">📂</div>'
            +   '<div style="flex:1;min-width:160px">'
            +     '<div style="font-size:.7rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">PROJECT</div>'
            +     '<div style="font-weight:700;color:var(--text-1);font-size:1.05rem">' + escapeHtml(selectedProj.name) + '</div>'
            +     (selectedProj.desc ? '<div style="font-size:.78rem;color:var(--text-3);margin-top:2px">' + escapeHtml(selectedProj.desc) + '</div>' : '')
            +   '</div>'
            +   '<div style="text-align:center;padding:0 14px;border-left:1px solid var(--border-subtle)">'
            +     '<div style="font-size:.7rem;color:var(--text-3)">👥 USERS</div>'
            +     '<div style="font-weight:700;color:var(--accent);font-size:1.4rem">' + users.length + '</div>'
            +   '</div>'
            +   '<div style="text-align:center;padding:0 14px;border-left:1px solid var(--border-subtle)">'
            +     '<div style="font-size:.7rem;color:var(--text-3)">📡 REQUESTS</div>'
            +     '<div style="font-weight:700;color:var(--text-1);font-size:1.4rem">'
            +       users.reduce(function (s, u) { return s + u.history.length; }, 0)
            +     '</div>'
            +   '</div>'
            +   '<div style="text-align:center;padding:0 14px;border-left:1px solid var(--border-subtle)">'
            +     '<div style="font-size:.7rem;color:var(--text-3)">🔢 TOKENS</div>'
            +     '<div style="font-weight:700;color:var(--text-1);font-size:1.4rem">'
            +       (projTokens >= 1000 ? (projTokens / 1000).toFixed(1) + 'K' : projTokens)
            +     '</div>'
            +   '</div>'
            +   '<div style="text-align:center;padding:0 14px;border-left:1px solid var(--border-subtle)">'
            +     '<div style="font-size:.7rem;color:var(--text-3)">💸 SPENT</div>'
            +     '<div style="font-weight:700;color:var(--accent);font-size:1.4rem">' + formatTHB(projSpent) + '</div>'
            +   '</div>'
            + '</div>';
        } else {
          banner.classList.add('hidden');
          banner.innerHTML = '';
        }
      }

      // Meta caption next to the filter dropdown
      if (metaEl) {
        metaEl.textContent = selectedProjId
          ? tf('lbl.usersInProjectMeta', { n: users.length }, '· แสดง {n} user ใน project นี้')
          : tf('lbl.usersAllMeta', { shown: users.length, total: allUsersInSystem }, '· แสดง {shown}/{total} users ทั้งหมด');
      }

      // Section title morphs based on filter
      if (listTitle) {
        listTitle.textContent = selectedProj
          ? tf('lbl.usageByUserInProject', { project: selectedProj.name }, 'การใช้งานรายผู้ใช้ใน {project}')
          : t('usage.perUser', 'การใช้งานรายผู้ใช้');
      }

      // Aggregate totals
      var totalTokens = 0, totalCost = 0, totalRequests = 0;
      users.forEach(function (u) {
        totalTokens += u.history.reduce(function (s, h) { return s + (h.inputTokens || 0) + (h.outputTokens || 0); }, 0);
        totalCost += u.history.reduce(function (s, h) { return s + (h.cost || 0); }, 0);
        totalRequests += u.history.length;
      });

      // Summary cards
      if (grid) {
        grid.innerHTML =
          '<div class="mini-card"><div class="mini-card-label">📡 Total Requests</div>' +
          '<div class="mini-card-value">' + totalRequests.toLocaleString() + '</div>' +
          '<div class="mini-card-sub">' + (selectedProj ? tf('lbl.inProject', { project: selectedProj.name }, 'ใน {project}') : t('lbl.allUsersCombined', 'ทุก users รวมกัน')) + '</div></div>' +

          '<div class="mini-card"><div class="mini-card-label">🔢 Total Tokens</div>' +
          '<div class="mini-card-value">' + (totalTokens >= 1000 ? (totalTokens / 1000).toFixed(1) + 'K' : totalTokens) + '</div>' +
          '<div class="mini-card-sub">input + output tokens</div></div>' +

          '<div class="mini-card"><div class="mini-card-label">💸 Total Spent</div>' +
          '<div class="mini-card-value" style="color:var(--accent)">' + formatTHB(totalCost) + '</div>' +
          '<div class="mini-card-sub">' + t('lbl.spentAlready', 'เงินที่ถูกหักไปแล้ว') + '</div></div>' +

          '<div class="mini-card"><div class="mini-card-label">👥 Active Users</div>' +
          '<div class="mini-card-value">' + users.filter(function (u) { return u.history.length > 0; }).length + ' / ' + users.length + '</div>' +
          '<div class="mini-card-sub">' + t('lbl.hasUsageHistory', 'มีประวัติการใช้งาน') + '</div></div>';
      }

      if (!list) return;
      if (users.length === 0) {
        // Phase 16.13: differentiate "no users at all" vs "no users in filter".
        var msg = selectedProj
          ? t('empty.noUsersInProject', 'ไม่มี user ใน project นี้')
          : t('empty.noUsersSystem', 'ยังไม่มี User ในระบบ');
        list.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-3)">' + msg + '</div>';
        return;
      }

      // Sort by most tokens used
      users.sort(function (a, b) {
        var aT = a.history.reduce(function (s, h) { return s + (h.inputTokens || 0) + (h.outputTokens || 0); }, 0);
        var bT = b.history.reduce(function (s, h) { return s + (h.inputTokens || 0) + (h.outputTokens || 0); }, 0);
        return bT - aT;
      });

      var maxTokens = users.reduce(function (m, u) {
        var t = u.history.reduce(function (s, h) { return s + (h.inputTokens || 0) + (h.outputTokens || 0); }, 0);
        return Math.max(m, t);
      }, 1);

      var html = '';
      users.forEach(function (u, idx) {
        var proj = projects.find(function (p) { return p.id === u.projectId; });
        var tokens = u.history.reduce(function (s, h) { return s + (h.inputTokens || 0) + (h.outputTokens || 0); }, 0);
        var spent = u.history.reduce(function (s, h) { return s + (h.cost || 0); }, 0);
        var requests = u.history.length;
        var pct = maxTokens > 0 ? Math.max(1, Math.round((tokens / maxTokens) * 100)) : 0;

        var last20 = u.history.slice(0, 20);
        // Phase 19.3: escape skillName + prompt before inlining. h.prompt is
        // typed by the end user — without escaping a user could plant
        // `<img src=x onerror=...>` in any chat and pop XSS in admin view.
        var histRows = last20.length === 0
          ? '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:16px">' + t('empty.noUsageHistoryRow', 'ยังไม่มีประวัติการใช้งาน') + '</td></tr>'
          : last20.map(function (h, hIdx) {
            var skill  = escapeHtml(h.skillName || '—');
            var emoji  = escapeHtml(h.skillEmoji || '🤖');
            var prompt = escapeHtml(h.prompt || '—');
            // Phase 26: whole row opens the full prompt+response modal — the
            // truncated cell here is just a preview, not the audit trail.
            return '<tr style="cursor:pointer" title="' + escapeHtml(t('vt.clickToView', 'คลิกเพื่อดูข้อความเต็ม')) + '" onclick="admin.openViewTurn(' + idx + ',' + hIdx + ')">' +
              '<td>' + emoji + ' ' + skill + '</td>' +
              '<td class="val">' + (h.inputTokens || 0) + ' / ' + (h.outputTokens || 0) + '</td>' +
              '<td class="val">' + formatTHB(h.cost || 0) + '</td>' +
              '<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-3)">' + prompt + '</td>' +
              '<td style="color:var(--text-3);white-space:nowrap">' + formatDate(h.timestamp) + '</td>' +
              '</tr>';
          }).join('');

        html +=
          '<div class="usage-user-card" id="ucard-' + idx + '">' +
          '<div class="usage-user-header" onclick="admin.toggleUsageDetail(' + idx + ')">' +
          '<div>' +
          '<div class="usage-user-name">👤 ' + escapeHtml(u.displayName || u.username || '') + '</div>' +
          '<div class="usage-user-meta">' + escapeHtml(u.username || '') + (proj ? ' · 📂 ' + escapeHtml(proj.name || '') : '') + '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:10px">' +
          '<span style="font-family:\'Geist Mono\',monospace;font-size:.8rem;color:var(--text-3)">' + formatTHB(spent) + '</span>' +
          '<span style="color:var(--text-3);font-size:1.1rem" id="ucard-arrow-' + idx + '">▸</span>' +
          '</div>' +
          '</div>' +

          '<div class="usage-user-stats">' +
          '<div class="usage-stat-box"><div class="usage-stat-label">Requests</div><div class="usage-stat-val">' + requests + '</div></div>' +
          '<div class="usage-stat-box"><div class="usage-stat-label">Total Tokens</div><div class="usage-stat-val">' + (tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'K' : tokens) + '</div></div>' +
          '<div class="usage-stat-box"><div class="usage-stat-label">Total Spent</div><div class="usage-stat-val" style="color:var(--accent)">' + formatTHB(spent) + '</div></div>' +
          '<div class="usage-stat-box"><div class="usage-stat-label">Balance Left</div><div class="usage-stat-val" style="color:#34d399">' + formatTHB(u.balance) + '</div></div>' +
          '</div>' +

          '<div class="usage-bar-wrap">' +
          '<div class="usage-bar-label"><span>Token usage relative</span><span>' + pct + '%</span></div>' +
          '<div class="usage-bar-track"><div class="usage-bar-fill" style="width:' + pct + '%"></div></div>' +
          '</div>' +

          '<div class="usage-detail-section" id="udetail-' + idx + '">' +
          '<table class="usage-history-table">' +
          '<thead><tr><th>Skill</th><th>Tokens (In/Out)</th><th>' + t('col.cost', 'ค่าใช้จ่าย') + '</th><th>Prompt</th><th>' + t('col.time', 'เวลา') + '</th></tr></thead>' +
          '<tbody>' + histRows + '</tbody>' +
          '</table>' +
          (u.history.length > 20 ? '<div style="text-align:center;color:var(--text-3);font-size:.75rem;padding:8px">' + tf('lbl.showingRecent', { n: u.history.length }, 'แสดง 20 รายการล่าสุด (ทั้งหมด {n} รายการ)') + '</div>' : '') +
          '</div>' +
          '</div>';
      });
      list.innerHTML = html;
      // Phase 26: keep the rendered user list around so row clicks can look
      // up the full prompt/response without re-fetching or re-escaping huge
      // text through an onclick attribute.
      self._usageRenderedUsers = users;
    }).catch(function () {
      if (list) list.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-3)">⚠️ ' + t('empty.loadFailedServer', 'ไม่สามารถโหลดข้อมูลได้ — ตรวจสอบว่า server กำลังรันอยู่') + '</div>';
    });
  },

  // Phase 26: full prompt + response viewer for one chat turn — lets admin
  // reconstruct exactly what a user typed and what the AI answered, e.g.
  // when investigating unexpected charges or odd behaviour.
  openViewTurn: function (uIdx, hIdx) {
    var u = (this._usageRenderedUsers || [])[uIdx];
    var h = u && u.history && u.history[hIdx];
    if (!h) return;
    var set = function (id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
    set('vt-user', u.displayName || u.username || '—');
    set('vt-username', '@' + (u.username || ''));
    set('vt-time', formatDate(h.timestamp));
    set('vt-skill', (h.skillEmoji || '🤖') + ' ' + (h.skillName || '—'));
    set('vt-tokens', tf('vt.tokensInOut', { in: h.inputTokens || 0, out: h.outputTokens || 0 }, 'Tokens {in}/{out}'));
    set('vt-cost', formatTHB(h.cost || 0));
    set('vt-prompt', h.prompt || '—');
    set('vt-response', h.response || '—');
    showModal('modal-view-turn');
  },

  toggleUsageDetail: function (idx) {
    var detail = document.getElementById('udetail-' + idx);
    var card = document.getElementById('ucard-' + idx);
    var arrow = document.getElementById('ucard-arrow-' + idx);
    if (!detail) return;
    var isOpen = detail.classList.contains('open');
    detail.classList.toggle('open', !isOpen);
    if (card) card.classList.toggle('expanded', !isOpen);
    if (arrow) arrow.textContent = isOpen ? '▸' : '▾';
  },

  // ── Phase 21.10: Quota Requests (admin approve/deny) ─────────
  renderQuotaRequests: function () {
    var self = this;
    var wrap = document.getElementById('qr-list-wrap');
    if (!wrap) return;
    wrap.innerHTML = '<div class="qr-loading">' + t('common.loading', '⏳ กำลังโหลด...') + '</div>';
    fetch(BASE + '/api/quota-requests?limit=50', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          wrap.innerHTML = '<div class="qr-empty">⚠ ' + escapeHtml(d.error || 'Failed') + '</div>';
          return;
        }
        var rows = d.requests || [];
        var pending = rows.filter(function (r) { return r.status === 'pending'; }).length;
        var badge = document.getElementById('qr-pending-badge');
        if (badge) {
          badge.textContent = pending;
          badge.style.display = pending > 0 ? 'inline-flex' : 'none';
        }
        if (rows.length === 0) {
          wrap.innerHTML = '<div class="qr-empty">' + t('empty.noQuotaRequests', '📭 ยังไม่มีคำขอเพิ่มโควต้า') + '</div>';
          return;
        }
        self._cachedQuota = rows;   // so the resolve modal can read details
        wrap.innerHTML = rows.map(function (r) { return self._renderQuotaRow(r); }).join('');
      })
      .catch(function (e) {
        wrap.innerHTML = '<div class="qr-empty">⚠ ' + escapeHtml(e.message) + '</div>';
      });
  },

  _renderQuotaRow: function (r) {
    var statusClass = 'qr-status-badge ' + r.status;
    var rowClass    = 'qr-row' + (r.status === 'pending' ? ' pending' : '');
    var dt = new Date(r.created_at);
    var dtStr = dt.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
    var actions;
    if (r.status === 'pending') {
      actions =
        '<button class="qr-btn approve" onclick="admin.resolveQuotaRequest(' + r.request_id + ',\'approve\')">✓ Approve</button>' +
        '<button class="qr-btn deny"    onclick="admin.resolveQuotaRequest(' + r.request_id + ',\'deny\')">✗ Deny</button>';
    } else {
      var resolver = r.resolved_by_display ? t('lbl.resolvedByPrefix', ' โดย ') + escapeHtml(r.resolved_by_display) : '';
      actions = '<span class="' + statusClass + '">' + r.status + '</span>' +
                '<span class="qr-meta" style="margin-left:10px">' + resolver + '</span>';
    }
    return ''
      + '<div class="' + rowClass + '">'
      +   '<div class="qr-info">'
      +     '<div class="qr-line1">'
      +       (r.status === 'pending' ? '<span class="qr-status-badge pending">pending</span>' : '')
      +       '<strong>' + escapeHtml(r.user_display) + '</strong>'
      +       '<span style="color:var(--text-3);font-size:.82rem">' + escapeHtml(t('lbl.requestedIncrease', 'ขอเพิ่ม')) + '</span>'
      +       '<span class="qr-amount">฿' + Number(r.requested_extra).toFixed(2) + '</span>'
      +       '<span style="color:var(--text-3);font-size:.82rem">' + escapeHtml(t('lbl.today', 'วันนี้')) + '</span>'
      +     '</div>'
      +     (r.reason ? '<div class="qr-reason" title="' + escapeHtml(r.reason) + '">' + escapeHtml(t('lbl.reasonPrefix', 'เหตุผล: ')) + escapeHtml(r.reason) + '</div>' : '')
      +     '<div class="qr-meta">'
      +       '<span>📅 ' + dtStr + '</span>'
      +       (r.project_name ? '<span>📦 ' + escapeHtml(r.project_name) + '</span>' : '')
      +     '</div>'
      +   '</div>'
      +   '<div class="qr-actions">' + actions + '</div>'
      + '</div>';
  },

  // Phase 21.13 — open custom approve/deny modal (replaces browser confirm/prompt)
  resolveQuotaRequest: function (id, action) {
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    var row = (this._cachedQuota || []).find(function (x) { return String(x.request_id) === String(id); });
    document.getElementById('qr-resolve-id').value = id;
    document.getElementById('qr-resolve-action').value = action;
    document.getElementById('qr-resolve-note').value = '';
    document.getElementById('qr-resolve-error').textContent = '';

    var titleEl = document.getElementById('qr-resolve-title');
    var btn = document.getElementById('qr-resolve-confirm');
    if (action === 'approve') {
      titleEl.textContent = TT('qr.approveTitle', '✓ อนุมัติคำขอเพิ่มโควต้า');
      btn.textContent = TT('qr.btnApprove', '✓ อนุมัติ');
      btn.className = 'btn-modal-submit';
    } else {
      titleEl.textContent = TT('qr.denyTitle', '✗ ปฏิเสธคำขอเพิ่มโควต้า');
      btn.textContent = TT('qr.btnDeny', '✗ ปฏิเสธ');
      btn.className = 'btn-modal-danger';
    }

    if (row) {
      document.getElementById('qr-resolve-user').textContent = row.user_display || ('user#' + row.user_id);
      document.getElementById('qr-resolve-amount').textContent = '฿' + Number(row.requested_extra).toFixed(2);
      document.getElementById('qr-resolve-project').textContent = row.project_name ? (' · 📦 ' + row.project_name) : '';
      var rRow = document.getElementById('qr-resolve-reason-row');
      if (row.reason) {
        document.getElementById('qr-resolve-reason').textContent = row.reason;
        rRow.style.display = '';
      } else { rRow.style.display = 'none'; }
    }
    showModal('modal-quota-resolve');
  },

  submitQuotaResolve: function () {
    var self = this;
    var id = document.getElementById('qr-resolve-id').value;
    var action = document.getElementById('qr-resolve-action').value;
    var note = document.getElementById('qr-resolve-note').value.trim();
    var errEl = document.getElementById('qr-resolve-error');
    var btn = document.getElementById('qr-resolve-confirm');
    errEl.textContent = '';
    btn.disabled = true;
    fetch(BASE + '/api/quota-requests/' + id + '/resolve', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
      body: JSON.stringify({ action: action, note: note }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        btn.disabled = false;
        if (!d.ok) { errEl.textContent = '❌ ' + (d.message || d.error || 'unknown'); return; }
        hideModal('modal-quota-resolve');
        flash('✅ ' + (action === 'approve' ? t('msg.quotaApproved', 'อนุมัติคำขอแล้ว') : t('msg.quotaDenied', 'ปฏิเสธคำขอแล้ว')));
        self.renderQuotaRequests();
      })
      .catch(function (e) { btn.disabled = false; errEl.textContent = '❌ ' + e.message; });
  },

};
