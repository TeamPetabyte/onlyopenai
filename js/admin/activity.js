// activity.js — Activity log (audit + action)
import { escapeHtml, flash, formatDate, formatTHB, hideModal, showModal } from './helpers.js';

export default {
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
      // escape ทุกสตริงจาก DB — displayName ตั้งเองได้ ไม่ escape = stored XSS ในหน้า admin
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
    // จำกัด query แค่ view Activity — .audit-tab ถูกใช้ซ้ำใน Credits/Usage ด้วย
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

  // ── Login/Logout history ── เอาเฉพาะแถว login_ok — ข้อมูล logout อยู่ในแถวเดียวกันแล้ว (แถว event อื่นเคยโชว์เป็น ghost login)
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
          // log_out_time NULL = ยังไม่บันทึก logout — โชว์ "—" ไม่ใช่ "ยังออนไลน์" (ข้อมูลเก่าก็ NULL ได้)
          var outFmt = outDt ? formatDate(outDt.toISOString()) : '<span style="color:var(--text-3)">—</span>';
          // escape user-provided fields (display_name, username,
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

  // ── Admin actions history ── ป้าย action + variant สี รวมไว้ที่เดียว
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

  // สร้างช่องรายละเอียดจาก change_json — field: before → after + raw JSON ใน <details>
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

    // filters are hidden inputs now (custom dropdowns above)
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

  // modal พิมพ์ยืนยัน "DELETE" — แทน window.confirm ที่ลบประวัติทุกคนได้ในคลิกเดียว
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
};
