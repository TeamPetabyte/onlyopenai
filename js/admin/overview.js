// overview.js — หน้า Overview + transaction by date + topup
import { escapeHtml, jsArg, flash, formatMoney, formatTHB, hideModal, showModal } from './helpers.js';

export default {
  // --- Overview ---
  renderOverview: function () {
    var self = this;
    var projects = this._projectsList();
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    var nz = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
    Promise.all([
      this.fetchUsersFromDB(),
      fetch(BASE + '/api/credits', { headers: Auth.authHeaders() })
        .then(function (r) { return r.json(); })
        .then(function (d) { return (d && d.ok && d.credits) ? d.credits : []; })
        .catch(function () { return []; }),
      fetch(BASE + '/api/quota-requests?limit=50', { headers: Auth.authHeaders() })
        .then(function (r) { return r.json(); })
        .then(function (d) { return (d && d.ok && d.requests) ? d.requests : []; })
        .catch(function () { return []; }),
    ]).then(function (results) {
      var dbUsers = results[0] || [];
      var credits = results[1] || [];
      var quota   = results[2] || [];
      self._cachedDBUsers = dbUsers;
      self._cachedCredits = credits;
      projects = self._projectsList();

      // greeting + meta line
      var h = new Date().getHours();
      var greet = h < 12 ? TT('greet.morning', 'Good morning') : h < 18 ? TT('greet.afternoon', 'Good afternoon') : TT('greet.evening', 'Good evening');
      var who = (Auth.getSession() || {}).displayName || (Auth.getSession() || {}).username || 'admin';
      var gEl = document.getElementById('overview-greeting'); if (gEl) gEl.textContent = greet + ', ' + who;
      var pending = quota.filter(function (q) { return q.status === 'pending'; });
      var chatUsers = dbUsers.filter(function (u) { return u.role !== 'admin' && u.role !== 'trainer'; });
      var mEl = document.getElementById('overview-meta');
      if (mEl) mEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
        + ' · ' + projects.length + ' ' + TT('lbl.projects', 'projects') + ' · ' + chatUsers.length + ' ' + TT('lbl.users', 'users')
        + (pending.length ? ' · ' + pending.length + ' ' + TT('lbl.requestsWaiting', 'quota requests waiting') : '');

      // what needs a decision today
      var nearCap = credits.filter(function (c) {
        var cap = c.dailyCap == null ? null : nz(c.dailyCap) + nz(c.bonusBalance);
        return cap && cap > 0 && nz(c.spentToday) / cap >= 0.8;
      });
      var empty = projects.filter(function (p) { return nz(p.lifetimeAmount) > 0 && nz(p.balance) <= 0; });
      var att = function (kind, icon, title, body, btnHtml) {
        return '<div class="ad-att ' + kind + '"><div class="icn"><svg class="ic"><use href="#i-' + icon + '"/></svg></div><div><b>' + title + '</b><p>' + body + '</p>' + btnHtml + '</div></div>';
      };
      var cards = [];
      if (pending.length) {
        cards.push(att('warn', 'gauge', pending.length + ' ' + TT('att.quotaWaiting', 'quota request(s) waiting'),
          pending.slice(0, 2).map(function (q) { return escapeHtml(q.user_display) + ' ' + TT('lbl.asks', 'asks') + ' +฿' + nz(q.requested_extra).toFixed(0); }).join(' · '),
          '<button class="ad-btn sm" onclick="document.getElementById(\'qr-card\').scrollIntoView({behavior:\'smooth\'})">' + TT('att.review', 'Review requests') + '<svg class="ic sm"><use href="#i-arrow"/></svg></button>'));
      }
      empty.slice(0, 1).forEach(function (p) {
        var blocked = credits.filter(function (c) { return c.projectId === p.id; }).length;
        cards.push(att('bad', 'wallet', escapeHtml(p.name) + ' ' + TT('att.outOfCredit', 'is out of credit'),
          '฿0.00 ' + TT('lbl.left', 'left') + (blocked ? ' · ' + blocked + ' ' + TT('lbl.usersBlocked', 'users blocked') : ''),
          '<button class="ad-btn sm primary" onclick="admin.openTopup(\'' + jsArg(p.id) + '\')">' + TT('att.topupNow', 'Top up now') + '</button>'));
      });
      if (nearCap.length) {
        cards.push(att('info', 'users', nearCap.length + ' ' + TT('att.nearCap', 'user(s) near their daily cap'),
          nearCap.slice(0, 3).map(function (c) { var cap = nz(c.dailyCap) + nz(c.bonusBalance); return escapeHtml(c.username) + ' ' + Math.round(nz(c.spentToday) / cap * 100) + '%'; }).join(' · '),
          '<button class="ad-btn sm" onclick="admin.navigate(\'usage\')">' + TT('att.seeUsers', 'See users') + '<svg class="ic sm"><use href="#i-arrow"/></svg></button>'));
      }
      if (!cards.length) {
        cards.push(att('ok', 'check', TT('att.allClear', 'Nothing needs a decision'), TT('att.allClearSub', 'No pending requests, no empty projects, nobody near a cap'), ''));
      }
      var attEl = document.getElementById('overview-attention');
      if (attEl) { attEl.innerHTML = cards.join(''); attEl.style.gridTemplateColumns = 'repeat(' + Math.min(3, cards.length) + ', 1fr)'; }

      // kpi strip
      var totalTokens   = credits.reduce(function (s, c) { return s + nz(c.lifetimeTokens); }, 0);
      var totalSpendAll = credits.reduce(function (s, c) { return s + nz(c.lifetimeSpend); }, 0);
      var totalTopUpAll  = projects.reduce(function (s, p) { return s + nz(p.lifetimeAmount); }, 0);
      var totalBalanceAll = projects.reduce(function (s, p) { return s + nz(p.balance); }, 0);
      var spentToday = credits.reduce(function (s, c) { return s + nz(c.spentToday); }, 0);
      var activeToday = credits.filter(function (c) { return nz(c.spentToday) > 0; }).length;
      var pct = totalTopUpAll > 0 ? Math.round(totalBalanceAll / totalTopUpAll * 100) : 0;
      var kpi = function (k, v, d, extra) { return '<div class="ad-kpi"><span class="k">' + k + '</span><span class="v">' + v + '</span><span class="d">' + d + '</span>' + (extra || '') + '</div>'; };
      document.getElementById('overview-mini').innerHTML =
          kpi(TT('dash.projectBalance', 'Project balance'), formatMoney(totalBalanceAll), TT('dash.balanceOf', 'of') + ' ' + formatMoney(totalTopUpAll) + ' ' + TT('dash.everToppedUp', 'ever topped up'),
              '<div class="ad-bar' + (pct < 20 ? ' bad' : pct < 50 ? ' warn' : '') + '"><i style="width:' + pct + '%"></i></div>')
        + kpi(TT('dash.spentToday', 'Spent today'), formatMoney(spentToday), activeToday + ' ' + TT('dash.usersActiveToday', 'users active today'))
        + kpi(TT('dash.totalSpend', 'Total spend'), formatMoney(totalSpendAll), totalTokens.toLocaleString() + ' ' + TT('dash.tokens', 'tokens'))
        + kpi(TT('dash.users', 'Users'), chatUsers.length.toLocaleString(), projects.length + ' ' + TT('lbl.projects', 'projects'));

      // project rows (right column) — clicking one scopes the detail + transactions
      var saved = self._selectedProject || (projects[0] && projects[0].id) || null;
      self._selectedProject = saved;
      var list = document.getElementById('overview-user-list');
      if (list) {
        list.innerHTML = projects.length === 0
          ? '<div class="ad-empty">' + t('empty.noProjectShort', 'ยังไม่มี Project') + '</div>'
          : projects.map(function (p) {
              var bal = nz(p.balance), life = nz(p.lifetimeAmount);
              var left = life > 0 ? Math.round(bal / life * 100) : 0;
              var members = credits.filter(function (c) { return c.projectId === p.id; }).length;
              var cls = life > 0 && bal <= 0 ? 'bad' : left < 20 ? 'warn' : left >= 50 ? 'ok' : '';
              return '<div class="ad-proj' + (String(p.id) === String(saved) ? ' selected' : '') + '" style="grid-template-columns:1.4fr 1fr 90px" onclick="admin.selectProject(\'' + jsArg(p.id) + '\')">'
                + '<div class="name"><b>' + escapeHtml(p.name) + '</b><span>' + members + ' ' + TT('lbl.members', 'members') + ' · ' + escapeHtml(p.targetRelease || '') + '</span></div>'
                + '<div><span class="k">' + TT('col.balance', 'Balance') + '</span><span class="v"' + (life > 0 && bal <= 0 ? ' style="color:var(--danger)"' : '') + '>' + formatMoney(bal) + '</span></div>'
                + '<div class="ad-bar ' + cls + '"><i style="width:' + Math.max(0, Math.min(100, left)) + '%"></i></div>'
                + '</div>';
            }).join('');
      }
      var picker = document.getElementById('overview-picker');
      if (picker) {
        var savedProj = projects.find(function (x) { return String(x.id) === String(saved); });
        picker.innerHTML = projects.length === 0 ? '' :
            '<input type="hidden" id="project-selector" value="' + escapeHtml(String(saved || '')) + '" />'
          + '<button type="button" class="ad-btn sm" id="overview-project-trigger" onclick="admin.openOverviewProjectDropdown(event)">'
          +   '<svg class="ic sm"><use href="#i-folder"/></svg><span id="overview-project-label">' + escapeHtml(savedProj ? savedProj.name : t('dd.selectProject', '— เลือก Project —')) + '</span><svg class="ic sm"><use href="#i-chevron"/></svg>'
          + '</button>';
      }

      if (saved) { self.renderProjectDetail(saved); self.renderTransactions(saved); }
      else { self.renderTransactions(null); }
      self.renderQuotaRequests(quota);
    });
  },

  selectProject: function (projectId) {
    this._selectedProject = projectId;
    var sel = document.getElementById('project-selector');
    if (sel) sel.value = projectId;
    var p = this._projectsList().find(function (x) { return String(x.id) === String(projectId); });
    var label = document.getElementById('overview-project-label');
    if (label && p) label.textContent = p.name;
    document.querySelectorAll('#overview-user-list .ad-proj').forEach(function (row) {
      row.classList.toggle('selected', row.getAttribute('onclick').indexOf("'" + String(projectId).replace(/'/g, "\\'") + "'") !== -1);
    });
    this.renderProjectDetail(projectId);
    this.renderTransactions(projectId);
  },

  // --- Transaction by date --- day = แถวต่อ event, month = SUM ต่อ (เดือน,user,type)
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
      from = iso(new Date(bkk.getTime() - 29 * 86400000));    // last 30 days
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
    // reset range to the mode's default; date pickers can still override
    var r = this._txDefaultRange(mode);
    this._txFrom = r.from;
    this._txTo   = r.to;
    var inFrom = document.getElementById('tx-from');
    var inTo   = document.getElementById('tx-to');
    if (inFrom) inFrom.value = r.from;
    if (inTo)   inTo.value   = r.to;
    this.renderTransactions(this._selectedProject);
  },

  // export ตาม filter ที่เห็นบนจอ — fetch → blob → anchor
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
    // fetch (not <a href>) so we can read Content-Disposition and surface HTTP errors
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

    wrap.innerHTML = '<div class="ad-empty">' + t('common.loading', 'กำลังโหลด...') + '</div>';

    var qs = '?from=' + encodeURIComponent(this._txFrom)
           + '&to='   + encodeURIComponent(this._txTo)
           + '&groupBy=' + this._txMode;
    if (projectId) qs += '&projectId=' + encodeURIComponent(projectId);

    this._txPage = 1;   // reset to page 1 on every fresh load (date/mode/project change)

    fetch(BASE + '/api/transactions' + qs, { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          wrap.innerHTML = '<div class="ad-error">' + escapeHtml(d.error || 'Failed to load') + '</div>';
          self._renderTxChart(null);
          return;
        }
        self._renderTxChart(d);
        if (d.rows.length === 0) {
          wrap.innerHTML = '<div class="ad-empty">' + t('tx.emptyRange', 'ไม่มี transaction ในช่วงนี้') + '</div>';
          return;
        }
        self._txLastData = d;
        wrap.innerHTML = self._renderTxTable(d);
      })
      .catch(function (e) {
        wrap.innerHTML = '<div class="ad-error">' + escapeHtml(e.message) + '</div>';
      });
  },

  // day-mode แบ่งหน้า 20 แถว จาก payload ที่ cache ไว้ ไม่ fetch ใหม่
  _txPage: 1,
  setTxPage: function (page) {
    if (!this._txLastData) return;
    this._txPage = page;
    var wrap = document.getElementById('tx-table-wrap');
    if (wrap) wrap.innerHTML = this._renderTxTable(this._txLastData);
  },

  // Daily bars from the day-mode rows: usage vs top-up per calendar day (no extra fetch).
  _renderTxChart: function (d) {
    var box = document.getElementById('tx-chart'); var sub = document.getElementById('tx-chart-sub');
    if (!box) return;
    if (!d || d.groupBy === 'month' || !d.rows || !d.rows.length) { box.innerHTML = '<div class="ad-empty">' + t('tx.noChart', 'No daily data in this range') + '</div>'; if (sub) sub.textContent = ''; return; }
    var from = new Date(d.from + 'T00:00:00'), to = new Date(d.to + 'T00:00:00');
    var days = []; for (var t0 = from.getTime(); t0 <= to.getTime(); t0 += 86400000) days.push(new Date(t0));
    var key = function (dt) { return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'); };
    var usage = {}, topup = {};
    d.rows.forEach(function (r) {
      var k = key(new Date(r.created_at)); var amt = Math.abs(Number(r.amount) || 0);
      if (r.type === 'topup') topup[k] = (topup[k] || 0) + amt; else usage[k] = (usage[k] || 0) + amt;
    });
    var max = 1; days.forEach(function (dt) { max = Math.max(max, usage[key(dt)] || 0); });
    var todayKey = key(new Date());
    var bars = days.map(function (dt) {
      var k = key(dt); var u = usage[k] || 0, tp = topup[k] || 0;
      var isTop = tp > 0;
      var h = isTop ? 100 : Math.max(2, Math.round(u / max * 100));
      return '<i class="' + (isTop ? 'top' : '') + (k === todayKey ? ' today' : '') + '" style="height:' + h + '%" title="' + k + ' · usage ' + formatMoney(u) + (isTop ? ' · top-up ' + formatMoney(tp) : '') + '"></i>';
    }).join('');
    var lab = function (dt) { return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
    var mid = days[Math.floor(days.length / 2)];
    box.innerHTML = '<div class="ad-bars">' + bars + '</div><div class="ad-axis"><span>' + lab(days[0]) + '</span><span>' + (mid ? lab(mid) : '') + '</span><span>' + lab(days[days.length - 1]) + '</span></div>';
    var totalU = 0, totalT = 0; Object.keys(usage).forEach(function (k) { totalU += usage[k]; }); Object.keys(topup).forEach(function (k) { totalT += topup[k]; });
    if (sub) sub.textContent = days.length + ' ' + t('lbl.days', 'days') + ' · ' + t('lbl.usage', 'usage') + ' ' + formatMoney(totalU) + ' · ' + t('lbl.topup', 'top-up') + ' ' + formatMoney(totalT);
  },

  // Build the table HTML for either day mode or month mode.
  _renderTxTable: function (d) {
    var isMonth = d.groupBy === 'month';
    var sub = document.getElementById('tx-subtitle');
    var TTx = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    if (sub) sub.textContent = isMonth ? TTx('tx.subMonth', 'สรุปรายเดือนต่อ user') : TTx('tx.subDay', 'ประวัติการเติม credit และการใช้งาน');

    var PAGE_SIZE = 20;
    var totalRows = d.rows.length;
    var totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    var page = isMonth ? 1 : Math.min(Math.max(this._txPage || 1, 1), totalPages);
    this._txPage = page;
    var pageRows = isMonth ? d.rows : d.rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    var chipFor = function (type) {
      var tp = String(type || '').toLowerCase();
      var cls = tp === 'topup' ? 'ok' : tp === 'usage' ? 'bad' : tp === 'bonus' || tp === 'adjustment' ? 'warn' : '';
      return '<span class="ad-chip ' + cls + '">' + escapeHtml(tp || '—') + '</span>';
    };
    var who = function (r) { return '<div class="ad-who"><div><b>' + escapeHtml(r.display_name || r.username || '—') + '</b><span>' + escapeHtml(r.username || '') + '</span></div></div>'; };

    var rows = pageRows.map(function (r) {
      var sign = (r.type === 'usage' || (r.type === 'adjustment' && (r.amount_signed || 0) < 0)) ? 'neg' : 'pos';
      var amountStr = formatMoney(Math.abs(Number(r.amount || 0)));
      if (isMonth) {
        return '<tr><td class="ad-mono">' + escapeHtml(r.period_label) + '</td><td>' + who(r) + '</td><td>' + chipFor(r.type) + '</td>'
          + '<td class="num">' + r.event_count + '</td><td class="num"><span class="' + sign + '">' + (sign === 'pos' ? '+' : '−') + amountStr + '</span></td></tr>';
      }
      var dt = new Date(r.created_at);
      var dateStr = dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var refStr = r.ref_type ? '<span class="ad-code">' + escapeHtml(r.ref_type) + (r.ref_id ? '#' + r.ref_id : '') + '</span>' : '<span class="muted">—</span>';
      return '<tr><td class="ad-mono muted">' + escapeHtml(dateStr) + '</td><td>' + who(r) + '</td><td>' + chipFor(r.type) + '</td><td>' + refStr + '</td>'
        + '<td class="num"><span class="' + sign + '">' + (sign === 'pos' ? '+' : '−') + amountStr + '</span></td></tr>';
    }).join('');

    var headers = isMonth ? ['Month', 'User', 'Type', 'Events', 'Amount'] : ['Date', 'User', 'Type', 'Ref', 'Amount'];
    var ths = headers.map(function (h, i) { return '<th' + (i >= 3 && (isMonth || i === 4) ? ' class="num"' : '') + '>' + h + '</th>'; }).join('');
    var pager = '';
    if (!isMonth && totalPages > 1) {
      var btns = []; for (var i = 1; i <= totalPages; i++) btns.push('<button type="button"' + (i === page ? ' aria-pressed="true"' : '') + ' onclick="admin.setTxPage(' + i + ')">' + i + '</button>');
      pager = '<div class="ad-seg">' + btns.join('') + '</div>';
    }
    return '<table class="ad-table"><thead><tr>' + ths + '</tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="ad-card-foot"><span>' + d.count + ' rows · ' + escapeHtml(d.from) + ' → ' + escapeHtml(d.to) + '</span>' + pager + '</div>';
  },

  // --- Project detail --- hero + budget + 3 mini stats + members
  renderProjectDetail: function (projectId, targetId) {
    var p = (this._cachedDBProjects || []).find(function (x) { return String(x.id) === String(projectId); })
            || Auth.getProjectById(projectId);
    if (!p) return;
    var container = document.getElementById(targetId || 'proj-detail');
    if (!container) return;
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    var nz = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
    var users = (this._cachedCredits || []).filter(function (c) { return String(c.projectId) === String(projectId); });

    var totalTopUp = nz(p.lifetimeAmount != null ? p.lifetimeAmount : p.totalTopUp);
    var pool       = nz(p.balance != null ? p.balance : p.totalTopUp);
    var costBilled = users.reduce(function (s, u) { return s + nz(u.lifetimeSpend); }, 0);
    var spentToday = users.reduce(function (s, u) { return s + nz(u.spentToday); }, 0);
    var isFunded = totalTopUp > 0, isEmpty = pool <= 0;
    var leftPct = isFunded ? Math.max(0, Math.min(100, pool / totalTopUp * 100)) : 0;
    var barCls = !isFunded ? '' : isEmpty ? 'bad' : leftPct < 20 ? 'warn' : leftPct >= 50 ? 'ok' : '';
    var health = !isFunded ? '<span class="ad-chip">' + TT('proj.noCredit', 'ยังไม่มีเครดิต') + '</span>'
      : isEmpty ? '<span class="ad-chip bad"><span class="dot"></span>' + TT('proj.depleted', 'เครดิตหมด') + '</span>'
      : leftPct < 20 ? '<span class="ad-chip warn"><span class="dot"></span>' + TT('proj.low', 'Running low') + '</span>'
      : '<span class="ad-chip ok"><span class="dot"></span>' + TT('proj.healthy', 'Healthy') + '</span>';
    var runway = spentToday > 0 ? Math.floor(pool / spentToday) + ' ' + TT('lbl.days', 'days') : '—';

    var head =
        '<div class="ad-card-head"><h4>' + escapeHtml(p.name) + '</h4>' + health
      +   '<span class="ad-code" title="' + escapeHtml(TT('tt.clickToCopy', 'คลิกเพื่อ copy')) + '" style="cursor:pointer" onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + jsArg(p.id) + '\').then(()=>flash(\'Copied: ' + jsArg(p.id) + '\',\'success\'))">' + escapeHtml(p.id) + '</span>'
      +   '<span class="ad-grow"></span>'
      +   '<button class="ad-btn sm" onclick="admin.openEditProject(\'' + jsArg(p.id) + '\')"><svg class="ic sm"><use href="#i-pencil"/></svg>' + escapeHtml(TT('btn.edit', 'แก้ไข')) + '</button>'
      +   '<button class="ad-btn sm primary" onclick="admin.openTopup(\'' + jsArg(p.id) + '\')"><svg class="ic sm"><use href="#i-plus"/></svg>' + escapeHtml(TT('btn.topupShort', 'Top up')) + '</button>'
      + '</div>';
    var balance =
        '<div class="ad-section">'
      +   '<h5>' + TT('col.balance', 'Balance') + '</h5>'
      +   '<div class="ad-big"' + (isEmpty && isFunded ? ' style="color:var(--danger)"' : '') + '>' + formatMoney(pool) + '</div>'
      +   '<div class="ad-bar ' + barCls + '"><i style="width:' + leftPct + '%"></i></div>'
      +   '<div class="ad-kv"><span>' + TT('proj.lifetimeTopup', 'Lifetime top-up') + '</span><b>' + formatMoney(totalTopUp) + '</b></div>'
      +   '<div class="ad-kv"><span>' + TT('proj.spendCumulative', 'Spend to date') + '</span><b>' + formatMoney(costBilled) + '</b></div>'
      +   '<div class="ad-kv"><span>' + TT('proj.spentToday', 'Spent today') + '</span><b>' + formatMoney(spentToday) + '</b></div>'
      +   '<div class="ad-kv"><span>' + TT('proj.runway', 'Runway at today\'s burn') + '</span><b>' + runway + '</b></div>'
      +   '<div class="ad-kv"><span>' + TT('proj.rates', 'Rate in / out per 1K') + '</span><b>฿' + p.inputRate + ' / ฿' + p.outputRate + '</b></div>'
      +   '<div class="ad-kv"><span>' + TT('proj.release', 'Target release') + '</span><b>' + escapeHtml(p.targetRelease || '—') + '</b></div>'
      +   (p.desc ? '<div style="font-size:12.5px;color:var(--text-3)">' + escapeHtml(p.desc) + '</div>' : '')
      + '</div>';
    var membersRows = users.length === 0
      ? '<div class="ad-empty" style="padding:12px">' + t('empty.noMembersInProject', 'ยังไม่มี member ใน project นี้') + '</div>'
      : users.map(function (u) {
          var hasCap = !(u.dailyCap === null || u.dailyCap === undefined);
          var cap = hasCap ? nz(u.dailyCap) + nz(u.bonusBalance) : null;
          var used = nz(u.spentToday);
          var pct = hasCap && cap > 0 ? Math.min(100, Math.round(used / cap * 100)) : 0;
          var cls = pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : '';
          var initial = (u.displayName || u.username || '?').charAt(0).toUpperCase();
          return '<div class="ad-member"><span class="ad-avatar">' + escapeHtml(initial) + '</span><span>' + escapeHtml(u.displayName || u.username) + '</span>'
            + (hasCap ? '<div class="ad-bar ' + cls + '" style="width:70px"><i style="width:' + pct + '%"></i></div><em>' + pct + '% ' + TT('lbl.today', 'today') + '</em>'
                      : '<em>' + formatMoney(used) + ' ' + TT('lbl.today', 'today') + '</em>')
            + '</div>';
        }).join('');
    var members = '<div class="ad-section"><h5>' + TT('dash.members', 'Members') + ' · ' + users.length + '</h5><div class="ad-stack" style="gap:8px">' + membersRows + '</div></div>';
    container.innerHTML = head + balance + members;
  },

  openTopup: function (projectId) {
    // custom dropdown (hidden input + button); pre-select the given projectId or the first
    var projects = this._projectsList();
    var pid = projectId || (projects[0] && projects[0].id) || '';
    document.getElementById('tu-proj-id').value = pid;
    var p = projects.find(function (x) { return String(x.id) === String(pid); });
    document.getElementById('tu-proj-label').textContent = p ? (p.name) : t('dd.selectProject', '— Select Project —');

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
      items: projects.map(function (p) { return { value: p.id, label: p.name }; }),
      selected: document.getElementById('tu-proj-id').value || '',
      searchable: true,
      placeholder: t('dd.searchProject', 'ค้นหา project...'),
      onPick: function (value, item) {
        document.getElementById('tu-proj-id').value = value || '';
        document.getElementById('tu-proj-label').textContent =
          item ? (item.label) : t('dd.selectProject', '— Select Project —');
      },
    });
  },

  submitTopup: function () {
    var projectId = document.getElementById('tu-proj-id').value;
    var amount = parseFloat(document.getElementById('tu-amount').value);
    var noteEl = document.getElementById('tu-note');
    var note   = noteEl ? noteEl.value.trim() : '';
    var errEl  = document.getElementById('tu-error');
    if (isNaN(amount) || amount <= 0) { errEl.textContent = t('err.invalidAmount', 'กรุณาใส่จำนวนเงินที่ถูกต้อง'); return; }
    var self = this;
    // optional note → tbl_topup_project.note
    var body = { amount: amount };
    if (note) body.note = note;
    fetch(BASE + '/api/projects/' + encodeURIComponent(projectId) + '/topup', {
      method: 'PUT',
      headers: Auth.authHeaders(),
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = t('err.dbRejected', 'DB ปฏิเสธ: ') + (d.error || 'unknown'); return; }
        // Mirror to localStorage for legacy code paths
        Auth.topupProject(projectId, amount);
        hideModal('modal-topup');
        flash(tf('msg.topupSuccess', { amt: formatTHB(amount), total: formatTHB(parseFloat(d.newBalance)) }, 'เติมเงิน {amt} เข้า project แล้ว (DB total {total})'), 'success', 'success');
        // Refresh from DB across all relevant views
        self.fetchProjectsFromDB().then(function () {
          if (self.currentView === 'projects')      self.renderProjectDetail(projectId);
          else if (self.currentView === 'overview') self.renderOverview();
          else if (self.currentView === 'balance')  self.renderBalance();
          else                                      self.renderOverview();
        });
      })
      .catch(function (e) { errEl.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; });
  },
};
