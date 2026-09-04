// users.js — หน้า Users + modal เพิ่ม/แก้/ลบ/รีเซ็ตรหัส
import { escapeHtml, flash, formatDateStd, formatTHB, hideModal, showModal } from './helpers.js';

export default {
  // ── USERS PAGE ── filter แบบ sticky: Set ของ project ids, "__none__" = ไม่มี project
  _userProjectFilter: null,   // Set | null (null = uninitialised, treated as "all")

  // ตารางเป็น row-cards ให้เข้าชุดกับหน้าอื่น — filter อยู่ header bar
  renderUsers: function () {
    var self = this;
    var tableEl = document.getElementById('user-table');
    if (tableEl) tableEl.innerHTML =
      '<div style="padding:32px;text-align:center;color:var(--text-3);font-size:.85rem;'
      + 'background:var(--surface-2);border:1px solid var(--border-default);border-radius:10px">'
      + '⏳ กำลังโหลด...</div>';

    this.fetchUsersFromDB().then(function (users) {
      self._cachedDBUsers = users;
      users = users.filter(function (u) { return u.role !== 'admin' && u.role !== 'trainer'; });
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
    // pill สถานะกดได้ → toggleUserStatus(username) — ตาราง key ด้วย username อยู่แล้ว
    var s = String(status || 'active').toLowerCase();
    var label = s.charAt(0).toUpperCase() + s.slice(1);
    // inactive เป็นแดงเหมือน locked (ทั้งคู่ = ห้าม login) — ต่างกันที่ป้าย
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

  // badge click → custom confirm modal (no more browser confirm()).
  // Pending action stash so confirmStatusToggle() knows what to PUT.
  _pendingStatusToggle: null,    // { user, next:'active'|'inactive', nextId:1|2 }

  toggleUserStatus: function (username, ev) {
    if (ev) ev.stopPropagation();
    var u = (this._cachedDBUsers || []).find(function (x) { return x.username === username; });
    if (!u) { flash('❌ ' + t('err.userNotFound', 'ไม่พบ user'), 'error'); return; }
    var current = String(u.accStatus || 'active').toLowerCase();

    // ไม่มีปุ่ม toggle ไป 'locked' — locked มาจาก failed-login policy เท่านั้น
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
    // multi-select ใช้สไตล์ .dd-popup เดิม + footer Done (ต้องกด apply เอง)
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
    // items are now <div> rows (not <input checkbox>) so we
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

  // ── EDIT USER MODAL ── รวมทุก action ต่อ user ที่เคยกระจายในตาราง
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

    // editable name + surname (was display-only "name-display")
    document.getElementById('eu-name').value    = u.name    || '';
    document.getElementById('eu-surname').value = u.surname || '';

    // hidden input + dd-trigger label (custom dropdown).
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

    // daily cap is managed on the dedicated Cap Management page
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

    // identity-only updates (name, surname, project, status).
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

  // ล้าง API key ผ่าน modal ใน-แอป — จำ projectId ไว้ให้ปุ่ม confirm
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

  // editor ในแถวถูกแทนด้วย Edit User modal — โค้ดตายถูกลบไปแล้ว openEditUser คือทางเดียว

  // ── RESET PASSWORD ── validate ฝั่ง client ตาม policy server (8+ ตัว มีอักษร+เลข) แล้ว AWAIT ก่อนแจ้งผล
  // (ของเดิมใช้ prompt() min 4 ตัว fire-and-forget — โชว์สำเร็จทั้งที่ server ปฏิเสธ)
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

    // ใช้ endpoint update เดิม — ต้อง fetch ค่าปัจจุบันมาก่อน กันเขียนทับ field ที่คนอื่นแก้
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

  // ── DELETE USER ── modal → AWAIT DELETE → re-render; _pendingDelete จำข้อมูลไว้ให้ปุ่ม confirm
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
        // re-fetch จาก DB — แถว soft-deleted ถูกกรองฝั่ง server แล้ว
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
    // only a trainer sees the role picker (admins create users only)
    var roleField = document.getElementById('au-role-field');
    var roleSel   = document.getElementById('au-role');
    if (roleSel) roleSel.value = 'user';
    if (roleField) {
      var sess30 = Auth.getSession();
      roleField.style.display = (sess30 && sess30.role === 'trainer') ? '' : 'none';
    }
    // sync project/daily-cap visibility with the (reset) role
    this.onAddUserRoleChange('user');
    document.getElementById('au-error').textContent = '';
    // reset hidden project input + label (custom dropdown)
    var pf = document.getElementById('au-project');
    if (pf) pf.value = '';
    var pl = document.getElementById('au-project-label');
    if (pl) pl.textContent = t('dd.selectProject', '— เลือก Project —');
    showModal('modal-add-user');
  },

  // ฟอร์มปรับตาม role — staff ไม่มี Project/Daily Cap
  onAddUserRoleChange: function (role) {
    var isUser = !role || role === 'user';
    var proj = document.getElementById('au-project-field');
    var cap  = document.getElementById('au-dailycap-field');
    if (proj) proj.style.display = isUser ? '' : 'none';
    if (cap)  cap.style.display  = isUser ? '' : 'none';
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

    // role decides which fields apply. Staff accounts
    // (admin/trainer) have no project binding and no daily cap.
    var roleEl2   = document.getElementById('au-role');
    var roleField3 = document.getElementById('au-role-field');
    var pickedRole = (roleEl2 && roleField3 && roleField3.style.display !== 'none')
      ? roleEl2.value : 'user';
    var isStaff = pickedRole === 'admin' || pickedRole === 'trainer';

    if (!username) { errEl.textContent = '❌ ' + t('err.enterUsername', 'กรุณากรอก Username'); return; }
    if (!firstname || !lastname) { errEl.textContent = '❌ ' + t('err.enterNameSurname', 'กรุณากรอก Name และ Surname'); return; }
    if (!isStaff && !projectId) { errEl.textContent = '❌ ' + t('err.selectProject', 'กรุณาเลือก Project'); return; }
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

    // projectId เป็น VARCHAR — ห้าม parseInt; ใส่เฉพาะเมื่อมีค่า (schema ปฏิเสธ null); staff ไม่ส่งเลย
    var payload = { username: safeUsername, password: password, displayName: displayName };
    if (isStaff) {
      payload.role = pickedRole;
    } else {
      payload.dailyCap = dailyCap;   // Concept B: per-user daily limit (null = unlimited)
      if (projectId) payload.projectId = projectId;
    }

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
    // Math.random ทำนายได้ — รหัสชั่วคราวต้องมาจาก CSPRNG
    var pick = function (set) {
        var buf = new Uint32Array(1), limit = Math.floor(0x100000000 / set.length) * set.length;
        do { crypto.getRandomValues(buf); } while (buf[0] >= limit);   // rejection sampling กันความลำเอียง
        return set[buf[0] % set.length];
    };
    pw += pick(upper);
    pw += pick(digits);
    pw += pick(special);
    for (var i = 3; i < 12; i++) pw += pick(all);
    var chars = pw.split('');
    for (var j = chars.length - 1; j > 0; j--) {          // Fisher-Yates
        var k = Number(pick(Array.from({ length: j + 1 }, function (_, n) { return n; })));
        var tmp = chars[j]; chars[j] = chars[k]; chars[k] = tmp;
    }
    pw = chars.join('');
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
    // also flip aria-pressed on the button so screen readers
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
};
