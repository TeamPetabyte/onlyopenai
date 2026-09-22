// credits.js — หน้า Credit / daily cap
import { escapeHtml, jsArg, flash, formatMoney, hideModal, showModal } from './helpers.js';

export default {
  // เรนเดอร์จาก cache ทันทีถ้ามี แล้ว fetch สดมาทับ — หน้าจอไม่ว่างเปล่า
  renderBalance: function () {
    var self = this;
    var balEl = document.getElementById('balance-table');
    var hisEl = document.getElementById('topup-history-table');

    if (this._cachedDBProjects && this._cachedDBProjects.length) {
      this._renderBalanceTable(this._cachedDBProjects);
    } else if (balEl) {
      balEl.innerHTML = '<tbody><tr><td class="ad-empty">' + t('common.loading', 'กำลังโหลด...') + '</td></tr></tbody>';
    }
    if (hisEl) hisEl.innerHTML = '<tbody><tr><td class="ad-empty">' + t('common.loading', 'กำลังโหลด...') + '</td></tr></tbody>';

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

  // ฟอร์แมตเฉพาะหน้า balance ("THB 2,050.00")
  _formatBahtFmt: function (n) {
    var v = parseFloat(n || 0);
    return 'THB ' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  _renderBalanceTable: function (projects) {
    var el = document.getElementById('balance-table');
    if (!el) return;
    if (!projects.length) { el.innerHTML = '<tbody><tr><td class="ad-empty">' + t('empty.noProjectsTable', 'ยังไม่มี project') + '</td></tr></tbody>'; return; }
    var nz = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
    var total = 0;
    var rows = projects.map(function (p) {
      var bal = nz(p.balance != null ? p.balance : p.totalTopUp); total += bal;
      var life = nz(p.lifetimeAmount);
      var note = life > 0 && bal <= 0 ? '<span style="color:var(--danger)">' + t('proj.depleted', 'out of credit') + '</span>' : (p.desc ? escapeHtml(p.desc) : escapeHtml(t('proj.lifetimeTopup', 'Lifetime top-up')) + ' ' + formatMoney(life));
      return '<tr><td><b>' + escapeHtml(p.name) + '</b><span style="display:block;font-size:11.5px;color:var(--text-3)">' + note + '</span></td>'
        + '<td class="num"' + (life > 0 && bal <= 0 ? ' style="color:var(--danger)"' : '') + '>' + formatMoney(bal) + '</td>'
        + '<td class="num"><button class="ad-btn sm" onclick="admin.openTopup(\'' + jsArg(p.id) + '\')"><svg class="ic sm"><use href="#i-plus"/></svg>' + t('btn.topupShort', 'Top up') + '</button></td></tr>';
    }).join('');
    el.innerHTML = '<thead><tr><th>' + t('col.project', 'Project') + '</th><th class="num">' + t('col.balance', 'Balance') + '</th><th></th></tr></thead><tbody>' + rows
      + '<tr><td><b>' + t('lbl.total', 'Total') + '</b></td><td class="num"><b>' + formatMoney(total) + '</b></td><td></td></tr></tbody>';
  },

  _renderTopupHistoryTable: function (history) {
    var el = document.getElementById('topup-history-table');
    if (!el) return;
    if (!history.length) { el.innerHTML = '<tbody><tr><td class="ad-empty">' + t('empty.noTopupHistory', 'ยังไม่มีประวัติการเติมเงิน') + '</td></tr></tbody>'; return; }
    var rows = history.map(function (h) {
      var d = new Date(h.createdAt);
      var when = isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return '<tr><td class="ad-mono muted" style="white-space:nowrap">' + when + '</td>'
        + '<td>' + escapeHtml(h.projectName || h.projectId || '—') + (h.note ? '<span style="display:block;font-size:11.5px;color:var(--text-3)">' + escapeHtml(h.note) + '</span>' : '') + '</td>'
        + '<td class="muted">' + escapeHtml(h.userName || ('user#' + h.userId)) + '</td>'
        + '<td class="num"><span class="pos">+' + formatMoney(h.amount) + '</span></td></tr>';
    }).join('');
    el.innerHTML = '<thead><tr><th>' + t('col.date', 'Date') + '</th><th>' + t('col.project', 'Project') + '</th><th>' + t('col.by', 'By') + '</th><th class="num">' + t('col.amount', 'Amount') + '</th></tr></thead><tbody>' + rows + '</tbody>';
  },

  // Credits page: สองแท็บ Credit Management + Usage Analytics
  _currentCreditsTab: 'credit',

  renderCredits: function () {
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
    // poll the Cap table so "used today" stays live; cleared when leaving the tab.
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

  // Snapshot from /api/credits so the Edit modal needs no second round-trip.
  _cachedCredits: [],

  renderCreditManagement: function (silent) {
    var self = this;
    var tableEl = document.getElementById('credit-table');
    if (!tableEl) return;
    // silent=true (poll refresh): keep current rows on screen, no spinner flicker.
    if (!silent) {
      tableEl.innerHTML = '<tbody><tr><td class="ad-empty">' + t('common.loading', 'กำลังโหลด...') + '</td></tr></tbody>';
    }
    fetch(BASE + '/api/credits', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok || !Array.isArray(d.credits)) {
          tableEl.innerHTML = '<tbody><tr><td class="ad-empty">' + t('empty.noDataFound', 'ไม่พบข้อมูล') + '</td></tr></tbody>';
          return;
        }
        self._cachedCredits = d.credits;
        self._renderCreditTable(d.credits);
      })
      .catch(function (e) {
        tableEl.innerHTML = '<tbody><tr><td colspan="6" style="text-align:center;color:#d04545;padding:24px">⚠ ' + escapeHtml(e.message) + '</td></tr></tbody>';
      });
  },

  // ตาราง Cap — เงินอยู่ที่ pool, daily_cap ของ user คือเพดาน
  _renderCreditTable: function (rows) {
    var el = document.getElementById('credit-table');
    var kp = document.getElementById('cap-kpis');
    if (!el) return;
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    var nz = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
    var spentToday = rows.reduce(function (s, r) { return s + nz(r.spentToday); }, 0);
    var withCap = rows.filter(function (r) { return r.projectId && r.dailyCap != null; });
    var near = withCap.filter(function (r) { var cap = nz(r.dailyCap) + nz(r.bonusBalance); return cap > 0 && nz(r.spentToday) / cap >= 0.8 && nz(r.spentToday) < cap; }).length;
    var blocked = withCap.filter(function (r) { var cap = nz(r.dailyCap) + nz(r.bonusBalance); return cap > 0 && nz(r.spentToday) >= cap; }).length;
    var active = rows.filter(function (r) { return nz(r.spentToday) > 0; }).length;
    var kpi = function (k, v, d, color) { return '<div class="ad-kpi"><span class="k">' + k + '</span><span class="v"' + (color ? ' style="color:' + color + '"' : '') + '>' + v + '</span><span class="d">' + d + '</span></div>'; };
    if (kp) kp.innerHTML = kpi(TT('cap.spentToday', 'Spent today'), formatMoney(spentToday), active + ' ' + TT('lbl.of', 'of') + ' ' + rows.length + ' ' + TT('lbl.usersActive', 'users active'))
      + kpi(TT('cap.withCap', 'Users with a cap'), withCap.length, (rows.length - withCap.length) + ' ' + TT('cap.unlimited', 'unlimited'))
      + kpi(TT('cap.nearCap', 'Near cap (≥80%)'), near, TT('cap.nearCapSub', 'the chat warns them at 80%'), near ? 'var(--warning)' : '')
      + kpi(TT('cap.blocked', 'Blocked today'), blocked, TT('cap.blockedSub', 'sends refused at 100%'), blocked ? 'var(--danger)' : '');
    if (!rows.length) {
      el.innerHTML = '<tbody><tr><td class="ad-empty">' + t('empty.noUsersShort', 'ยังไม่มี user') + '</td></tr></tbody>';
      return;
    }
    var tbody = rows.map(function (r) {
      var noProject = !r.projectId;
      var hasCap = !(r.dailyCap === null || r.dailyCap === undefined);
      var base = hasCap ? nz(r.dailyCap) : null;
      var bonus = nz(r.bonusBalance);
      var effective = hasCap ? base + bonus : null;
      var spent = nz(r.spentToday);
      var initial = (r.displayName || r.username || '?').charAt(0).toUpperCase();
      var usedCell;
      if (noProject) usedCell = '<span class="muted">—</span>';
      else if (!hasCap) usedCell = '<div class="ad-cap"><div class="ad-bar"><i style="width:0"></i></div><span class="t">' + formatMoney(spent) + ' · ' + TT('val.unlimited', 'ไม่จำกัด') + '</span></div>';
      else {
        var ratio = effective > 0 ? Math.min(1, spent / effective) : (spent > 0 ? 1 : 0);
        var pct = Math.round(ratio * 100);
        usedCell = '<div class="ad-cap"><div class="ad-bar ' + (ratio >= 1 ? 'bad' : ratio >= 0.8 ? 'warn' : '') + '"><i style="width:' + pct + '%"></i></div><span class="t">' + formatMoney(spent) + ' · ' + pct + '%</span></div>';
      }
      var capCell = !hasCap ? '<span class="muted">' + TT('val.unlimited', 'ไม่จำกัด') + '</span>' : formatMoney(base);
      var bonusCell = bonus > 0 ? '<span class="ad-chip ok">+' + formatMoney(bonus) + ' ' + TT('lbl.today', 'today') + '</span>' : '<span class="muted">—</span>';
      return '<tr>'
        + '<td><div class="ad-who"><span class="ad-avatar">' + escapeHtml(initial) + '</span><div><b>' + escapeHtml(r.displayName || r.username) + '</b><span>' + escapeHtml(r.username) + (r.projectName ? ' · ' + escapeHtml(r.projectName) : '') + '</span></div></div></td>'
        + '<td style="width:30%">' + usedCell + '</td>'
        + '<td class="num">' + capCell + '</td>'
        + '<td>' + bonusCell + '</td>'
        + '<td class="num">' + (noProject ? '—' : formatMoney(r.projectBalance)) + '</td>'
        + '<td><div class="ad-acts"><button class="ad-btn sm" ' + (noProject ? 'disabled' : '') + ' onclick="admin.openEditCap(' + r.userId + ')"><svg class="ic sm"><use href="#i-pencil"/></svg>' + escapeHtml(TT('tt.setDailyCap', 'ตั้ง Daily Cap')) + '</button></div></td>'
        + '</tr>';
    }).join('');
    el.innerHTML =
        '<thead><tr><th>' + TT('col.user', 'User') + '</th><th>' + TT('col.usedToday', 'Used today') + '</th><th class="num">' + TT('col.dailyCap', 'Daily Cap') + '</th><th>' + TT('col.bonus', 'Bonus') + '</th><th class="num">' + TT('col.projectPool', 'Project pool') + '</th><th></th></tr></thead>'
      + '<tbody>' + tbody + '</tbody>';
  },

  // Open the Daily Cap editor for a user.
  openEditCap: function (userId) {
    var row = (this._cachedCredits || []).find(function (x) { return x.userId === userId; });
    if (!row) { flash(t('err.userNotFound', 'ไม่พบ user'), 'error'); return; }
    if (!row.projectId) { flash(t('err.userNoProject', 'user ยังไม่มี project'), 'error'); return; }
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
        errEl.textContent = t('err.dailyCapInvalid', 'Daily Cap ต้องเป็นตัวเลข ≥ 0 (หรือเลือก "ไม่จำกัด")');
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
        if (!d.ok) { errEl.textContent = (d.error || 'failed'); btn.disabled = false; return; }
        hideModal('modal-edit-credit');
        flash(dailyCap === null
          ? t('msg.dailyCapRemoved', 'ลบ Daily Cap แล้ว (ไม่จำกัด)')
          : tf('msg.dailyCapSet', { cap: dailyCap }, 'ตั้ง Daily Cap = ฿{cap}/วัน เรียบร้อย'), 'success');
        self.renderCreditManagement();
      })
      .catch(function (e) {
        errEl.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        btn.disabled = false;
      });
  },
};
