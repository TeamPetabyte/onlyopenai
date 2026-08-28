// usage.js — Usage analytics + dropdown กลาง + quota requests
import { escapeHtml, flash, formatDate, formatTHB, hideModal, showModal } from './helpers.js';

export default {
  // ── USAGE ANALYTICS ── filter project แบบ sticky ('' = ทุกคน)
  _usageProjectFilter: '',

  setUsageProjectFilter: function (projectId) {
    this._usageProjectFilter = projectId || '';
    this.renderUsage();
  },

  // ── dropdown กลาง ── single-select ธีมเดียวกันทั้งแอป: openDropdown(triggerId,{items,selected,searchable,allowEmpty,onPick})
  // popup แปะที่ <body> เพื่อหนี overflow ของ modal
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
      users = users.filter(function (u) { return u.role !== 'admin' && u.role !== 'trainer'; });
      var projects = self._projectsList();

      // custom dropdown — sync the trigger label with state.
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
        // differentiate "no users at all" vs "no users in filter".
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
        // escape skillName+prompt ก่อน inline — prompt คือข้อความที่ user พิมพ์ ปลูก XSS ได้
        var histRows = last20.length === 0
          ? '<tr><td colspan="5" style="text-align:center;color:var(--text-3);padding:16px">' + t('empty.noUsageHistoryRow', 'ยังไม่มีประวัติการใช้งาน') + '</td></tr>'
          : last20.map(function (h, hIdx) {
            var skill  = escapeHtml(h.skillName || '—');
            var emoji  = escapeHtml(h.skillEmoji || '🤖');
            var prompt = escapeHtml(h.prompt || '—');
            // whole row opens the full prompt+response modal — the
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
