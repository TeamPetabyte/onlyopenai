// credits.js — หน้า Credit / daily cap
import { escapeHtml, jsArg, flash, hideModal, showModal } from './helpers.js';

export default {
  // เรนเดอร์จาก cache ทันทีถ้ามี แล้ว fetch สดมาทับ — หน้าจอไม่ว่างเปล่า
  renderBalance: function () {
    var self = this;
    var balEl = document.getElementById('balance-table');
    var hisEl = document.getElementById('topup-history-table');

    // cached render (instant)
    if (this._cachedDBProjects && this._cachedDBProjects.length) {
      this._renderBalanceTable(this._cachedDBProjects);
    } else if (balEl) {
      balEl.innerHTML = '<tbody><tr><td colspan="3" style="text-align:center;color:var(--text-3);padding:24px">⏳ กำลังโหลด...</td></tr></tbody>';
    }
    if (hisEl) hisEl.innerHTML = '<tbody><tr><td colspan="4" style="text-align:center;color:var(--text-3);padding:24px">⏳ กำลังโหลด...</td></tr></tbody>';

    // fresh fetch (always)
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

  // ฟอร์แมตเฉพาะหน้า balance ("THB 2,050.00" ตาม mockup) — formatTHB กลางคงเดิม
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
            + 'title="Top up" onclick="admin.openTopup(\'' + jsArg(p.id) + '\')">+</button>'
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

  // ── CREDITS PAGE ── สองแท็บ: Credit Management (delta model) + Usage Analytics
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
    // poll the Cap Management table so "used today" + project
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

  // ตาราง Cap — เงินอยู่ที่ pool, daily_cap ของ user คือเพดาน
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
};
