// users.js — หน้า Users + modal เพิ่ม/แก้/ลบ/รีเซ็ตรหัส
import { escapeHtml, flash, formatDateStd, formatTHB, hideModal, showModal } from './helpers.js';

export default {
  // --- Users page --- sticky filter: Set ของ project ids, "__none__" = ไม่มี project
  _userProjectFilter: null,   // Set | null (null = uninitialised, treated as "all")

  _userStatusFilter: 'all',
  _userSearch: '',
  setUserStatusFilter: function (v) { this._userStatusFilter = v || 'all'; this.renderUsers(); },
  onUserSearch: function (v) {
    this._userSearch = (v || '').trim().toLowerCase();
    var self = this; clearTimeout(this._userSearchTimer);
    this._userSearchTimer = setTimeout(function () { self.renderUsers(true); }, 150);
  },

  renderUsers: function (keepToolbar) {
    var self = this;
    var tableEl = document.getElementById('user-table');
    var toolbar = document.getElementById('users-toolbar');
    if (tableEl && !keepToolbar) tableEl.innerHTML = '<div class="ad-empty">' + t('common.loading', 'กำลังโหลด...') + '</div>';

    this.fetchUsersFromDB().then(function (users) {
      self._cachedDBUsers = users;
      users = users.filter(function (u) { return u.role !== 'admin' && u.role !== 'trainer'; });
      var all = users.slice();

      var filter = self._userProjectFilter;
      if (filter && filter.size > 0) users = users.filter(function (u) { return filter.has(u.projectId ? String(u.projectId) : '__none__'); });
      var counts = { all: all.length, active: 0, locked: 0, inactive: 0 };
      all.forEach(function (u) { var st = String(u.accStatus || 'active').toLowerCase(); if (counts[st] != null) counts[st]++; });
      var sf = self._userStatusFilter || 'all';
      if (sf !== 'all') users = users.filter(function (u) { return String(u.accStatus || 'active').toLowerCase() === sf; });
      var q = self._userSearch;
      if (q) users = users.filter(function (u) { return ((u.username || '') + ' ' + (u.name || '') + ' ' + (u.surname || '') + ' ' + (u.displayName || '')).toLowerCase().indexOf(q) !== -1; });

      var hasActive = filter && filter.size > 0;
      var countEl = document.getElementById('users-count');
      if (countEl) countEl.textContent = '· ' + users.length + (users.length !== all.length ? ' / ' + all.length : '');
      var chip = function (v, label, n) { return '<button type="button" class="ad-chip click" aria-pressed="' + (sf === v) + '" onclick="admin.setUserStatusFilter(\'' + v + '\')">' + label + ' ' + n + '</button>'; };
      if (toolbar && !keepToolbar) toolbar.innerHTML =
          '<div class="ad-search"><svg class="ic sm"><use href="#i-search"/></svg><input id="users-search" placeholder="' + escapeHtml(t('lbl.searchUsers', 'Search name or username')) + '" value="' + escapeHtml(self._userSearch || '') + '" oninput="admin.onUserSearch(this.value)" /></div>'
        + '<button type="button" class="ad-btn sm user-project-filter-trigger" onclick="admin.toggleUserProjectFilter(event)"' + (hasActive ? ' style="border-color:var(--accent);color:var(--accent)"' : '') + '><svg class="ic sm"><use href="#i-folder"/></svg><span class="dd-trigger-label">' + escapeHtml(hasActive ? ('Filtered (' + filter.size + ')') : t('filter.allProject', 'ทุก Project')) + '</span><svg class="ic sm"><use href="#i-chevron"/></svg></button>'
        + '<div class="ad-filters">' + chip('all', t('filter.all', 'All'), counts.all) + chip('active', t('status.active', 'Active'), counts.active) + chip('locked', t('status.locked', 'Locked'), counts.locked) + chip('inactive', t('status.inactive', 'Disabled'), counts.inactive) + '</div>';
      else if (toolbar) {
        toolbar.querySelectorAll('.ad-chip.click').forEach(function (c) { c.setAttribute('aria-pressed', String(c.getAttribute('onclick').indexOf("'" + sf + "'") !== -1)); });
      }

      if (users.length === 0) {
        if (tableEl) tableEl.innerHTML = '<div class="ad-empty">' + (hasActive || sf !== 'all' || q ? t('empty.noUsersMatchFilter', 'ไม่พบ user ที่ตรงกับตัวกรอง') : t('empty.noUsersSystem', 'ยังไม่มี user ในระบบ')) + '</div>';
        return;
      }
      var rows = users.map(function (u) {
        var fullName = ((u.name || '') + ' ' + (u.surname || '')).trim() || u.displayName || u.username || '—';
        var projectName = self._projectNameById(u.projectId) || '';
        var created = u.createdAt ? formatDateStd(u.createdAt).split(' ')[0] : '—';
        var initial = fullName.charAt(0).toUpperCase();
        var uq = escapeHtml(u.username);
        var cap = u.dailyCap == null ? '<span class="muted">' + t('val.unlimited', 'ไม่จำกัด') + '</span>' : formatTHB(u.dailyCap);
        return '<tr>'
          + '<td><div class="ad-who"><span class="ad-avatar">' + escapeHtml(initial) + '</span><div><b>' + escapeHtml(fullName) + '</b><span>' + uq + '</span></div></div></td>'
          + '<td>' + (u.projectId ? escapeHtml(projectName) : '<span class="muted">—</span>') + '</td>'
          + '<td>' + self._renderStatusBadge(u.accStatus, u.username) + '</td>'
          + '<td class="num">' + cap + '</td>'
          + '<td class="ad-mono muted">' + created + '</td>'
          + '<td><div class="ad-acts">'
          +   '<button class="ad-btn icon sm ghost" title="' + escapeHtml(t('tt.editUser', 'Edit user')) + '" onclick="admin.openEditUser(\'' + uq + '\')"><svg class="ic sm"><use href="#i-pencil"/></svg></button>'
          +   '<button class="ad-btn icon sm ghost" title="' + escapeHtml(t('tt.resetPassword', 'Reset password')) + '" onclick="admin.resetPassword(\'' + uq + '\')"><svg class="ic sm"><use href="#i-key"/></svg></button>'
          + '</div></td>'
          + '</tr>';
      }).join('');
      if (tableEl) tableEl.innerHTML =
          '<table class="ad-table"><thead><tr><th>' + t('col.user', 'User') + '</th><th>' + t('col.project', 'Project') + '</th><th>' + t('col.status', 'Status') + '</th><th class="num">' + t('col.dailyCap', 'Daily Cap') + '</th><th>' + t('col.created', 'Created') + '</th><th></th></tr></thead>'
        + '<tbody>' + rows + '</tbody></table>'
        + '<div class="ad-card-foot"><span>' + users.length + ' ' + t('lbl.of', 'of') + ' ' + all.length + ' users</span><span>' + t('lbl.statusClickHint', 'Click a status to enable or disable the account') + '</span></div>';
    });
  },

  _projectNameById: function (id) {
    if (!id) return '';
    var list = this._cachedDBProjects || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i].name;
    return id;
  },

  _renderStatusBadge: function (status, username) {
    var s = String(status || 'active').toLowerCase();
    var cls = s === 'active' ? 'on' : s === 'locked' || s === 'inactive' ? 'bad' : '';
    var label = t('status.' + s, s.charAt(0).toUpperCase() + s.slice(1));
    return '<button type="button" class="ad-status ' + cls + '" style="background:none;border:0;padding:0;cursor:pointer;font-family:inherit;color:inherit" title="' + escapeHtml(t('tt.toggleStatus', 'เปลี่ยนสถานะ')) + '" onclick="admin.toggleUserStatus(\'' + escapeHtml(username) + '\')"><span class="dot"></span>' + escapeHtml(label) + '</button>';
  },

  // pending badge-click action for confirmStatusToggle()
  _pendingStatusToggle: null,    // { user, next:'active'|'inactive', nextId:1|2 }

  toggleUserStatus: function (username, ev) {
    if (ev) ev.stopPropagation();
    var u = (this._cachedDBUsers || []).find(function (x) { return x.username === username; });
    if (!u) { flash(t('err.userNotFound', 'ไม่พบ user'), 'error'); return; }
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
      title = t('modal.unlockUser.title', 'ปลดล็อก User');
      explain = t('modal.unlockUser.body', 'บัญชีนี้ถูก lock จาก failed login attempts<br>การยืนยันจะเคลียร์ failed-attempt counter และเปิดใช้งานต่อ');
      btnClass = 'btn-modal-info';
      btnText = t('btn.unlockAction', 'ปลดล็อก');
    } else {
      flash('unknown status: ' + current, 'error'); return;
    }

    var boxColors = {
      warning: { bg: 'rgba(240,160,64,0.06)',  bd: 'rgba(240,160,64,0.25)' },
      success: { bg: 'rgba(63,166,77,0.06)',   bd: 'rgba(63,166,77,0.25)' },
      info:    { bg: 'rgba(74,123,214,0.06)',  bd: 'rgba(74,123,214,0.25)' },
    }[theme];

    this._pendingStatusToggle = { user: u, next: next, nextId: nextId };

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
        if (!d.ok) { errEl.textContent = (d.error || 'update failed'); btn.disabled = false; return; }
        // update the cache so later badge clicks see the new state
        p.user.accStatus = p.next;
        p.user.accStatusId = p.nextId;
        hideModal('modal-confirm-status-toggle');
        flash(tf('msg.statusChanged', { username: p.user.username, status: p.next }, '@{username} → {status}'), 'success', 'success');
        self._pendingStatusToggle = null;
        self.renderUsers();
      })
      .catch(function (e) {
        errEl.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        btn.disabled = false;
      });
  },

  // --- Project filter dropdown (multi-select) ---
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
        '<input type="text" id="user-pf-search" class="dd-search" placeholder="Search project..."/>'
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
      listEl.innerHTML = items.map(function (p) {
        var sel = current.has(String(p.id));
        var divider = (p._all && items.length > 1) ? '<div class="dd-divider"></div>' : '';
        var emoji = p._all ? '' : '';
        return '<div class="dd-item' + (sel ? ' dd-selected' : '') + '" '
          + 'data-pid="' + escapeHtml(String(p.id)) + '" '
          + 'onclick="admin._toggleUserPfItem(this)" '
          + 'style="cursor:pointer">'
          // checkbox-style indicator
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
    var pop = document.getElementById('user-project-filter-popup');
    if (!pop || !pop._selected) return;
    var pid = el.getAttribute('data-pid');
    if (pop._selected.has(pid)) pop._selected.delete(pid);
    else                        pop._selected.add(pid);
    // toggle this row only, no full re-render
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

  // --- Edit user modal ---
  openEditUser: function (username) {
    var u = (this._cachedDBUsers || []).find(function (x) { return x.username === username; });
    if (!u) { flash(t('err.userNotFound', 'ไม่พบ user'), 'error'); return; }

    document.getElementById('eu-username').value = username;
    document.getElementById('eu-username-display').textContent = username;
    document.getElementById('eu-userid-display').textContent =
      'user id ' + (u.id != null ? u.id : '—');
    var ava = document.getElementById('eu-avatar');
    if (ava) ava.textContent = (u.name || u.username || '?').charAt(0).toUpperCase();

    document.getElementById('eu-name').value    = u.name    || '';
    document.getElementById('eu-surname').value = u.surname || '';

    var projects = this._cachedDBProjects || [];
    var projectId = u.projectId ? String(u.projectId) : '';
    document.getElementById('eu-project').value = projectId;
    var projObj = projects.find(function (p) { return String(p.id) === projectId; });
    document.getElementById('eu-project-label').textContent =
      projObj ? (projObj.name) : t('dd.noProjectAssigned', '— ไม่มี Project —');

    var status = String(u.accStatus || 'active').toLowerCase();
    document.getElementById('eu-status').value = status;
    document.getElementById('eu-status-label').textContent =
      status.charAt(0).toUpperCase() + status.slice(1);

    // daily cap is managed on the Cap Management page, not here

    document.getElementById('eu-error').textContent = '';
    showModal('modal-edit-user');
  },

  openEditUserProjectDropdown: function (ev) {
    if (ev) ev.stopPropagation();
    var projects = (this._cachedDBProjects || []).slice()
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    this.openDropdown('eu-project-trigger', {
      items: projects.map(function (p) { return { value: p.id, label: p.name }; }),
      selected: document.getElementById('eu-project').value || '',
      searchable: true,
      placeholder: t('dd.searchProject', 'ค้นหา project...'),
      allowEmpty: { label: t('dd.noProjectAssigned', '— ไม่มี Project —') },
      onPick: function (value, item) {
        document.getElementById('eu-project').value = value || '';
        document.getElementById('eu-project-label').textContent =
          item && !item._all ? (item.label) : t('dd.noProjectAssigned', '— ไม่มี Project —');
      },
    });
  },

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
    if (!u) { document.getElementById('eu-error').textContent = t('err.userNotFound', 'ไม่พบ user'); return; }

    // identity-only; credit and dailyCap live in Credit Management
    var name      = document.getElementById('eu-name').value.trim();
    var surname   = document.getElementById('eu-surname').value.trim();
    var projectId = document.getElementById('eu-project').value || null;
    var status    = document.getElementById('eu-status').value;
    var errEl     = document.getElementById('eu-error');
    errEl.textContent = '';

    if (!name)    { errEl.textContent = t('err.enterFirstname', 'กรุณากรอกชื่อ');     return; }
    if (!surname) { errEl.textContent = t('err.enterLastname', 'กรุณากรอกนามสกุล');  return; }
    if (name.length    > 50) { errEl.textContent = t('err.firstnameTooLong', 'ชื่อยาวเกินไป (สูงสุด 50)');    return; }
    if (surname.length > 50) { errEl.textContent = t('err.lastnameTooLong', 'นามสกุลยาวเกินไป (สูงสุด 50)'); return; }

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
        flash(tf('msg.userSaved', { username: username }, 'บันทึก user @{username} เรียบร้อย'), 'success', 'success');
        self.renderUsers();
      })
      .catch(function (e) { errEl.textContent = (e.message || 'error'); });
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
          if (err) err.textContent = (d.error || 'clear failed');
          if (btn) { btn.disabled = false; btn.textContent = t('m.clearKey.btn', 'ลบ API key'); }
          return;
        }
        hideModal('modal-confirm-clear-apikey');
        self._pendingClearApiKey = null;
        flash(t('msg.apiKeyDeleted', 'ลบ API key เรียบร้อย'), 'success', 'success');
        self.fetchProjectsFromDB().then(function () {
          if (self.currentView === 'projects') self.renderProjects();
          var openModal = document.getElementById('modal-edit-project');
          if (openModal && openModal.classList.contains('show')) {
            self.openEditProject(projectId);
          }
        });
      })
      .catch(function (e) {
        if (err) err.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
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

  // --- Reset password --- validate ฝั่ง client ตาม policy server แล้ว AWAIT ก่อนแจ้งผล
  _pendingResetPw: null,

  resetPassword: function (username) {
    var users = this.getUsersWithHistory();
    var u = users.find(function (x) { return x.username === username; });
    if (!u || !u.id) { flash(t('err.userIdNotFound', 'ไม่พบ user_id (DB row)'), 'error'); return; }

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
    if (tog) tog.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-eye"/></svg>';

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
      tog.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-eye-off"/></svg>';
      tog.setAttribute('aria-pressed', 'true');
    } else {
      inp.type = 'password';
      tog.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-eye"/></svg>';
      tog.setAttribute('aria-pressed', 'false');
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
    if (msg) { if (err) err.textContent = msg; return; }

    if (err) err.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = t('btn.savingEllipsis', 'กำลังบันทึก...'); }

    // ใช้ endpoint update เดิม — ต้อง fetch ค่าปัจจุบันมาก่อน กันเขียนทับ field ที่คนอื่นแก้
    var users = this.getUsersWithHistory();
    var u = users.find(function (x) { return x.id === pending.id; });
    if (!u) {
      if (err) err.textContent = t('err.userNotFoundRefresh', 'ไม่พบ user (โปรด refresh แล้วลองใหม่)');
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
          if (err) err.textContent = (d.error || t('err.dbRejectedShort', 'DB ปฏิเสธ'));
          if (btn) { btn.disabled = false; btn.textContent = t('btn.savePlain', 'บันทึก'); }
          return;
        }
        hideModal('modal-reset-password');
        self._pendingResetPw = null;
        flash(tf('msg.pwReset', { username: pending.username }, 'รีเซ็ตรหัสผ่านของ @{username} เรียบร้อย'), 'success', 'success');
      })
      .catch(function (e) {
        if (err) err.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('btn.savePlain', 'บันทึก'); }
      });
  },

  // --- Delete user ---
  _pendingDelete: null,

  deleteUser: function (username) {
    var users = this.getUsersWithHistory();
    var u = users.find(function (x) { return x.username === username; });
    if (!u || !u.id) { flash(t('err.userIdNotFound', 'ไม่พบ user_id (DB row)'), 'error'); return; }

    this._pendingDelete = {
      username: u.username,
      id: u.id,
      displayName: u.displayName || '—',
      role: u.role || '—',
      balance: u.balance,
    };

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
          if (err) err.textContent = msg;
          if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }
          return;
        }
        // keep the legacy localStorage store in sync
        try { Auth.deleteUser(p.username); } catch (_) {}
        self._pendingDelete = null;
        hideModal('modal-confirm-delete-user');
        flash(tf('msg.userDeleted', { username: p.username }, 'ลบ @{username} แล้ว'), 'success', 'success');
        self.renderUsers();
        self.refreshProjectSelects();
        if (self.currentView === 'overview') self.renderOverview();
      })
      .catch(function (e) {
        if (err) err.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }
      });
  },

  // --- Add user modal ---
  openAddUser: function () {
    ['au-username', 'au-password', 'au-confirm', 'au-firstname', 'au-lastname'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    var cap = document.getElementById('au-dailycap');
    if (cap) cap.value = '50';   // default daily cap; blank = unlimited
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
    this.onAddUserRoleChange('user');
    document.getElementById('au-error').textContent = '';
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
      items: projects.map(function (p) { return { value: p.id, label: p.name }; }),
      selected: document.getElementById('au-project').value || '',
      searchable: true,
      placeholder: t('dd.searchProject', 'ค้นหา project...'),
      allowEmpty: { label: t('dd.selectProject', '— เลือก Project —') },
      onPick: function (value, item) {
        document.getElementById('au-project').value = value || '';
        document.getElementById('au-project-label').textContent =
          item && !item._all ? (item.label) : t('dd.selectProject', '— เลือก Project —');
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

    // staff (admin/trainer) have no project binding and no daily cap
    var roleEl2   = document.getElementById('au-role');
    var roleField3 = document.getElementById('au-role-field');
    var pickedRole = (roleEl2 && roleField3 && roleField3.style.display !== 'none')
      ? roleEl2.value : 'user';
    var isStaff = pickedRole === 'admin' || pickedRole === 'trainer';

    if (!username) { errEl.textContent = t('err.enterUsername', 'กรุณากรอก Username'); return; }
    if (!firstname || !lastname) { errEl.textContent = t('err.enterNameSurname', 'กรุณากรอก Name และ Surname'); return; }
    if (!isStaff && !projectId) { errEl.textContent = t('err.selectProject', 'กรุณาเลือก Project'); return; }
    if (password.length < 8) { errEl.textContent = t('err.pwMin8', 'Password ต้องมีอย่างน้อย 8 ตัว'); return; }
    if (!/[A-Z]/.test(password)) { errEl.textContent = t('err.pwUpper', 'Password ต้องมีตัวพิมพ์ใหญ่อย่างน้อย 1 ตัว'); return; }
    if (!/[0-9]/.test(password)) { errEl.textContent = t('err.pwNumber', 'Password ต้องมีตัวเลขอย่างน้อย 1 ตัว'); return; }
    if (password !== confirm) { errEl.textContent = t('err.pwMismatch', 'Password ไม่ตรงกัน'); return; }
    if (dailyCap !== null && (!isFinite(dailyCap) || dailyCap < 0)) {
      errEl.textContent = t('err.dailyCapInvalid2', 'Daily Cap ต้องเป็นตัวเลข ≥ 0 หรือเว้นว่าง (= ไม่จำกัด)'); return;
    }

    var self = this;
    var displayName = firstname + ' ' + lastname;
    var safeUsername = username.toLowerCase().replace(/[^a-z0-9._@+-]/g, '_');

    // projectId เป็น VARCHAR — ห้าม parseInt; ใส่เฉพาะเมื่อมีค่า (schema ปฏิเสธ null); staff ไม่ส่งเลย
    var payload = { username: safeUsername, password: password, displayName: displayName };
    if (isStaff) {
      payload.role = pickedRole;
    } else {
      payload.dailyCap = dailyCap;   // null = unlimited
      if (projectId) payload.projectId = projectId;
    }

    fetch(BASE + '/api/users', {
      method: 'POST',
      headers: Auth.authHeaders(),
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { errEl.textContent = (data.error || t('err.createUserFailed', 'ไม่สามารถสร้าง user ได้')); return; }
        hideModal('modal-add-user');
        flash(tf('msg.userCreated', { name: displayName, username: safeUsername }, 'สร้าง user "{name}" (@{username}) เรียบร้อย'), 'success', 'success');
        self.renderUsers();
        self.refreshProjectSelects();
      })
      .catch(function (e) { errEl.textContent = 'Server error: ' + e.message; });
  },

  // --- Password helpers ---
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
    flash('Generated: ' + pw);
  },

  togglePw: function (inputId, eyeId) {
    var inp = document.getElementById(inputId);
    var eye = document.getElementById(eyeId);
    if (!inp) return;
    // aria-pressed tells screen readers whether the password is visible
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
      hint.textContent = (pw.length < 8 ? t('pw.needMin8', 'ต้องมีอย่างน้อย 8 ตัว') : !/[A-Z]/.test(pw) ? t('pw.needUpper', 'ต้องมีตัวพิมพ์ใหญ่') : t('pw.needNumber', 'ต้องมีตัวเลข'));
    } else {
      hint.style.color = '#4ade80';
      hint.textContent = t('pw.strengthGood', 'Password strength: Good');
    }
  },

  copyToClipboard: function (inputId) {
    var inp = document.getElementById(inputId);
    if (!inp || !inp.value) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(inp.value)
        .then(function () { flash(t('msg.copiedClipboard', 'Copied to clipboard')); })
        .catch(function () { flash(t('err.copyFailed', 'ไม่สามารถ copy ได้'), 'error'); }, 'error');
    } else {
      inp.type = 'text';
      inp.select();
      try { document.execCommand('copy'); flash(t('msg.copiedClipboard', 'Copied to clipboard')); } catch { flash(t('err.copyFailed', 'ไม่สามารถ copy ได้'), 'error'); }
    }
  },

  pastePassword: function () {
    var pw = (document.getElementById('au-password') || {}).value;
    var conf = document.getElementById('au-confirm');
    if (conf && pw) { conf.value = pw; }
  },
};
