// projects.js — หน้า Projects + modal
import { escapeHtml, jsArg, flash, formatTHB, hideModal, showModal } from './helpers.js';

export default {
  // ── PROJECTS ──────────────────────────────────────────
  renderProjects: function () {
    var self = this;
    var container = document.getElementById('project-list');
    if (container) container.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-3);font-size:.85rem">' + t('common.loadingProjectsDb', '⏳ กำลังโหลด projects จาก DB...') + '</div>';
    // Always pull fresh from DB so create/edit/delete reflect immediately
    this.fetchProjectsFromDB().then(function (projects) {
      self._renderProjectsHtml(projects, container);
    });
  },

  _renderProjectsHtml: function (projects, container) {
    var self = this;
    var users = this.getUsersWithHistory();

    if (projects.length === 0) {
      container.innerHTML = '<div class="glass-card" style="text-align:center;padding:48px 24px">'
        + '<div style="font-size:2.5rem;margin-bottom:12px">📂</div>'
        + '<div style="color:var(--text-3);font-size:0.9rem">' + t('empty.noProjectsHtml', 'ยังไม่มี Project<br>กดปุ่ม <strong style="color:var(--text-3)">+ Add Project</strong> เพื่อสร้างใหม่') + '</div>'
        + '</div>';
      return;
    }

    // หน้า Projects: hero + chips + stat cards; แถวสมาชิกถูกถอด (ซ้ำกับหน้า Users/Credits)
    // coerce เป็น Number กัน "NaN" จาก cache โผล่ในการ์ด
    var nz = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
    container.innerHTML = projects.map(function (p) {
      var members = users.filter(function (u) { return u.projectId === p.id; });
      var totalReq = members.reduce(function (s, u) {
          return s + ((u.history && u.history.length) || 0);
      }, 0);
      var totalTok = members.reduce(function (s, u) {
          return s + (u.history || []).reduce(function (ss, h) {
              return ss + nz(h.inputTokens) + nz(h.outputTokens);
          }, 0);
      }, 0);
      var totalCost = members.reduce(function (s, u) {
          return s + (u.history || []).reduce(function (ss, h) {
              return ss + nz(h.cost);
          }, 0);
      }, 0);
      var totalBal = members.reduce(function (s, u) { return s + nz(u.balance); }, 0);

      // —— Stat card helper ——
      var statCard = function (icon, label, value, valueColor) {
        return '<div style="padding:14px 16px;background:var(--surface-2);'
          + 'border:1px solid var(--border-default);border-radius:10px">'
          + '<div style="font-size:.66rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">' + icon + ' ' + label + '</div>'
          + '<div style="font-size:1.25rem;font-weight:700;color:' + valueColor + ';font-family:Geist Mono,monospace">' + value + '</div>'
          + '</div>';
      };

      // —— Hero header with project_id pill ——
      var hero =
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;'
        + 'gap:14px;padding-bottom:16px;margin-bottom:18px;border-bottom:1px solid var(--border-subtle)">'
        +   '<div style="flex:1;min-width:240px">'
        +     '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">'
        +       '<div style="font-size:1.15rem;font-weight:800;color:var(--text-1)">📂 ' + escapeHtml(p.name) + '</div>'
        // Click-to-copy project_id pill (matches Overview redesign)
        +       '<span title="' + escapeHtml(t('tt.clickToCopy', 'คลิกเพื่อ copy')) + '" '
        +         'onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + jsArg(p.id) + '\').then(()=>flash(\'✓ Copied: ' + jsArg(p.id) + '\'))" '
        +         'style="font-family:Geist Mono,monospace;font-size:.7rem;padding:3px 9px;'
        +         'background:var(--accent-soft-bg);color:var(--accent);'
        +         'border:1px solid var(--accent-soft-border);border-radius:6px;cursor:pointer">'
        +         escapeHtml(p.id) + '</span>'
        +       '<span style="font-size:.68rem;color:var(--text-2);padding:3px 10px;'
        +         'background:var(--surface-3);border:1px solid var(--border-default);'
        +         'border-radius:20px">👥 ' + members.length + ' member' + (members.length === 1 ? '' : 's') + '</span>'
        +     '</div>'
        +     '<div style="font-size:.84rem;color:var(--text-3);line-height:1.5;margin-bottom:10px">'
        +       (p.desc ? escapeHtml(p.desc) : '<span style="font-style:italic;opacity:.6">' + escapeHtml(t('lbl.noDescription', 'No description')) + '</span>')
        +     '</div>'
        +     '<div style="display:flex;gap:8px;flex-wrap:wrap">'
        +       '<span style="font-size:.7rem;padding:4px 10px;background:var(--surface-3);'
        +         'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)">'
        +         '📥 In <b>฿' + p.inputRate + '</b>/1K</span>'
        +       '<span style="font-size:.7rem;padding:4px 10px;background:var(--surface-3);'
        +         'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)">'
        +         '📤 Out <b>฿' + p.outputRate + '</b>/1K</span>'
        // chip Budget แยกเป็น lifetime (สะสม ไม่ลด) กับ balance ปัจจุบัน — lifetime คือตัวชี้วัด tier
        +       '<span style="font-size:.7rem;padding:4px 10px;background:var(--surface-3);'
        +         'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)" title="' + escapeHtml(t('tt.lifetimeTopupHint', 'ยอดสะสมที่ลูกค้าเคยเติม (ไม่ลดลง)')) + '">'
        +         '💰 Lifetime <b>฿' + (p.lifetimeAmount || 0).toFixed(2) + '</b></span>'
        +       '<span style="font-size:.7rem;padding:4px 10px;background:var(--surface-3);'
        +         'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)" title="' + escapeHtml(t('tt.usableNowHint', 'ยอดคงเหลือใช้ได้ตอนนี้')) + '">'
        +         '🏦 Balance <b>฿' + (p.balance || 0).toFixed(2) + '</b></span>'
        +       (p.creditLimit ? ('<span style="font-size:.7rem;padding:4px 10px;background:var(--surface-3);'
                                  + 'border:1px solid var(--border-default);border-radius:20px;color:var(--text-2)">'
                                  + '⛔ Limit/user <b>฿' + p.creditLimit + '</b></span>') : '')
        +     '</div>'
        +   '</div>'
        // Icon-only Edit + Delete buttons
        +   '<div style="display:flex;gap:8px">'
        +     '<button class="btn-icon-action btn-icon-edit-large" title="' + escapeHtml(t('tt.editProject', 'แก้ไข Project')) + '" '
        +       'onclick="admin.openEditProject(\'' + jsArg(p.id) + '\')">'
        +       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
        +       '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>'
        +       '<span style="margin-left:6px;font-size:.78rem">' + escapeHtml(t('btn.edit', 'แก้ไข')) + '</span>'
        +     '</button>'
        +     '<button class="btn-icon-action btn-icon-danger-large" title="' + escapeHtml(t('tt.deleteProject', 'ลบ Project')) + '" '
        +       'onclick="admin.deleteProject(\'' + jsArg(p.id) + '\')">'
        +       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
        +       '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>'
        +       '<span style="margin-left:6px;font-size:.78rem">' + escapeHtml(t('btn.deletePlain', 'ลบ')) + '</span>'
        +     '</button>'
        +   '</div>'
        + '</div>';

      // —— Stats grid (last element on the card; no bottom margin) ——
      var statsGrid =
          '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">'
        +   statCard('📡', 'Requests',           totalReq.toLocaleString(),     'var(--text-1)')
        +   statCard('🔢', 'Tokens',             totalTok.toLocaleString(),     'var(--text-1)')
        +   statCard('💸', 'Cost Billed',        formatTHB(totalCost),          'var(--text-2)')
        +   statCard('🪙', 'Credit Outstanding', formatTHB(totalBal),
                     totalBal > 0 ? 'var(--success-hover, #34d399)' : 'var(--text-2)')
        + '</div>';

      // members list intentionally not rendered here.
      return '<div class="glass-card" style="margin-bottom:18px">'
        + hero
        + statsGrid
        + '</div>';
    }).join('');
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

    // ไม่โชว์ key ที่เก็บไว้ — pill บอกแค่มี/ไม่มี; ช่องว่าง = คงค่าเดิม (COALESCE ฝั่ง server)
    var keyEl    = document.getElementById('ep-api-key');
    var statusEl = document.getElementById('ep-api-key-status');
    if (keyEl) keyEl.value = '';
    if (statusEl) {
      // server redacts the secret. We get just `hasApiKey` (boolean)
      // and `apiKeyPreview` (e.g. "sk-svcac…XXXX") for display.
      var realKey = !!p.hasApiKey;
      statusEl.innerHTML = realKey
        ? '<span style="color:#5cb85c">✓</span> ' + escapeHtml(t('lbl.hasApiKey', 'มี API key อยู่แล้ว'))
            + ' <span style="color:var(--text-3);font-family:monospace">'
            + escapeHtml(p.apiKeyPreview || '') + '</span>'
            + ' <button type="button" onclick="admin.clearProjectApiKey(\''
            + escapeHtml(p.id) + '\')" style="margin-left:8px;padding:2px 8px;'
            + 'font-size:.7rem;background:transparent;color:#d04545;'
            + 'border:1px solid rgba(208,69,69,0.3);border-radius:4px;cursor:pointer">'
            + '🗑️ Clear</button>'
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

    if (!name) { errEl.textContent = '❌ ' + t('err.enterProjectName', 'กรุณาใส่ชื่อ Project'); return; }
    if (isNaN(inputRate) || isNaN(outputRate)) { errEl.textContent = '❌ ' + t('err.invalidRate', 'ค่า Rate ไม่ถูกต้อง'); return; }
    // Light client-side sanity — backend caps length at 256 (real OpenAI
    // service-account keys are ~167 chars, project keys similar)
    if (apiKeyNew && apiKeyNew.length > 256) {
      errEl.textContent = '❌ ' + t('err.apiKeyTooLong', 'API key ยาวเกินกำหนด (max 256 chars)'); return;
    }
    if (apiKeyNew && !/^sk-/.test(apiKeyNew)) {
      errEl.textContent = '⚠ ' + t('warn.apiKeyFormat', 'API key ปกติขึ้นต้นด้วย "sk-" — กรุณาตรวจสอบ'); return;
    }

    var self = this;
    var body = {
      name: name, description: desc,
      inputRate: inputRate, outputRate: outputRate, creditLimit: creditLit,
    };
    // Only include apiKey if admin actually typed one — empty = keep existing
    // (backend uses COALESCE($2, project_api_key) so omitted = unchanged)
    if (apiKeyNew) body.apiKey = apiKeyNew;

    fetch(BASE + '/api/projects/' + encodeURIComponent(projectId), {
      method: 'PUT',
      headers: Auth.authHeaders(),
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = '❌ ' + t('err.dbRejected', 'DB ปฏิเสธ: ') + (d.error || 'unknown'); return; }
        hideModal('modal-edit-project');
        flash('✅ ' + tf('msg.projectUpdated', { name: name }, 'อัปเดต Project "{name}" เรียบร้อย (saved to DB)'));
        self.fetchProjectsFromDB().then(function () {
          self.renderProjects();
          self.refreshProjectSelects();
        });
      })
      .catch(function (e) { errEl.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; });
  },

  // ── REMOVE USER FROM PROJECT ── เดิมแก้แค่ localStorage ไม่แตะ DB — ตอนนี้ PUT จริง + await + re-render
  _pendingRemoveFromProject: null,

  removeFromProject: function (username) {
    var users = this.getUsersWithHistory();
    var u = users.find(function (x) { return x.username === username; });
    if (!u || !u.id) { flash('❌ ' + t('err.userIdNotFound', 'ไม่พบ user_id (DB row)'), 'error'); return; }
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
          if (err) err.textContent = '❌ ' + msg;
          if (btn) { btn.disabled = false; btn.textContent = t('m.removeUser.confirm', 'ยืนยันย้ายออก'); }
          return;
        }
        // Mirror to localStorage
        try { Auth.setUserProject(p.username, null); } catch (_) {}
        self._pendingRemoveFromProject = null;
        hideModal('modal-confirm-remove-user-from-project');
        flash('✅ ' + tf('msg.ownerMoved', { username: p.username }, 'ย้าย @{username} ออกจาก project แล้ว'));
        // Re-fetch users so project member lists are accurate
        self.fetchUsersFromDB().then(function (users) {
          self._cachedDBUsers = users;
          self.renderProjects();
        });
      })
      .catch(function (e) {
        if (err) err.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('m.removeUser.confirm', 'ยืนยันย้ายออก'); }
      });
  },

  // ── DELETE PROJECT ── มีประวัติแชท server จะปฏิเสธ — โชว์ error ใน modal ให้รู้ว่าต้องทำอะไรก่อน
  _pendingDeleteProject: null,

  deleteProject: function (projectId) {
    var p = Auth.getProjectById(projectId);
    if (!p) { flash('❌ ' + t('err.projectNotFound', 'ไม่พบ project'), 'error'); return; }

    // Count DB members for the summary — cache falls back gracefully.
    var members = (this._cachedDBUsers || []).filter(function (u) { return u.projectId === projectId; });
    // Credits: the project list has credits in p.credits if available, else 0.
    var credits = (typeof p.credits === 'number' ? p.credits : 0);

    this._pendingDeleteProject = { id: projectId, name: p.name, memberCount: members.length };

    var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    set('cdp-name',    p.name);
    set('cdp-id',      projectId);
    set('cdp-members', String(members.length));
    set('cdp-credits', formatTHB(credits));

    // Tweak warning text if members > 0
    var warn = document.getElementById('cdp-warning');
    if (warn) {
      warn.innerHTML = members.length > 0
        ? '⚠ ' + tf('confirm.removeMembersWarn', { n: members.length }, 'มีสมาชิก {n} คนใน project นี้ — ทุกคนจะถูกย้ายออก (ไม่ได้ถูกลบ)<br>Balance ของ project จะถูกล้าง')
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
          if (err) err.textContent = '❌ ' + msg;
          if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }
          return;
        }
        try { Auth.deleteProject(p.id); } catch (_) {}
        self._pendingDeleteProject = null;
        hideModal('modal-confirm-delete-project');
        flash('✅ ' + tf('msg.projectDeleted', { name: p.name }, 'ลบ Project "{name}" แล้ว'));
        // Real-time refresh: fetch projects + users (members now unassigned)
        Promise.all([self.fetchProjectsFromDB(), self.fetchUsersFromDB()])
          .then(function (results) {
            self._cachedDBUsers = results[1] || [];
            self.renderProjects();
            self.refreshProjectSelects();
          });
      })
      .catch(function (e) {
        if (err) err.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('btn.deletePermanent', 'ลบถาวร'); }
      });
  },

  // ── ADD PROJECT ── ฟอร์มถามแค่ชื่อ+คำอธิบาย — rate/limit ใช้ default แล้วค่อยแก้ทีหลัง
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

    if (!name) { errEl.textContent = '❌ ' + t('err.enterProjectName', 'กรุณาใส่ชื่อ Project'); return; }

    var self = this;
    fetch(BASE + '/api/projects', {
      method: 'POST', headers: Auth.authHeaders(),
      // inputRate / outputRate / creditLimit omitted → server applies defaults
      body: JSON.stringify({ name: name, description: desc }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = '❌ ' + t('err.dbRejected', 'DB ปฏิเสธ: ') + (d.error || 'unknown'); return; }
        hideModal('modal-add-project');
        // แถวลง DB เสมอ; ถ้า link OpenAI ล้ม (openai_project_id null) เตือน — ไม่ ✅ เงียบ
        if (d.openai && d.openai.synced === false) {
          flash('⚠ ' + tf('msg.projectCreatedOpenAiFail', { name: name, err: d.openai.error || 'unknown' }, 'สร้าง Project "{name}" ใน DB แล้ว แต่เชื่อม OpenAI ไม่สำเร็จ: {err} — ยังไม่มี OpenAI project id'), 'error');
        } else {
          flash('✅ ' + tf('msg.projectCreated', { name: name }, 'สร้าง Project "{name}" เรียบร้อย')
            + (d.openai && d.openai.project_id ? ' · OpenAI: ' + d.openai.project_id : ''));
        }
        self.fetchProjectsFromDB().then(function () {
          self.renderProjects();
          self.refreshProjectSelects();
        });
      })
      .catch(function (e) { errEl.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; });
  },

  refreshProjectSelects: function () {
    // เหลือเป็น stub — dropdown ดึงของสดตอนคลิกแล้ว; กันผู้เรียกเก่าพัง
  },
};
