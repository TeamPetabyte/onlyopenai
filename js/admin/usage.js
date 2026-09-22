// usage.js — Usage analytics + dropdown กลาง + quota requests
import { escapeHtml, flash, formatDate, formatTHB, hideModal, showModal } from './helpers.js';

export default {
  // --- Usage Analytics: sticky project filter ('' = everyone) ---
  _usageProjectFilter: '',

  setUsageProjectFilter: function (projectId) {
    this._usageProjectFilter = projectId || '';
    this.renderUsage();
  },

  // --- Shared dropdown: openDropdown(triggerId, {items, selected, searchable, allowEmpty, onPick}) ---
  // The popup is appended to <body> to escape modal overflow.
  _activeDropdown: null,   // the open popup, so toggle can close it

  openDropdown: function (triggerId, opts) {
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
    var placeholder = (opts && opts.placeholder) || 'Search...';

    // Position under the trigger.
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
      // Click handlers capture closure variables; inline onclick can't carry an arbitrary onPick.
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
    // Defer so the click that opened the popup doesn't immediately close it.
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

  // Action-Log filters (generic dropdown)
  _actionFilterTypeItems: [
    { value: 'create_user',          label: 'สร้าง User' },
    { value: 'update_user',          label: 'แก้ไข User' },
    { value: 'delete_user',          label: 'ลบ User' },
    { value: 'update_balance',       label: 'แก้ยอดเงิน' },
    { value: 'admin_reset_password', label: 'รีเซ็ตรหัสผ่าน' },
    { value: 'change_own_password',  label: 'เปลี่ยนรหัสตัวเอง' },
    { value: 'create_project',       label: 'สร้าง Project' },
    { value: 'update_project',       label: 'แก้ไข Project' },
    { value: 'delete_project',       label: 'ลบ Project' },
    { value: 'topup_project',        label: 'เติมเงิน Project' },
  ],
  _actionFilterTargetItems: [
    { value: 'user',    label: 'User' },
    { value: 'project', label: 'Project' },
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
      placeholder: t('dd.searchAction', 'ค้นหา action...'),
      allowEmpty: { label: t('filter.allAction', 'ทุก Action') },
      onPick: function (value, item) {
        document.getElementById('action-log-filter-type').value = value || '';
        document.getElementById('action-log-filter-type-label').textContent =
          item && !item._all ? ((item.emoji ? item.emoji + ' ' : '') + item.label) : t('filter.allAction', 'ทุก Action');
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

  // Overview page project picker (generic dropdown)
  openOverviewProjectDropdown: function (ev) {
    if (ev) ev.stopPropagation();
    var self = this;
    var projects = (this._cachedDBProjects || []).slice()
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    this.openDropdown('overview-project-trigger', {
      items: projects.map(function (p) { return { value: p.id, label: p.name }; }),
      selected: this._selectedProject || (projects[0] && projects[0].id) || '',
      searchable: true,
      placeholder: t('dd.searchProject', 'ค้นหา project...'),
      onPick: function (value, item) {
        var hidden = document.getElementById('project-selector');
        if (hidden) hidden.value = value || '';
        var label = document.getElementById('overview-project-label');
        if (label) label.textContent = item ? (item.label) : t('dd.selectProject', '— เลือก Project —');
        self.selectProject(value);
      },
    });
  },

  // Usage Analytics project filter (generic dropdown)
  toggleUsageProjectDropdown: function (ev) {
    if (ev) ev.stopPropagation();
    var self = this;
    var projects = (this._cachedDBProjects || []).slice()
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    this.openDropdown('usage-filter-trigger', {
      items: projects.map(function (p) { return { value: p.id, label: p.name }; }),
      selected:    this._usageProjectFilter || '',
      searchable:  true,
      placeholder: t('dd.searchProject', 'ค้นหา project...'),
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
    if (grid) grid.innerHTML = '<div class="ad-kpi" style="grid-column:1/-1"><span class="d">' + t('common.loading', 'กำลังโหลด...') + '</span></div>';
    if (list) list.innerHTML = '';
    this.fetchUsersFromDB().then(function (users) {
      // ไม่แสดง admin ใน Usage Analytics
      users = users.filter(function (u) { return u.role !== 'admin' && u.role !== 'trainer'; });
      var projects = self._projectsList();

      // sync the trigger label with state.
      var labelEl = document.getElementById('usage-filter-label');
      if (labelEl) {
        if (self._usageProjectFilter) {
          var p = projects.find(function (x) { return String(x.id) === String(self._usageProjectFilter); });
          labelEl.textContent = p ? p.name : t('filter.allProject', '— ทุก Project —');
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

      // Project banner, only when filtered
      if (banner) {
        if (selectedProj) {
          var projTokens = users.reduce(function (s, u) {
            return s + u.history.reduce(function (ss, h) { return ss + (h.inputTokens || 0) + (h.outputTokens || 0); }, 0);
          }, 0);
          var projSpent = users.reduce(function (s, u) {
            return s + u.history.reduce(function (ss, h) { return ss + (h.cost || 0); }, 0);
          }, 0);
          banner.classList.remove('hidden');
          banner.innerHTML = '<div class="ad-att info" style="display:flex"><div class="icn"><svg class="ic"><use href="#i-folder"/></svg></div><div><b>' + escapeHtml(selectedProj.name) + '</b><p>'
            + users.length + ' users · ' + users.reduce(function (s, u) { return s + u.history.length; }, 0) + ' requests · '
            + (projTokens >= 1000 ? (projTokens / 1000).toFixed(1) + 'K' : projTokens) + ' tokens · ' + formatTHB(projSpent) + ' spent'
            + (selectedProj.desc ? ' · ' + escapeHtml(selectedProj.desc) : '') + '</p></div></div>';
        } else {
          banner.classList.add('hidden');
          banner.innerHTML = '';
        }
      }

      if (metaEl) {
        metaEl.textContent = selectedProjId
          ? tf('lbl.usersInProjectMeta', { n: users.length }, '· แสดง {n} user ใน project นี้')
          : tf('lbl.usersAllMeta', { shown: users.length, total: allUsersInSystem }, '· แสดง {shown}/{total} users ทั้งหมด');
      }

      if (listTitle) {
        listTitle.textContent = selectedProj
          ? tf('lbl.usageByUserInProject', { project: selectedProj.name }, 'การใช้งานรายผู้ใช้ใน {project}')
          : t('usage.perUser', 'การใช้งานรายผู้ใช้');
      }

      var totalTokens = 0, totalCost = 0, totalRequests = 0;
      users.forEach(function (u) {
        totalTokens += u.history.reduce(function (s, h) { return s + (h.inputTokens || 0) + (h.outputTokens || 0); }, 0);
        totalCost += u.history.reduce(function (s, h) { return s + (h.cost || 0); }, 0);
        totalRequests += u.history.length;
      });

      if (grid) {
        var kpi = function (k, v, d) { return '<div class="ad-kpi"><span class="k">' + k + '</span><span class="v">' + v + '</span><span class="d">' + d + '</span></div>'; };
        grid.innerHTML =
            kpi('Requests', totalRequests.toLocaleString(), selectedProj ? tf('lbl.inProject', { project: escapeHtml(selectedProj.name) }, 'ใน {project}') : t('lbl.allUsersCombined', 'ทุก users รวมกัน'))
          + kpi('Tokens', totalTokens >= 1000 ? (totalTokens / 1000).toFixed(1) + 'K' : totalTokens, 'input + output')
          + kpi('Spent', formatTHB(totalCost), t('lbl.spentAlready', 'เงินที่ถูกหักไปแล้ว'))
          + kpi('Active users', users.filter(function (u) { return u.history.length > 0; }).length + ' / ' + users.length, t('lbl.hasUsageHistory', 'มีประวัติการใช้งาน'));
      }

      if (!list) return;
      if (users.length === 0) {
        // differentiate "no users at all" vs "no users in filter".
        var msg = selectedProj
          ? t('empty.noUsersInProject', 'ไม่มี user ใน project นี้')
          : t('empty.noUsersSystem', 'ยังไม่มี User ในระบบ');
        list.innerHTML = '<div class="ad-empty">' + msg + '</div>';
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

      var html = '<table class="ad-table"><thead><tr><th>User</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Spent</th><th style="width:28%">Share</th><th></th></tr></thead><tbody>';
      users.forEach(function (u, idx) {
        var proj = projects.find(function (p) { return p.id === u.projectId; });
        var tokens = u.history.reduce(function (s, h) { return s + (h.inputTokens || 0) + (h.outputTokens || 0); }, 0);
        var spent = u.history.reduce(function (s, h) { return s + (h.cost || 0); }, 0);
        var requests = u.history.length;
        var pct = maxTokens > 0 ? Math.max(1, Math.round((tokens / maxTokens) * 100)) : 0;
        var initial = (u.displayName || u.username || '?').charAt(0).toUpperCase();
        var last20 = u.history.slice(0, 20);
        var histRows = last20.length === 0
          ? '<tr><td colspan="5" class="muted" style="text-align:center">' + t('empty.noUsageHistoryRow', 'ยังไม่มีประวัติการใช้งาน') + '</td></tr>'
          : last20.map(function (h, hIdx) {
            return '<tr class="click" title="' + escapeHtml(t('vt.clickToView', 'คลิกเพื่อดูข้อความเต็ม')) + '" onclick="admin.openViewTurn(' + idx + ',' + hIdx + ')">'
              + '<td>' + escapeHtml(h.skillName || '—') + '</td>'
              + '<td class="num">' + (h.inputTokens || 0).toLocaleString() + ' / ' + (h.outputTokens || 0).toLocaleString() + '</td>'
              + '<td class="num">' + formatTHB(h.cost || 0) + '</td>'
              + '<td class="muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(h.prompt || '—') + '</td>'
              + '<td class="muted ad-mono" style="white-space:nowrap">' + formatDate(h.timestamp) + '</td></tr>';
          }).join('');
        html +=
            '<tr class="click" id="ucard-' + idx + '" onclick="admin.toggleUsageDetail(' + idx + ')">'
          +   '<td><div class="ad-who"><span class="ad-avatar">' + escapeHtml(initial) + '</span><div><b>' + escapeHtml(u.displayName || u.username || '') + '</b><span>' + escapeHtml(u.username || '') + (proj ? ' · ' + escapeHtml(proj.name || '') : '') + '</span></div></div></td>'
          +   '<td class="num">' + requests + '</td>'
          +   '<td class="num">' + (tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'K' : tokens) + '</td>'
          +   '<td class="num">' + formatTHB(spent) + '</td>'
          +   '<td><div class="ad-cap"><div class="ad-bar"><i style="width:' + pct + '%"></i></div><span class="t">' + pct + '%</span></div></td>'
          +   '<td class="num"><span class="muted" id="ucard-arrow-' + idx + '">▸</span></td>'
          + '</tr>'
          + '<tr class="usage-detail-row" id="udetail-' + idx + '" style="display:none"><td colspan="6" style="padding:0;background:var(--surface-3)">'
          +   '<table class="ad-table" style="font-size:12.5px"><thead><tr><th>Skill</th><th class="num">Tokens in / out</th><th class="num">' + t('col.cost', 'ค่าใช้จ่าย') + '</th><th>Prompt</th><th>' + t('col.time', 'เวลา') + '</th></tr></thead><tbody>' + histRows + '</tbody></table>'
          +   (u.history.length > 20 ? '<div class="ad-card-foot">' + tf('lbl.showingRecent', { n: u.history.length }, 'แสดง 20 รายการล่าสุด (ทั้งหมด {n} รายการ)') + '</div>' : '')
          + '</td></tr>';
      });
      html += '</tbody></table>';
      list.innerHTML = html;
      // เก็บ list ที่ render แล้ว — คลิกแถวเปิด prompt เต็มโดยไม่ fetch/escape ซ้ำ
      self._usageRenderedUsers = users;
    }).catch(function () {
      if (list) list.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-3)">⚠️ ' + t('empty.loadFailedServer', 'ไม่สามารถโหลดข้อมูลได้ — ตรวจสอบว่า server กำลังรันอยู่') + '</div>';
    });
  },

  // viewer เต็มของ turn เดียว — ไว้ไล่เคสค่าใช้จ่ายแปลก ๆ
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
    var isOpen = detail.style.display !== 'none';
    detail.style.display = isOpen ? 'none' : '';
    if (card) card.classList.toggle('selected', !isOpen);
    if (arrow) arrow.textContent = isOpen ? '▸' : '▾';
  },

  // --- Quota Requests (admin approve/deny) ---
  renderQuotaRequests: function (preloaded) {
    var self = this;
    var wrap = document.getElementById('qr-list-wrap');
    if (!wrap) return;
    var paint = function (rows) {
      var pending = rows.filter(function (r) { return r.status === 'pending'; }).length;
      var badge = document.getElementById('qr-pending-badge');
      if (badge) { badge.textContent = pending; badge.style.display = pending > 0 ? 'inline-grid' : 'none'; }
      if (rows.length === 0) { wrap.innerHTML = '<div class="ad-empty">' + t('empty.noQuotaRequests', 'ยังไม่มีคำขอเพิ่มโควต้า') + '</div>'; return; }
      self._cachedQuota = rows;
      var pend = rows.filter(function (r) { return r.status === 'pending'; });
      var done = rows.filter(function (r) { return r.status !== 'pending'; }).slice(0, 5);
      wrap.innerHTML = pend.concat(done).map(function (r) { return self._renderQuotaRow(r); }).join('')
        + '<div class="ad-card-foot"><span>' + rows.length + ' ' + t('lbl.requestsTotal', 'requests') + ' · ' + pending + ' ' + t('lbl.pending', 'pending') + '</span></div>';
    };
    if (Array.isArray(preloaded)) { paint(preloaded); return; }
    wrap.innerHTML = '<div class="ad-empty">' + t('common.loading', 'กำลังโหลด...') + '</div>';
    fetch(BASE + '/api/quota-requests?limit=50', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { wrap.innerHTML = '<div class="ad-error">' + escapeHtml(d.error || 'Failed') + '</div>'; return; }
        paint(d.requests || []);
      })
      .catch(function (e) { wrap.innerHTML = '<div class="ad-error">' + escapeHtml(e.message) + '</div>'; });
  },

  _renderQuotaRow: function (r) {
    var dt = new Date(r.created_at);
    var dtStr = dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var initial = (r.user_display || '?').charAt(0).toUpperCase();
    var status = r.status === 'pending' ? '<span class="ad-chip warn">' + t('qr.pending', 'Pending') + '</span>'
      : r.status === 'approved' ? '<span class="ad-chip ok">' + t('qr.approved', 'Approved') + '</span>'
      : '<span class="ad-chip bad">' + t('qr.denied', 'Denied') + '</span>';
    var act = r.status === 'pending'
      ? '<div class="act"><button class="ad-btn sm primary" onclick="admin.resolveQuotaRequest(' + r.request_id + ',\'approve\')"><svg class="ic sm"><use href="#i-check"/></svg>' + escapeHtml(t('qr.btnApprove', 'อนุมัติ')) + '</button>'
        + '<button class="ad-btn sm ghost" onclick="admin.resolveQuotaRequest(' + r.request_id + ',\'deny\')">' + escapeHtml(t('qr.btnDeny', 'ปฏิเสธ')) + '</button></div>'
      : '';
    return '<div class="ad-req">'
      + '<div class="top"><span class="ad-avatar">' + escapeHtml(initial) + '</span><b>' + escapeHtml(r.user_display) + '</b>' + status
      +   '<span class="amt">+<b>฿' + Number(r.requested_extra).toFixed(0) + '</b> ' + escapeHtml(t('lbl.today', 'วันนี้')) + '</span></div>'
      + (r.reason ? '<div class="why">' + escapeHtml(r.reason) + '</div>' : '')
      + '<div class="meta">' + (r.project_name ? escapeHtml(r.project_name) + ' · ' : '') + dtStr
      +   (r.resolved_by_display ? ' · ' + escapeHtml(t('lbl.resolvedByPrefix', 'by ')) + escapeHtml(r.resolved_by_display) : '') + '</div>'
      + act
      + '</div>';
  },

  // open the custom approve/deny modal
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
      titleEl.textContent = TT('qr.approveTitle', 'อนุมัติคำขอเพิ่มโควต้า');
      btn.textContent = TT('qr.btnApprove', 'อนุมัติ');
      btn.className = 'btn-modal-submit';
    } else {
      titleEl.textContent = TT('qr.denyTitle', 'ปฏิเสธคำขอเพิ่มโควต้า');
      btn.textContent = TT('qr.btnDeny', 'ปฏิเสธ');
      btn.className = 'btn-modal-danger';
    }

    if (row) {
      document.getElementById('qr-resolve-user').textContent = row.user_display || ('user#' + row.user_id);
      document.getElementById('qr-resolve-amount').textContent = '฿' + Number(row.requested_extra).toFixed(2);
      document.getElementById('qr-resolve-project').textContent = row.project_name ? (' · ' + row.project_name) : '';
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
        if (!d.ok) { errEl.textContent = (d.message || d.error || 'unknown'); return; }
        hideModal('modal-quota-resolve');
        flash('' + (action === 'approve' ? t('msg.quotaApproved', 'อนุมัติคำขอแล้ว') : t('msg.quotaDenied', 'ปฏิเสธคำขอแล้ว')), 'success');
        self.renderQuotaRequests();
      })
      .catch(function (e) { btn.disabled = false; errEl.textContent = e.message; });
  },
};
