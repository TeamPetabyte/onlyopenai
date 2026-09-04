// overview.js — หน้า Overview + transaction by date + topup
import { escapeHtml, jsArg, flash, formatMoney, formatTHB, hideModal, showModal } from './helpers.js';

export default {
  // ── OVERVIEW ──────────────────────────────────────────
  renderOverview: function () {
    var self = this;
    var projects = this._projectsList();
    // ดึง rollup ต่อ user สดจาก /api/credits — dashboard สะท้อน pool model ไม่ใช่ localStorage
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
      // mini-card แบบเดียวกับ stat-card ของ project + แถบสี accent ซ้าย
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
        // two related but distinct numbers — lifetime sum of every
        // top-up (never decreases) vs. current redeemable balance.
        + miniCard('💰', TT('dash.lifetimeTopup','Lifetime Top-up'), formatMoney(totalTopUpAll), TT('dash.topupSub','ยอดสะสมที่ลูกค้าเคยเติม'))
        + miniCard('🏦', TT('dash.projectBalance','Project Balance'), formatMoney(totalBalanceAll), TT('dash.balanceSub','ยอดคงเหลือกองกลางตอนนี้'));

      var saved = self._selectedProject || (projects[0] && projects[0].id) || null;
      // project picker เป็น dropdown custom — hidden input คงค่าให้ selectProject เดิมใช้ต่อ
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

      // .budget-bar / .budget-bar-fill styles moved to
      // css/components.css — no more runtime <style> injection here.

      if (saved) {
        self.renderProjectDetail(saved);
        // transaction journal is project-scoped — render
        // alongside the project detail so both stay in sync.
        self.renderTransactions(saved);
      } else {
        self.renderTransactions(null);
      }
      // quota requests are global (not per-project) — always render.
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

  // ── Transaction by Date ── day = แถวต่อ event, month = SUM ต่อ (เดือน,user,type); state จำไว้บน instance
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
    // Use fetch (not <a href>) so we can read Content-Disposition for the
    // filename and surface HTTP errors (auth rides in the cookie either way).
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

  // day-mode แบ่งหน้า 20 แถว จาก payload ที่ cache ไว้ ไม่ fetch ใหม่
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

  // project detail: hero + budget รวม + mini stats 3 ใบ + แถวสมาชิก
  renderProjectDetail: function (projectId) {
    var self = this;
    // pull project from the DB cache (Auth.getProjectById reads
    // legacy localStorage which doesn't have `balance` / `lifetimeAmount`).
    var p = (this._cachedDBProjects || []).find(function (x) { return x.id === projectId; })
            || Auth.getProjectById(projectId);
    if (!p) return;
    var container = document.getElementById('proj-detail');
    if (!container) return;
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };

    // สมาชิกมาจาก /api/credits (DB จริง) — เงินอยู่ที่ pool ไม่มี "แจกเข้า user" แล้ว
    var nz = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
    var users = (this._cachedCredits || []).filter(function (c) { return c.projectId === projectId; });

    // totalTopUp = เติมสะสม, pool = คงเหลือ, costBilled = Σ spend สมาชิก
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
      +       '<span title="คลิกเพื่อ copy" onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + jsArg(p.id) + '\').then(()=>flash(\'✓ Copied: ' + jsArg(p.id) + '\'))" '
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
      +     ' onclick="admin.openTopup(\'' + jsArg(p.id) + '\')">' + TT('btn.topupProject','+ เติมเงิน Project') + '</button>'
      + '</div>';

    // การ์ด budget สามสถานะ: not-funded / depleted / normal
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
      // แถวสมาชิก read-only — แก้ได้ที่หน้า Users/Cap เท่านั้น
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
    // project picker is now a custom dropdown (hidden input + button).
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
};
