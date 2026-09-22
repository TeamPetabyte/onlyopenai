// projects.js — หน้า Projects + modal
import { escapeHtml, jsArg, flash, formatMoney, formatTHB, hideModal, showModal } from './helpers.js';

export default {
  // --- Projects ---
  renderProjects: function () {
    var self = this;
    var container = document.getElementById('project-list');
    if (container) container.innerHTML = '<div class="ad-empty">' + t('common.loadingProjectsDb', 'กำลังโหลด projects จาก DB...') + '</div>';
    Promise.all([
      this.fetchProjectsFromDB(),
      fetch(BASE + '/api/credits', { headers: Auth.authHeaders() }).then(function (r) { return r.json(); })
        .then(function (d) { return (d && d.ok && d.credits) ? d.credits : []; }).catch(function () { return []; }),
    ]).then(function (res) {
      self._cachedCredits = res[1] || [];
      self._renderProjectsHtml(res[0] || [], container);
    });
  },

  _renderProjectsHtml: function (projects, container) {
    var credits = this._cachedCredits || [];
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    var nz = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
    var countEl = document.getElementById('projects-count');
    if (countEl) countEl.textContent = '· ' + projects.length;
    var detailCard = document.getElementById('project-detail-card');
    if (projects.length === 0) {
      container.innerHTML = '<div class="ad-empty">' + t('empty.noProjectsHtml', 'ยังไม่มี Project<br>กดปุ่ม <strong>+ Add Project</strong> เพื่อสร้างใหม่') + '</div>';
      if (detailCard) detailCard.style.display = 'none';
      return;
    }
    var selected = this._selectedProjectRow || projects[0].id;
    this._selectedProjectRow = selected;
    var rows = projects.map(function (p) {
      var members = credits.filter(function (c) { return String(c.projectId) === String(p.id); });
      var spend = members.reduce(function (s, u) { return s + nz(u.lifetimeSpend); }, 0);
      var bal = nz(p.balance), life = nz(p.lifetimeAmount);
      var health = life <= 0 ? '<span class="ad-chip">' + TT('proj.noCredit', 'No credit yet') + '</span>'
        : bal <= 0 ? '<span class="ad-chip bad"><span class="dot"></span>' + TT('proj.depleted', 'Out of credit') + '</span>'
        : bal / life < 0.2 ? '<span class="ad-chip warn"><span class="dot"></span>' + TT('proj.low', 'Running low') + '</span>'
        : '<span class="ad-chip ok"><span class="dot"></span>' + TT('proj.healthy', 'Healthy') + '</span>';
      var abbr = (p.name || '?').split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
      return '<tr class="click' + (String(p.id) === String(selected) ? ' selected' : '') + '" onclick="admin.selectProjectRow(\'' + jsArg(p.id) + '\')">'
        + '<td><div class="ad-who"><span class="ad-avatar sq">' + escapeHtml(abbr) + '</span><div><b>' + escapeHtml(p.name) + '</b><span>' + escapeHtml(p.id) + ' · ' + (p.hasApiKey ? TT('lbl.ownKey', 'own key') : TT('lbl.globalKey', 'global key')) + '</span></div></div></td>'
        + '<td><span class="ad-chip">' + escapeHtml(p.targetRelease || '—') + '</span></td>'
        + '<td class="num">' + members.length + '</td>'
        + '<td class="num">฿' + p.inputRate + ' / ฿' + p.outputRate + '</td>'
        + '<td class="num"' + (life > 0 && bal <= 0 ? ' style="color:var(--danger)"' : '') + '>' + formatMoney(bal) + '</td>'
        + '<td class="num">' + formatMoney(spend) + '</td>'
        + '<td>' + health + '</td>'
        + '<td><div class="ad-acts">'
        +   '<button class="ad-btn icon sm ghost" title="' + escapeHtml(t('tt.editProject', 'แก้ไข Project')) + '" onclick="event.stopPropagation();admin.openEditProject(\'' + jsArg(p.id) + '\')"><svg class="ic sm"><use href="#i-pencil"/></svg></button>'
        +   '<button class="ad-btn icon sm ghost danger" title="' + escapeHtml(t('tt.deleteProject', 'ลบ Project')) + '" onclick="event.stopPropagation();admin.deleteProject(\'' + jsArg(p.id) + '\')"><svg class="ic sm"><use href="#i-trash"/></svg></button>'
        + '</div></td></tr>';
    }).join('');
    var total = projects.reduce(function (s, p) { return s + nz(p.balance); }, 0);
    container.innerHTML =
        '<table class="ad-table" style="min-width:860px"><thead><tr><th>' + TT('col.project', 'Project') + '</th><th>' + TT('col.release', 'Release') + '</th><th class="num">' + TT('col.members', 'Members') + '</th><th class="num">' + TT('col.rates', 'Rate in / out') + '</th><th class="num">' + TT('col.balance', 'Balance') + '</th><th class="num">' + TT('col.spend', 'Spend') + '</th><th>' + TT('col.health', 'Health') + '</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
      + '<div class="ad-card-foot"><span>' + projects.length + ' projects · ' + formatMoney(total) + ' ' + TT('lbl.totalBalance', 'total balance') + '</span><span>' + TT('lbl.clickRowDetail', 'Click a row to see the details below') + '</span></div>';
    if (detailCard) { detailCard.style.display = ''; this.renderProjectDetail(selected, 'project-detail'); }
  },

  selectProjectRow: function (projectId) {
    this._selectedProjectRow = projectId;
    document.querySelectorAll('#project-list tr.click').forEach(function (tr) {
      tr.classList.toggle('selected', tr.getAttribute('onclick').indexOf("'" + String(projectId).replace(/'/g, "\\'") + "'") !== -1);
    });
    var detailCard = document.getElementById('project-detail-card');
    if (detailCard) detailCard.style.display = '';
    this.renderProjectDetail(projectId, 'project-detail');
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
    document.getElementById('ep-target-release').value = p.targetRelease || 'v750';

    // ไม่โชว์ key ที่เก็บไว้ — pill บอกแค่มี/ไม่มี; ช่องว่าง = คงค่าเดิม (COALESCE ฝั่ง server)
    var keyEl    = document.getElementById('ep-api-key');
    var statusEl = document.getElementById('ep-api-key-status');
    if (keyEl) keyEl.value = '';
    if (statusEl) {
      // server redacts the key; we only get hasApiKey + apiKeyPreview
      var realKey = !!p.hasApiKey;
      statusEl.innerHTML = realKey
        ? '<span style="color:#5cb85c">✓</span> ' + escapeHtml(t('lbl.hasApiKey', 'มี API key อยู่แล้ว'))
            + ' <span style="color:var(--text-3);font-family:monospace">'
            + escapeHtml(p.apiKeyPreview || '') + '</span>'
            + ' <button type="button" onclick="admin.clearProjectApiKey(\''
            + escapeHtml(p.id) + '\')" style="margin-left:8px;padding:2px 8px;'
            + 'font-size:.7rem;background:transparent;color:#d04545;'
            + 'border:1px solid rgba(208,69,69,0.3);border-radius:4px;cursor:pointer">'
            + 'Clear</button>'
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

    if (!name) { errEl.textContent = t('err.enterProjectName', 'กรุณาใส่ชื่อ Project'); return; }
    if (isNaN(inputRate) || isNaN(outputRate)) { errEl.textContent = t('err.invalidRate', 'ค่า Rate ไม่ถูกต้อง'); return; }
    // backend caps key length at 256
    if (apiKeyNew && apiKeyNew.length > 256) {
      errEl.textContent = t('err.apiKeyTooLong', 'API key ยาวเกินกำหนด (max 256 chars)'); return;
    }
    if (apiKeyNew && !/^sk-/.test(apiKeyNew)) {
      errEl.textContent = t('warn.apiKeyFormat', 'API key ปกติขึ้นต้นด้วย "sk-" — กรุณาตรวจสอบ'); return;
    }

    var self = this;
    var body = {
      name: name, description: desc,
      inputRate: inputRate, outputRate: outputRate, creditLimit: creditLit,
      targetRelease: document.getElementById('ep-target-release').value,
    };
    // empty apiKey = keep existing (server COALESCEs), so send it only when typed
    if (apiKeyNew) body.apiKey = apiKeyNew;

    fetch(BASE + '/api/projects/' + encodeURIComponent(projectId), {
      method: 'PUT',
      headers: Auth.authHeaders(),
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = t('err.dbRejected', 'DB ปฏิเสธ: ') + (d.error || 'unknown'); return; }
        hideModal('modal-edit-project');
        flash(tf('msg.projectUpdated', { name: name }, 'อัปเดต Project "{name}" เรียบร้อย (saved to DB)'), 'success', 'success');
        self.fetchProjectsFromDB().then(function () {
          self.renderProjects();
          self.refreshProjectSelects();
        });
      })
      .catch(function (e) { errEl.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; });
  },

  // --- Remove user from project ---
  _pendingRemoveFromProject: null,

  removeFromProject: function (username) {
    var users = this.getUsersWithHistory();
    var u = users.find(function (x) { return x.username === username; });
    if (!u || !u.id) { flash(t('err.userIdNotFound', 'ไม่พบ user_id (DB row)'), 'error'); return; }
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
          if (err) err.textContent = msg;
          if (btn) { btn.disabled = false; btn.textContent = t('m.removeUser.confirm', 'ยืนยันย้ายออก'); }
          return;
        }
        // mirror to localStorage
        try { Auth.setUserProject(p.username, null); } catch (_) {}
        self._pendingRemoveFromProject = null;
        hideModal('modal-confirm-remove-user-from-project');
        flash(tf('msg.ownerMoved', { username: p.username }, 'ย้าย @{username} ออกจาก project แล้ว'), 'success', 'success');
        // re-fetch users so member lists are accurate
        self.fetchUsersFromDB().then(function (users) {
          self._cachedDBUsers = users;
          self.renderProjects();
        });
      })
      .catch(function (e) {
        if (err) err.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('m.removeUser.confirm', 'ยืนยันย้ายออก'); }
      });
  },

  // --- Delete project --- (server refuses when chat history exists; the error shows in the modal)
  _pendingDeleteProject: null,

  deleteProject: function (projectId) {
    var p = Auth.getProjectById(projectId);
    if (!p) { flash(t('err.projectNotFound', 'ไม่พบ project'), 'error'); return; }

    var members = (this._cachedDBUsers || []).filter(function (u) { return u.projectId === projectId; });
    var credits = (typeof p.credits === 'number' ? p.credits : 0);

    this._pendingDeleteProject = { id: projectId, name: p.name, memberCount: members.length };

    var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    set('cdp-name',    p.name);
    set('cdp-id',      projectId);
    set('cdp-members', String(members.length));
    set('cdp-credits', formatTHB(credits));

    var warn = document.getElementById('cdp-warning');
    if (warn) {
      warn.innerHTML = members.length > 0
        ? tf('confirm.removeMembersWarn', { n: members.length }, 'มีสมาชิก {n} คนใน project นี้ — ทุกคนจะถูกย้ายออก (ไม่ได้ถูกลบ)<br>Balance ของ project จะถูกล้าง')
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
          if (err) err.textContent = msg;
          if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }
          return;
        }
        try { Auth.deleteProject(p.id); } catch (_) {}
        self._pendingDeleteProject = null;
        hideModal('modal-confirm-delete-project');
        flash(tf('msg.projectDeleted', { name: p.name }, 'ลบ Project "{name}" แล้ว'), 'success', 'success');
        // refresh projects + users (members are now unassigned)
        Promise.all([self.fetchProjectsFromDB(), self.fetchUsersFromDB()])
          .then(function (results) {
            self._cachedDBUsers = results[1] || [];
            self.renderProjects();
            self.refreshProjectSelects();
          });
      })
      .catch(function (e) {
        if (err) err.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }
      });
  },

  // --- Add project --- (ฟอร์มถามแค่ชื่อ+คำอธิบาย; rate/limit ใช้ default)
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

    if (!name) { errEl.textContent = t('err.enterProjectName', 'กรุณาใส่ชื่อ Project'); return; }

    var self = this;
    fetch(BASE + '/api/projects', {
      method: 'POST', headers: Auth.authHeaders(),
      // inputRate / outputRate / creditLimit omitted → server applies defaults
      body: JSON.stringify({ name: name, description: desc }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = t('err.dbRejected', 'DB ปฏิเสธ: ') + (d.error || 'unknown'); return; }
        hideModal('modal-add-project');
        // แถวลง DB เสมอ; ถ้า link OpenAI ล้มให้เตือน ไม่ เงียบ
        if (d.openai && d.openai.synced === false) {
          flash(tf('msg.projectCreatedOpenAiFail', { name: name, err: d.openai.error || 'unknown' }, 'สร้าง Project "{name}" ใน DB แล้ว แต่เชื่อม OpenAI ไม่สำเร็จ: {err} — ยังไม่มี OpenAI project id'), 'error', 'success');
        } else {
          flash(tf('msg.projectCreated', { name: name }, 'สร้าง Project "{name}" เรียบร้อย', 'success')
            + (d.openai && d.openai.project_id ? ' · OpenAI: ' + d.openai.project_id : ''), 'success');
        }
        self.fetchProjectsFromDB().then(function () {
          self.renderProjects();
          self.refreshProjectSelects();
        });
      })
      .catch(function (e) { errEl.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; });
  },

  refreshProjectSelects: function () {
    // stub — dropdowns fetch live on click; kept so old callers don't break
  },
};
