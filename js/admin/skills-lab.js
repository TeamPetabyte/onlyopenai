// skills-lab.js — Skill Prompts + Prompt Lab + verdict + Evals
import { escapeHtml, flash, formatDateStd, hideModal, showModal } from './helpers.js';

export default {
  // ── SKILL PROMPTS ── มุมมอง registry; CRUD เต็มรออนุมัติย้ายลง DB
  renderSkills: function () {
    var self = this;
    var statusEl = document.getElementById('skills-status');
    var listEl   = document.getElementById('skills-list');
    if (statusEl) statusEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-3)">' + t('common.loading', '⏳ กำลังโหลด...') + '</div>';
    if (listEl)   listEl.innerHTML = '';

    fetch(BASE + '/api/skills', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          statusEl.innerHTML = '<div style="padding:24px;color:#e25563">⚠ ' + escapeHtml(d.error || 'failed') + '</div>';
          return;
        }
        self._renderSkillsStatus(d.status, d.skills);
        self._renderSkillsList(d.skills);
      })
      .catch(function (e) {
        if (statusEl) statusEl.innerHTML = '<div style="padding:24px;color:#e25563">⚠ ' + escapeHtml(e.message) + '</div>';
      });
  },

  _renderSkillsStatus: function (status, skills) {
    var el = document.getElementById('skills-status');
    if (!el) return;
    var loadedAt = status && status.loadedAt ? formatDateStd(status.loadedAt) : '—';
    var configuredCount = (skills || []).filter(function (s) { return !s.isPlaceholder; }).length;
    var totalCount = (skills || []).length;
    var hasError = status && status.error;

    var statusPill = hasError
      ? '<span style="display:inline-block;padding:4px 12px;border-radius:20px;background:rgba(220,53,69,0.10);color:#e25563;border:1px solid rgba(220,53,69,0.35);font-size:.82rem;font-weight:600">🔴 Load error</span>'
      : configuredCount === totalCount
        ? '<span style="display:inline-block;padding:4px 12px;border-radius:20px;background:rgba(55,179,74,0.10);color:#3fa64d;border:1px solid rgba(55,179,74,0.35);font-size:.82rem;font-weight:600">🟢 All configured</span>'
        : '<span style="display:inline-block;padding:4px 12px;border-radius:20px;background:rgba(240,160,64,0.10);color:#e6a14a;border:1px solid rgba(240,160,64,0.35);font-size:.82rem;font-weight:600">🟡 ' + configuredCount + '/' + totalCount + ' configured</span>';

    var blocks = [
      { label: 'Status',     value: statusPill },
      { label: 'Total',      value: '<span style="font-family:Geist Mono,monospace">' + totalCount + ' skills</span>' },
      { label: 'Configured', value: '<span style="font-family:Geist Mono,monospace;color:#3fa64d">' + configuredCount + '</span>' },
      { label: 'Placeholder',value: '<span style="font-family:Geist Mono,monospace;color:#e6a14a">' + (totalCount - configuredCount) + '</span>' },
      { label: 'Last Loaded',value: '<span style="font-family:Geist Mono,monospace;font-size:.82rem">' + loadedAt + '</span>' },
    ];

    el.innerHTML =
        '<h3 class="card-title" style="margin-bottom:14px">Registry Status</h3>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px">'
      +   blocks.map(function (b) {
            return '<div style="padding:10px 14px;background:var(--surface-3);'
              + 'border:1px solid var(--border-subtle);border-radius:8px">'
              + '<div style="font-size:.66rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">' + b.label + '</div>'
              + '<div style="font-size:.95rem;font-weight:600">' + b.value + '</div>'
              + '</div>';
          }).join('')
      + '</div>'
      + (hasError
          ? '<div style="margin-top:14px;padding:12px 14px;background:rgba(220,53,69,0.06);border:1px solid rgba(220,53,69,0.30);border-radius:8px;color:#e25563;font-size:.82rem;font-family:Geist Mono,monospace">'
            + '<b>Load error:</b> ' + escapeHtml(status.error) + '</div>'
          : '');
  },

  _renderSkillsList: function (skills) {
    var el = document.getElementById('skills-list');
    if (!el) return;
    if (!skills || skills.length === 0) {
      el.innerHTML = '<div class="glass-card" style="padding:32px;text-align:center;color:var(--text-3)">'
        + t('empty.noSkillsYetHtml', '🧩 ยังไม่มี skill ในไฟล์ — แก้ <code>server/config/skill-prompts.json</code> แล้วกด <b>Reload</b>') + '</div>';
      return;
    }
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    var cards = skills.map(function (s) {
      var statusBadge = s.isPlaceholder
        ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:20px;background:rgba(240,160,64,0.10);color:#e6a14a;border:1px solid rgba(240,160,64,0.35);font-size:.7rem;font-weight:600">⚠ Placeholder</span>'
        : '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:20px;background:rgba(55,179,74,0.10);color:#3fa64d;border:1px solid rgba(55,179,74,0.30);font-size:.7rem;font-weight:600">✓ Configured</span>';
      var openaiPill = s.openaiPromptId
        ? '<span style="font-family:Geist Mono,monospace;font-size:.7rem;padding:2px 7px;background:var(--accent-soft-bg);color:var(--accent);border:1px solid var(--accent-soft-border);border-radius:5px">' + escapeHtml(s.openaiPromptId) + '</span>'
        : '<span style="color:var(--text-3);font-size:.72rem;font-style:italic">no openai ref</span>';

      var idJs = "'" + String(s.id).replace(/'/g, "\\'") + "'";
      return '<div class="glass-card" style="margin-bottom:14px">'
        + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:10px">'
        +   '<div style="flex:1;min-width:240px">'
        +     '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">'
        +       '<div style="font-size:1.05rem;font-weight:700;color:var(--text-1)">' + escapeHtml(s.label) + '</div>'
        +       statusBadge
        +     '</div>'
        +     '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">'
        +       '<span style="font-family:Geist Mono,monospace;font-size:.74rem;color:var(--text-3)">id: <b style="color:var(--text-2)">' + escapeHtml(s.id) + '</b></span>'
        +       openaiPill
        +     '</div>'
        +     '<div style="font-size:.86rem;color:var(--text-2);line-height:1.5">' + escapeHtml(s.description || '—') + '</div>'
        +   '</div>'
        +   '<div style="display:flex;gap:8px;flex-shrink:0">'
        // v1.5.1: test/history buttons removed — all testing lives in the
        // 🧪 Prompt Lab tab now; this page only manages the prompts.
        +     '<button class="btn-action btn-save" style="padding:7px 14px" onclick="admin.openEditSkill(' + idJs + ')">✏️ ' + escapeHtml(TT('btn.edit', 'แก้ไข')) + '</button>'
        +     '<button class="btn-action" style="padding:7px 12px;color:#e25563;border-color:rgba(220,53,69,0.35)" onclick="admin.deleteSkillPrompt(' + idJs + ')">🗑</button>'
        +   '</div>'
        + '</div>'
        + '<details style="margin-top:10px">'
        +   '<summary style="cursor:pointer;font-size:.74rem;color:var(--text-3);font-weight:600;user-select:none">'
        +     '📄 Content preview (' + s.contentLength + ' chars)</summary>'
        +   '<pre style="margin-top:8px;padding:12px;background:var(--surface-3);border:1px solid var(--border-subtle);border-radius:6px;font-family:Geist Mono,monospace;font-size:.75rem;color:var(--text-2);white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto">'
        +     escapeHtml(s.contentPreview) + '</pre>'
        + '</details>'
        + '</div>';
    }).join('');
    el.innerHTML = cards;
  },

  reloadSkills: function () {
    var self = this;
    fetch(BASE + '/api/skills/reload', {
      method: 'POST', headers: Auth.authHeaders(),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { flash('❌ ' + t('msg.reloadFailedPrefix', 'Reload failed: ') + (d.error || 'unknown'), 'error'); return; }
        if (d.status && d.status.error) {
          flash('⚠ ' + t('msg.reloadedWithErrorPrefix', 'Reloaded แต่มี error: ') + d.status.error, 'error');
        } else {
          flash('✅ ' + tf('msg.reloadSuccess', { count: (d.status && d.status.count) || 0 }, 'Reload เรียบร้อย · {count} skills'));
        }
        self.renderSkills();
      })
      .catch(function (e) { flash('❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message, 'error'); });
  },

  // ── Phase 22: add / edit / delete skill prompts from the UI ──────
  _fillSkillModal: function (s) {
    var g = function (id) { return document.getElementById(id); };
    g('es-id').value      = s.id || '';
    g('es-label').value   = s.label || '';
    g('es-desc').value    = s.description || '';
    g('es-openai').value  = s.openaiPromptId || '';
    g('es-content').value = s.content || '';
    g('es-error').textContent = '';
    this._updateSkillCharCount();
  },

  _updateSkillCharCount: function () {
    var el = document.getElementById('es-content');
    var c  = document.getElementById('es-charcount');
    if (el && c) c.textContent = (el.value || '').length.toLocaleString() + ' chars';
  },

  // ── Prompt Lab ── ทดสอบ prompt โดยไม่แตะ budget gate/ประวัติแชทจริง — เลือก skill+model รัน ตัดสิน ดูประวัติ ในหน้าเดียว

  // Entry point from the Skill Prompts cards: 🧪 opens the lab on that skill,
  // 📋 additionally scrolls down to the history block.
  openPromptLab: function (skillId, showHistory) {
    if (skillId) this._labSkillId = skillId;
    this.navigate('lab');
    if (showHistory) {
      setTimeout(function () {
        var el = document.getElementById('lab-history-card');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 450);
    }
  },

  renderLab: function () {
    var self = this;
    fetch(BASE + '/api/skills', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) return;
        var sel = d.skills || [];
        var el  = document.getElementById('lab-skill');
        if (!el) return;
        // v1.9.1: Auto is the default — the chat router picks the prompt so
        // seniors don't have to; history shows which skill each run matched.
        var want = self._labSkillId || 'auto';
        el.innerHTML = '<option value="auto">' + escapeHtml(t('lab.autoSkill', '🤖 Auto — AI เลือก prompt เอง')) + '</option>'
          + sel.map(function (s) {
          return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.label || s.id) + '</option>';
        }).join('');
        el.value = want;
        if (!el.value) el.value = 'auto';
        self._labSkillId = el.value;
        self.onLabSkillChange();
      })
      .catch(function () {});
  },

  onLabSkillChange: function () {
    var el = document.getElementById('lab-skill');
    if (el && el.value) this._labSkillId = el.value;
    // A different skill means the old answer/verdict no longer applies.
    var ans = document.getElementById('lab-answer'); if (ans) ans.textContent = '';
    var meta = document.getElementById('lab-meta');  if (meta) meta.textContent = '';
    this.showVerdictBar('lab', null);
    this._loadLabPrompt();
    this.loadTestHistory();
  },

  // v1.8.8: one-click fresh test — clears the question, answer, meta and the
  // approval bar so the next Run starts clean (no manual select-all-delete).
  labNewTest: function () {
    var box = document.getElementById('lab-question');
    if (box) box.value = '';
    this._labUpdateCharCount();
    var ans  = document.getElementById('lab-answer'); if (ans)  ans.textContent = '';
    var meta = document.getElementById('lab-meta');   if (meta) meta.textContent = '';
    var err  = document.getElementById('lab-error');  if (err)  err.textContent = '';
    this.showVerdictBar('lab', null);
    if (box) box.focus();
  },

  // Effort only applies to the gpt-5.6 reasoning family — hide it otherwise.
  onLabModelChange: function (v) {
    var f = document.getElementById('lab-effort-field');
    if (f) f.style.display = (v && v.indexOf('gpt-5.6') === 0) ? '' : 'none';
  },

  // Show which system prompt is being tested (full content + length) so the
  // page explains itself: question vs THIS prompt.
  _loadLabPrompt: function () {
    var id = this._labSkillId;
    if (!id) return;
    // v1.9.1: auto mode has no fixed prompt to preview.
    if (id === 'auto') {
      var sum = document.getElementById('lab-prompt-summary');
      var pre = document.getElementById('lab-prompt-preview');
      if (sum) sum.textContent = '🤖 ' + t('lab.autoSummary', 'Auto — AI เลือก prompt จากคำถามอัตโนมัติ');
      if (pre) pre.textContent = t('lab.autoPreview',
        'โหมด Auto: ระบบใช้ router ตัวเดียวกับหน้าแชทจริงเลือก skill prompt ที่เหมาะกับคำถาม\nผลรันและประวัติจะแสดงว่าจับคู่กับ prompt ตัวไหน');
      return;
    }
    fetch(BASE + '/api/skills/' + encodeURIComponent(id), { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok || !d.skill) return;
        var sum = document.getElementById('lab-prompt-summary');
        var pre = document.getElementById('lab-prompt-preview');
        if (sum) sum.textContent = '📄 ' + t('lab.promptSummary', 'System prompt ที่ใช้ทดสอบ')
          + ' — ' + (d.skill.label || d.skill.id) + ' (' + (d.skill.content || '').length.toLocaleString() + ' chars)';
        if (pre) pre.textContent = d.skill.content || '';
      })
      .catch(function () {});
  },

  labRun: function () {
    var self = this;
    var id   = this._labSkillId;
    var g    = function (elId) { return document.getElementById(elId); };
    var prompt = (g('lab-question').value || '').trim();
    var errEl  = g('lab-error');
    if (!id) return;
    if (!prompt) { errEl.textContent = t('err.enterTestPrompt', 'กรุณากรอกคำถามทดสอบ'); return; }
    errEl.textContent = '';

    var btn = g('lab-run-btn');
    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; btn.textContent = t('common.running', 'กำลังรัน...'); }
    var ans = g('lab-answer'); if (ans) ans.textContent = '';
    var meta = g('lab-meta');  if (meta) meta.textContent = '';
    this.showVerdictBar('lab', null);

    fetch(BASE + '/api/skills/' + encodeURIComponent(id) + '/test', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
      body: JSON.stringify({
        prompt: prompt,
        model:  (g('lab-model')  || {}).value,
        effort: (g('lab-effort') || {}).value,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = d.error || t('err.testFailed', 'ทดสอบไม่สำเร็จ'); return; }
        if (ans) ans.textContent = d.answer || t('msg.emptyResponse', '(empty response)');
        if (meta) meta.textContent = (d.inputTokens + d.outputTokens).toLocaleString() + ' tokens'
          + (d.model ? ' · ' + d.model : '')
          + (d.routed ? ' · 🎯 ' + (d.routed.label || d.routed.skillId || '') : '');   // v1.9.1: which prompt Auto matched
        self.showVerdictBar('lab', d.logId || null);
        // The run itself created a (pending) history row — refresh the list.
        self.loadTestHistory(true);
      })
      .catch(function (e) { errEl.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = '▶ ' + t('btn.run', 'Run'); }
      });
  },

  // แนบไฟล์ Z-program: 1MB/ไฟล์ + รวม 1.5MB (express.json รับ 2MB) — append เข้า textarea ให้แก้ได้ backend ไม่ต้องเปลี่ยน
  _LAB_MAX_FILE_BYTES:  1024 * 1024,
  _LAB_MAX_TOTAL_CHARS: 1536 * 1024,

  labAttachFiles: function (e) {
    var self  = this;
    var files = Array.prototype.slice.call((e.target && e.target.files) || []);
    e.target.value = '';                       // allow re-attaching the same file
    if (!files.length) return;
    var errEl = document.getElementById('lab-error');
    var box   = document.getElementById('lab-question');
    if (!box) return;
    if (errEl) errEl.textContent = '';

    var queue = Promise.resolve();
    files.forEach(function (file) {
      queue = queue.then(function () {
        return new Promise(function (resolve) {
          if (file.size > self._LAB_MAX_FILE_BYTES) {
            var kb = (file.size / 1024).toFixed(0);
            if (errEl) errEl.textContent = (typeof tf === 'function')
              ? tf('u.file.tooLarge', { kb: kb })
              : t('u.file.tooLarge', 'ไฟล์ใหญ่เกินไป (' + kb + ' KB) — สูงสุด 1 MB');
            return resolve();
          }
          var reader = new FileReader();
          reader.onload = function (ev) {
            var block = '* ===== File: ' + file.name + ' =====\n' + ev.target.result;
            var joined = box.value ? box.value.replace(/\s+$/, '') + '\n\n' + block : block;
            if (joined.length > self._LAB_MAX_TOTAL_CHARS) {
              if (errEl) errEl.textContent = t('lab.totalTooLarge', 'เนื้อหารวมใหญ่เกิน 1.5 MB — ลบบางส่วนออกก่อน');
              return resolve();
            }
            box.value = joined;
            self._labUpdateCharCount();
            resolve();
          };
          reader.onerror = function () {
            if (errEl) errEl.textContent = t('u.file.readFailed', 'อ่านไฟล์ไม่สำเร็จ');
            resolve();
          };
          reader.readAsText(file);
        });
      });
    });
  },

  _labUpdateCharCount: function () {
    var box = document.getElementById('lab-question');
    var el  = document.getElementById('lab-char-count');
    if (!box || !el) return;
    var n = box.value.length;
    el.textContent = n ? n.toLocaleString() + ' ' + t('lab.charCount', 'ตัวอักษร') : '';
  },

  // ── verdict ── renderer เดียวใช้ทั้ง modal เทสต์ (prefix ts) และหน้า history (th) — id ขึ้นต้นด้วย prefix กันชน

  _verdictLogIds: {},   // prefix → log_id currently being judged
  _verdictPick:   {},   // prefix → selected verdict value

  _VERDICTS: [
    { v: 'correct',   icon: '✅', key: 'modal.testSkill.vCorrect',   fb: 'ถูกต้อง' },
    { v: 'partial',   icon: '⚠️', key: 'modal.testSkill.vPartial',   fb: 'เกือบถูก' },
    { v: 'incorrect', icon: '❌', key: 'modal.testSkill.vIncorrect', fb: 'ผิด' },
  ],

  // Render the judgement bar into #<prefix>-verdict. `existing` (optional) is
  // a full log record — the history detail passes it to prefill a past verdict.
  showVerdictBar: function (prefix, logId, existing) {
    var box = document.getElementById(prefix + '-verdict');
    if (!box) return;
    if (!logId) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    this._verdictLogIds[prefix] = logId;
    this._verdictPick[prefix]   = null;

    var btns = this._VERDICTS.map(function (d) {
      return '<button type="button" class="btn-action" id="' + prefix + '-v-' + d.v + '" style="padding:6px 13px"'
        + ' onclick="admin.pickVerdict(\'' + prefix + '\',\'' + d.v + '\')">'
        + d.icon + ' ' + escapeHtml(TT(d.key, d.fb)) + '</button>';
    }).join('');

    box.innerHTML =
        '<div style="padding:11px;border:1px solid var(--border-subtle);border-radius:6px;background:var(--surface-3)">'
      +   '<label class="modal-label" style="margin-bottom:6px">' + escapeHtml(TT('modal.testSkill.verdictLabel', 'การอนุมัติ (senior)')) + '</label>'
      +   '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">' + btns + '</div>'
      +   '<div id="' + prefix + '-corrected-wrap" style="display:none;margin-bottom:8px">'
      +     '<label class="modal-label">' + escapeHtml(TT('modal.testSkill.correctedLabel', 'เฉลยที่ถูกต้อง')) + '</label>'
      +     '<textarea class="modal-input" id="' + prefix + '-corrected" rows="4" placeholder="'
      +       escapeHtml(TT('modal.testSkill.correctedPh', 'วางคำตอบที่ถูกต้อง — จะกลายเป็นเฉลยใน golden dataset')) + '"></textarea>'
      +   '</div>'
      +   '<div class="modal-row">'
      +     '<div class="modal-field"><label class="modal-label">' + escapeHtml(TT('modal.testSkill.categoryLabel', 'หมวด (ไม่บังคับ)')) + '</label>'
      +       '<input class="modal-input" id="' + prefix + '-category" placeholder="FI / MM / SD / ..." /></div>'
      +     '<div class="modal-field"><label class="modal-label">' + escapeHtml(TT('modal.testSkill.noteLabel', 'โน้ต (ไม่บังคับ)')) + '</label>'
      +       '<input class="modal-input" id="' + prefix + '-vnote" /></div>'
      +   '</div>'
      +   '<div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:8px">'
      +     '<span id="' + prefix + '-verdict-msg" style="font-size:.75rem;color:#3fa64d"></span>'
      +     '<button type="button" class="btn-modal-submit" id="' + prefix + '-verdict-save" onclick="admin.saveVerdict(\'' + prefix + '\')">💾 '
      +       escapeHtml(TT('modal.testSkill.saveVerdict', 'บันทึกการอนุมัติ')) + '</button>'
      +   '</div>'
      + '</div>';
    box.style.display = '';

    if (existing) {
      if (existing.verdict) this.pickVerdict(prefix, existing.verdict);
      var c = document.getElementById(prefix + '-corrected'); if (c) c.value = existing.corrected_answer || '';
      var g = document.getElementById(prefix + '-category');  if (g) g.value = existing.category || '';
      var n = document.getElementById(prefix + '-vnote');     if (n) n.value = existing.verdict_note || '';
    }
  },

  pickVerdict: function (prefix, v) {
    this._verdictPick[prefix] = v;
    this._VERDICTS.forEach(function (d) {
      var b = document.getElementById(prefix + '-v-' + d.v);
      if (!b) return;
      var on = d.v === v;
      b.style.background  = on ? 'var(--accent-soft-bg)' : '';
      b.style.borderColor = on ? 'var(--accent-soft-border)' : '';
      b.style.color       = on ? 'var(--accent)' : '';
      b.style.fontWeight  = on ? '700' : '';
    });
    // The corrected-answer box only matters when the AI got it (partly) wrong.
    var wrap = document.getElementById(prefix + '-corrected-wrap');
    if (wrap) wrap.style.display = (v === 'partial' || v === 'incorrect') ? '' : 'none';
  },

  saveVerdict: function (prefix) {
    var self  = this;
    var logId = this._verdictLogIds[prefix];
    var v     = this._verdictPick[prefix];
    var msg   = document.getElementById(prefix + '-verdict-msg');
    if (!logId) return;
    if (!v) { if (msg) { msg.style.color = '#e25563'; msg.textContent = t('err.pickVerdict', 'เลือกผลอนุมัติก่อน'); } return; }
    var gv  = function (suffix) { var el = document.getElementById(prefix + suffix); return el ? el.value : ''; };
    var btn = document.getElementById(prefix + '-verdict-save');
    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
    fetch(BASE + '/api/skill-test-logs/' + logId + '/verdict', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
      body: JSON.stringify({
        verdict: v,
        correctedAnswer: gv('-corrected'),
        note: gv('-vnote'),
        category: gv('-category'),
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { if (msg) { msg.style.color = '#e25563'; msg.textContent = d.error || t('err.saveFailed', 'บันทึกไม่สำเร็จ'); } return; }
        if (msg) { msg.style.color = '#3fa64d'; msg.textContent = '✓ ' + t('modal.testSkill.verdictSaved', 'บันทึกแล้ว'); }
        // refresh list ให้ badge/สถิติตรงกับ verdict ที่เพิ่งบันทึก
        if (prefix === 'lab' || prefix === 'lh') self.loadTestHistory(true);
      })
      .catch(function (e) { if (msg) { msg.style.color = '#e25563'; msg.textContent = e.message; } })
      .finally(function () { if (btn) { btn.disabled = false; btn.style.opacity = '1'; } });
  },

  // keepDetail=true → don't collapse the open detail pane (used after saving
  // a verdict from the detail view so the senior keeps their place).
  loadTestHistory: function (keepDetail) {
    var self    = this;
    // history เป็น GLOBAL ทุก skill — เคย scope ตาม dropdown แล้ว tester งงว่ารันหาย
    var verdict = (document.getElementById('lab-filter') || {}).value || '';
    var errEl   = document.getElementById('lab-hist-error');
    var listEl  = document.getElementById('lab-list');
    if (!keepDetail) {
      var det = document.getElementById('lab-detail');
      if (det) { det.style.display = 'none'; det.innerHTML = ''; }
    }
    if (listEl) listEl.innerHTML = '<div style="padding:14px;color:var(--text-3);font-size:.8rem">'
      + t('common.loading', '⏳ กำลังโหลด...') + '</div>';
    fetch(BASE + '/api/skill-test-logs' + (verdict ? '?verdict=' + verdict : ''),
        { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { if (errEl) errEl.textContent = d.error || t('err.loadFailed', 'โหลดไม่สำเร็จ'); return; }
        self._renderTestHistory(d.rows || [], d.stats || {});
      })
      .catch(function (e) { if (errEl) errEl.textContent = e.message; });
  },

  _verdictBadge: function (v) {
    if (v === 'correct')   return '<span style="font-weight:700">✅</span>';
    if (v === 'partial')   return '<span style="font-weight:700">⚠️</span>';
    if (v === 'incorrect') return '<span style="font-weight:700">❌</span>';
    return '<span style="color:var(--text-3)">⏳</span>';
  },

  _renderTestHistory: function (rows, stats) {
    var listEl  = document.getElementById('lab-list');
    var statsEl = document.getElementById('lab-stats');
    if (statsEl) statsEl.innerHTML = t('modal.testHistory.total', 'รวม') + ' <b>' + (stats.total || 0) + '</b>'
      + ' · ✅ ' + (stats.correct || 0) + ' · ⚠️ ' + (stats.partial || 0)
      + ' · ❌ ' + (stats.incorrect || 0) + ' · ⏳ ' + (stats.pending || 0)
      + ' · ⭐ ' + (stats.eval_cases || 0);
    if (!listEl) return;
    if (!rows.length) {
      listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-3);font-size:.8rem">'
        + t('modal.testHistory.empty', 'ยังไม่มีการทดสอบ skill นี้') + '</div>';
      return;
    }
    listEl.innerHTML = rows.map(function (r) {
      var dt   = new Date(r.created_at);
      var when = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return '<div onclick="admin.openTestLogDetail(' + r.log_id + ')"'
        + ' style="display:flex;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--border-subtle);cursor:pointer"'
        + ' onmouseover="this.style.background=\'var(--surface-3)\'" onmouseout="this.style.background=\'\'">'
        + admin._verdictBadge(r.verdict)
        + (r.is_eval_case ? '<span title="อยู่ในชุดข้อสอบ">⭐</span>' : '')
        + '<span style="font-size:.72rem;color:var(--text-3);white-space:nowrap">' + when + '</span>'
        + '<span style="font-family:Geist Mono,monospace;font-size:.68rem;color:var(--text-3);white-space:nowrap">' + escapeHtml(r.model || '') + '</span>'
        // v1.8.5: global history — say which skill/prompt this run tested
        + (r.skill_label ? '<span style="font-size:.68rem;padding:1px 7px;border-radius:10px;background:var(--surface-3);border:1px solid var(--border-subtle);color:var(--text-2);white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(r.skill_label) + '</span>' : '')
        + (r.category ? '<span style="font-size:.68rem;padding:1px 7px;border-radius:10px;background:var(--accent-soft-bg);color:var(--accent)">' + escapeHtml(r.category) + '</span>' : '')
        + '<span style="flex:1;font-size:.78rem;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(r.question_preview || '') + '</span>'
        + '</div>';
    }).join('');
  },

  openTestLogDetail: function (logId) {
    var self = this;
    fetch(BASE + '/api/skill-test-logs/' + logId, { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          var e = document.getElementById('lab-hist-error');
          if (e) e.textContent = d.error || t('err.loadFailed', 'โหลดไม่สำเร็จ');
          return;
        }
        self._renderTestLogDetail(d.log);
      })
      .catch(function (e2) {
        var e = document.getElementById('lab-hist-error');
        if (e) e.textContent = e2.message;
      });
  },

  _renderTestLogDetail: function (log) {
    var det = document.getElementById('lab-detail');
    if (!det) return;
    var pre = function (label, text) {
      return '<label class="modal-label" style="margin-top:8px">' + escapeHtml(label) + '</label>'
        + '<pre style="margin:0;padding:10px;background:var(--surface-3);border:1px solid var(--border-subtle);border-radius:6px;font-family:\'Geist Mono\',monospace;font-size:.76rem;color:var(--text-2);white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto">'
        + escapeHtml(text || '') + '</pre>';
    };
    // ⭐ promote/demote into the exam set. Only judged cases with a
    // golden reference qualify — the backend enforces it; here we just hint.
    var canStar = log.verdict === 'correct' || (log.corrected_answer || '').trim();
    var starBtn = log.verdict
      ? '<button type="button" class="btn-action" style="padding:4px 12px;font-size:.75rem'
        + (log.is_eval_case ? ';background:var(--accent-soft-bg);border-color:var(--accent-soft-border);color:var(--accent)' : '')
        + '" onclick="admin.toggleEvalCase(' + log.log_id + ',' + (!log.is_eval_case) + ')"'
        + (canStar ? '' : ' disabled title="' + escapeHtml(t('evals.needGolden', 'ต้องมีเฉลย หรืออนุมัติ = ถูกต้อง ก่อน')) + '"')
        + '>' + (log.is_eval_case
            ? '⭐ ' + escapeHtml(t('evals.inSet', 'อยู่ในชุดข้อสอบ — กดเพื่อเอาออก'))
            : '☆ ' + escapeHtml(t('evals.addToSet', 'เข้าชุดข้อสอบ')))
        + '</button>'
      : '';
    det.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:2px;flex-wrap:wrap">'
      +   '<span style="font-size:.72rem;color:var(--text-3)">#' + log.log_id
      +     (log.skill_label ? ' · ' + escapeHtml(log.skill_label) : '') + ' · ' + escapeHtml(log.model || '')
      +     (log.effort ? ' / ' + escapeHtml(log.effort) : '')
      +     ' · ' + ((log.input_tokens || 0) + (log.output_tokens || 0)).toLocaleString() + ' tokens</span>'
      +   starBtn
      + '</div>'
      + pre(t('modal.testHistory.question', 'โจทย์'), log.question)
      + pre(t('modal.testSkill.answerLabel', 'คำตอบ AI'), log.answer)
      + '<div id="lh-verdict" style="display:none;margin-top:10px"></div>';
    det.style.display = '';
    this.showVerdictBar('lh', log.log_id, log);
    det.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  // ⭐ toggle → backend validates (needs verdict + golden reference), then
  // re-render both the detail (button state) and the list (row badge/stats).
  toggleEvalCase: function (logId, on) {
    var self = this;
    fetch(BASE + '/api/skill-test-logs/' + logId + '/eval-case', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
      body: JSON.stringify({ on: on }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var e = document.getElementById('lab-hist-error');
        if (!d.ok) { if (e) e.textContent = d.error || t('err.saveFailed', 'บันทึกไม่สำเร็จ'); return; }
        if (e) e.textContent = '';
        self.openTestLogDetail(logId);
        self.loadTestHistory(true);
      })
      .catch(function (err) {
        var e = document.getElementById('lab-hist-error');
        if (e) e.textContent = err.message;
      });
  },

  // ── Phase 30: Evals page — exam runner + score report ─────────────────

  renderEvals: function () {
    var self = this;
    fetch(BASE + '/api/skills', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) return;
        var el = document.getElementById('ev-skill');
        if (!el) return;
        var want = self._evalSkillId || self._labSkillId || (d.skills[0] && d.skills[0].id) || '';
        el.innerHTML = (d.skills || []).map(function (s) {
          return '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.label || s.id) + '</option>';
        }).join('');
        el.value = want;
        if (!el.value && d.skills.length) el.value = d.skills[0].id;
        self._evalSkillId = el.value;
        self.onEvalSkillChange();
      })
      .catch(function () {});
  },

  onEvalSkillChange: function () {
    var el = document.getElementById('ev-skill');
    if (el && el.value) this._evalSkillId = el.value;
    var self = this;
    // ⭐ ready-count for the selected skill (from the test-log stats).
    fetch(BASE + '/api/skill-test-logs?skill=' + encodeURIComponent(this._evalSkillId) + '&limit=1',
      { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var s = document.getElementById('ev-ready');
        if (!s) return;
        var n = (d.ok && d.stats && d.stats.eval_cases) || 0;
        s.innerHTML = '⭐ <b>' + n + '</b> ' + t('evals.readyCount', 'ข้อสอบพร้อมสอบ')
          + ' · ' + t('evals.judgeInfo', 'ผู้ตรวจ: GPT-5.6 Terra / high');
        var btn = document.getElementById('ev-run-btn');
        if (btn) btn.disabled = n === 0;
      })
      .catch(function () {});
    this.loadEvalRuns();
  },

  onEvalModelChange: function (v) {
    var f = document.getElementById('ev-effort-field');
    if (f) f.style.display = (v && v.indexOf('gpt-5.6') === 0) ? '' : 'none';
  },

  startEvalRun: function () {
    var self = this;
    var g = function (id) { return document.getElementById(id); };
    var errEl = g('ev-error');
    errEl.textContent = '';
    var btn = g('ev-run-btn');
    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
    fetch(BASE + '/api/evals', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
      body: JSON.stringify({
        skill:  this._evalSkillId,
        model:  (g('ev-model')  || {}).value,
        effort: (g('ev-effort') || {}).value,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          errEl.textContent = d.error || t('err.testFailed', 'เริ่มสอบไม่สำเร็จ');
          if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
          return;
        }
        self._activeEvalRunId = d.runId;
        var p = g('ev-progress'); if (p) p.style.display = '';
        self._pollEvalRun();
      })
      .catch(function (e) {
        errEl.textContent = e.message;
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
      });
  },

  // Poll the active run every 2.5s until it leaves 'running'. Each case takes
  // seconds (answer + judge), so this cadence is plenty.
  _pollEvalRun: function () {
    var self  = this;
    var runId = this._activeEvalRunId;
    if (!runId) return;
    fetch(BASE + '/api/evals/' + runId, { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { self._finishEvalUI(); return; }
        var run = d.run;
        var txt = document.getElementById('ev-progress-text');
        var bar = document.getElementById('ev-progress-bar');
        var pct = run.total_cases ? Math.round((run.done_cases / run.total_cases) * 100) : 0;
        if (txt) txt.textContent = t('evals.progress', 'กำลังสอบ') + ' ' + run.done_cases + '/' + run.total_cases
          + ' · ✅ ' + run.pass_cases;
        if (bar) bar.style.width = pct + '%';
        if (run.status === 'running') {
          self._evalPollTimer = setTimeout(function () { self._pollEvalRun(); }, 2500);
        } else {
          self._finishEvalUI();
          self.loadEvalRuns();
          self.openEvalRunDetail(runId);
        }
      })
      .catch(function () {
        self._evalPollTimer = setTimeout(function () { self._pollEvalRun(); }, 4000);
      });
  },

  _finishEvalUI: function () {
    if (this._evalPollTimer) { clearTimeout(this._evalPollTimer); this._evalPollTimer = null; }
    this._activeEvalRunId = null;
    var p = document.getElementById('ev-progress'); if (p) p.style.display = 'none';
    var b = document.getElementById('ev-run-btn');  if (b) { b.disabled = false; b.style.opacity = '1'; }
  },

  cancelEvalRun: function () {
    if (!this._activeEvalRunId) return;
    fetch(BASE + '/api/evals/' + this._activeEvalRunId + '/cancel', {
      method: 'POST', headers: Auth.authHeaders(),
    }).catch(function () {});
    // Keep polling — the loop flips the run to 'cancelled' after the current
    // case and the poller closes the UI from that status change.
  },

  loadEvalRuns: function () {
    var self = this;
    var skillId = this._evalSkillId;
    if (!skillId) return;
    fetch(BASE + '/api/evals?skill=' + encodeURIComponent(skillId), { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) return;
        self._renderEvalSummary(d.runs || []);
        self._renderEvalRuns(d.runs || []);
      })
      .catch(function () {});
  },

  // Top summary card: latest finished score + delta vs the previous sitting.
  _renderEvalSummary: function (runs) {
    var card = document.getElementById('ev-summary');
    if (!card) return;
    var done = runs.filter(function (r) { return r.status === 'done'; });
    if (!done.length) { card.style.display = 'none'; return; }
    var cur = done[0], prev = done[1];
    var delta = prev != null && prev.score_pct != null
      ? (Number(cur.score_pct) - Number(prev.score_pct)) : null;
    var deltaHtml = delta === null ? ''
      : delta >= 0
        ? '<span style="color:#3fa64d;font-weight:700"> ⬆ +' + delta.toFixed(1) + '</span>'
        : '<span style="color:#e25563;font-weight:700"> ⬇ ' + delta.toFixed(1) + '</span>';
    var trend = done.slice(0, 6).reverse().map(function (r) { return Number(r.score_pct).toFixed(0) + '%'; }).join(' → ');
    card.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">'
      +   '<div>'
      +     '<div style="font-size:.72rem;color:var(--text-3);font-weight:600;letter-spacing:.4px">' + escapeHtml(t('evals.latestScore', 'คะแนนล่าสุด')) + ' · run #' + cur.run_id + ' · ' + escapeHtml(cur.model) + (cur.effort ? '/' + escapeHtml(cur.effort) : '') + '</div>'
      +     '<div style="font-size:2rem;font-weight:800;color:var(--text-1)">' + Number(cur.score_pct).toFixed(1) + '%' + deltaHtml + '</div>'
      +     '<div style="font-size:.76rem;color:var(--text-2)">✅ ' + cur.pass_cases + ' / ' + cur.total_cases + ' ' + escapeHtml(t('evals.casesPassed', 'เคสผ่าน')) + '</div>'
      +   '</div>'
      +   '<div style="text-align:right">'
      +     '<div style="font-size:.72rem;color:var(--text-3);font-weight:600">' + escapeHtml(t('evals.trend', 'แนวโน้ม')) + '</div>'
      +     '<div style="font-family:\'Geist Mono\',monospace;font-size:.85rem;color:var(--text-2)">' + trend + '</div>'
      +   '</div>'
      + '</div>';
    card.style.display = '';
  },

  _renderEvalRuns: function (runs) {
    var el = document.getElementById('ev-runs');
    if (!el) return;
    if (!runs.length) {
      el.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-3);font-size:.8rem">'
        + t('evals.noRuns', 'ยังไม่เคยสอบ skill นี้ — กด ▶ Run Eval เพื่อเริ่มรอบแรก') + '</div>';
      return;
    }
    var badge = function (s) {
      if (s === 'done')      return '<span style="color:#3fa64d;font-weight:600">done</span>';
      if (s === 'running')   return '<span style="color:var(--accent);font-weight:600">running…</span>';
      if (s === 'cancelled') return '<span style="color:#e6a14a;font-weight:600">cancelled</span>';
      return '<span style="color:#e25563;font-weight:600">failed</span>';
    };
    el.innerHTML = runs.map(function (r) {
      var dt = new Date(r.started_at);
      var when = dt.toLocaleDateString() + ' ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return '<div onclick="admin.openEvalRunDetail(' + r.run_id + ')"'
        + ' style="display:flex;gap:12px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--border-subtle);cursor:pointer"'
        + ' onmouseover="this.style.background=\'var(--surface-3)\'" onmouseout="this.style.background=\'\'">'
        + '<b style="font-size:.78rem;color:var(--text-2);white-space:nowrap">#' + r.run_id + '</b>'
        + '<span style="font-size:.72rem;color:var(--text-3);white-space:nowrap">' + when + '</span>'
        + '<span style="font-family:\'Geist Mono\',monospace;font-size:.68rem;color:var(--text-3)">' + escapeHtml(r.model) + (r.effort ? '/' + escapeHtml(r.effort) : '') + '</span>'
        + badge(r.status)
        + '<span style="flex:1"></span>'
        + (r.score_pct != null ? '<b style="font-size:.85rem;color:var(--text-1)">' + Number(r.score_pct).toFixed(1) + '%</b>' : '')
        + '<span style="font-size:.72rem;color:var(--text-3)">' + r.pass_cases + '/' + r.total_cases + '</span>'
        + '</div>';
    }).join('');
  },

  openEvalRunDetail: function (runId) {
    var self = this;
    fetch(BASE + '/api/evals/' + runId, { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) return;
        self._renderEvalRunDetail(d.run, d.results || []);
      })
      .catch(function () {});
  },

  _renderEvalRunDetail: function (run, results) {
    var det = document.getElementById('ev-run-detail');
    if (!det) return;
    // Per-category pass rate (computed client-side — 30ish rows max).
    var byCat = {};
    results.forEach(function (r) {
      var c = r.category || '—';
      byCat[c] = byCat[c] || { total: 0, pass: 0 };
      byCat[c].total++;
      if (r.passed) byCat[c].pass++;
    });
    var catHtml = Object.keys(byCat).sort().map(function (c) {
      var v = byCat[c];
      var pct = Math.round((v.pass / v.total) * 100);
      return '<div style="display:flex;align-items:center;gap:8px;font-size:.76rem;margin-bottom:4px">'
        + '<span style="min-width:90px;color:var(--text-2)">' + escapeHtml(c) + '</span>'
        + '<div style="flex:1;height:7px;background:var(--surface-3);border-radius:4px;overflow:hidden">'
        +   '<div style="height:100%;width:' + pct + '%;background:' + (pct >= 70 ? '#3fa64d' : pct >= 40 ? '#e6a14a' : '#e25563') + '"></div>'
        + '</div>'
        + '<span style="min-width:70px;text-align:right;color:var(--text-3)">' + v.pass + '/' + v.total + ' (' + pct + '%)</span>'
        + '</div>';
    }).join('');
    var rowsHtml = results.map(function (r) {
      return '<div onclick="admin._toggleEvalCaseDetail(' + r.result_id + ')"'
        + ' style="padding:8px 12px;border-bottom:1px solid var(--border-subtle);cursor:pointer">'
        + '<div style="display:flex;gap:10px;align-items:center">'
        +   (r.error ? '<span title="' + escapeHtml(r.error) + '">🟡</span>' : (r.passed ? '<span>✅</span>' : '<span>❌</span>'))
        +   (r.category ? '<span style="font-size:.68rem;padding:1px 7px;border-radius:10px;background:var(--accent-soft-bg);color:var(--accent)">' + escapeHtml(r.category) + '</span>' : '')
        +   '<span style="flex:1;font-size:.76rem;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(r.question_preview || '') + '</span>'
        +   (r.score != null ? '<b style="font-size:.76rem;color:var(--text-1)">' + Number(r.score).toFixed(1) + '/10</b>' : '')
        + '</div>'
        + '<div style="font-size:.72rem;color:var(--text-3);margin-top:2px;padding-left:26px">' + escapeHtml(r.judge_reason || r.error || '') + '</div>'
        + '<div id="ev-case-' + r.result_id + '" style="display:none;margin-top:8px"></div>'
        + '</div>';
    }).join('');
    det.innerHTML =
        '<div style="font-size:.75rem;color:var(--text-3);margin-bottom:6px">run <b>#' + run.run_id + '</b> · '
      +   escapeHtml(run.model) + (run.effort ? '/' + escapeHtml(run.effort) : '')
      +   ' · ' + t('evals.judgedBy', 'ตรวจโดย') + ' ' + escapeHtml(run.judge_model)
      +   ' · ' + ((run.input_tokens || 0) + (run.output_tokens || 0)).toLocaleString() + ' tokens'
      +   (run.error ? ' · <span style="color:#e25563">' + escapeHtml(run.error) + '</span>' : '')
      + '</div>'
      + (catHtml ? '<div style="margin-bottom:10px">' + catHtml + '</div>' : '')
      + '<div style="border:1px solid var(--border-subtle);border-radius:6px;max-height:420px;overflow:auto">' + rowsHtml + '</div>';
    det.style.display = '';
    this._evalResults = {};
    var self = this;
    results.forEach(function (r) { self._evalResults[r.result_id] = r; });
    det.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  // Expand one exam case inline: question / golden reference / fresh answer.
  _toggleEvalCaseDetail: function (resultId) {
    var box = document.getElementById('ev-case-' + resultId);
    var r = (this._evalResults || {})[resultId];
    if (!box || !r) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    var pre = function (label, text) {
      return '<label class="modal-label" style="margin-top:6px">' + escapeHtml(label) + '</label>'
        + '<pre style="margin:0;padding:9px;background:var(--surface-3);border:1px solid var(--border-subtle);border-radius:6px;font-family:\'Geist Mono\',monospace;font-size:.72rem;color:var(--text-2);white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto">'
        + escapeHtml(text || '') + '</pre>';
    };
    var golden = (r.corrected_answer || '').trim() || r.old_answer;
    box.innerHTML =
        pre(t('modal.testHistory.question', 'โจทย์'), r.question)
      + pre(t('evals.golden', 'เฉลย (golden)'), golden)
      + pre(t('evals.freshAnswer', 'คำตอบรอบสอบนี้'), r.answer);
    box.style.display = '';
  },

  openAddSkill: function () {
    document.getElementById('es-title').textContent = t('modal.addSkill.title', '➕ เพิ่ม Skill ใหม่');
    document.getElementById('es-mode').value = 'add';
    document.getElementById('es-id').readOnly = false;
    this._fillSkillModal({});
    showModal('modal-edit-skill');
    var ec = document.getElementById('es-content');
    if (ec && !ec._cc) { ec._cc = true; ec.addEventListener('input', this._updateSkillCharCount); }
    setTimeout(function () { document.getElementById('es-id').focus(); }, 50);
  },

  openEditSkill: function (id) {
    var self = this;
    fetch(BASE + '/api/skills/' + encodeURIComponent(id), { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { flash('❌ ' + t('msg.loadSkillFailedPrefix', 'โหลด skill ไม่สำเร็จ: ') + (d.error || 'unknown'), 'error'); return; }
        document.getElementById('es-title').textContent = t('modal.editSkill.title', '✏️ แก้ไข Skill');
        document.getElementById('es-mode').value = 'edit';
        document.getElementById('es-id').readOnly = true;  // id is the key — fixed on edit
        self._fillSkillModal(d.skill);
        showModal('modal-edit-skill');
        var ec = document.getElementById('es-content');
        if (ec && !ec._cc) { ec._cc = true; ec.addEventListener('input', self._updateSkillCharCount); }
      })
      .catch(function (e) { flash('❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message, 'error'); });
  },

  submitEditSkill: function () {
    var self = this;
    var g = function (id) { return document.getElementById(id); };
    var errEl = g('es-error');
    var payload = {
      id:             (g('es-id').value || '').trim(),
      label:          (g('es-label').value || '').trim(),
      description:    (g('es-desc').value || '').trim(),
      openaiPromptId: (g('es-openai').value || '').trim(),
      content:        g('es-content').value || '',
    };
    if (!payload.id)               { errEl.textContent = t('err.enterSkillId', 'กรุณากรอก Skill ID'); return; }
    if (!payload.content.trim())   { errEl.textContent = t('err.enterContent', 'กรุณากรอก Content (system prompt)'); return; }
    errEl.textContent = '';

    var btn = document.querySelector('#modal-edit-skill .btn-modal-submit');
    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }

    fetch(BASE + '/api/skills', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, Auth.authHeaders()),
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { errEl.textContent = d.error || t('err.saveFailed', 'บันทึกไม่สำเร็จ'); return; }
        hideModal('modal-edit-skill');
        flash(d.created ? '✅ ' + t('msg.skillAdded', 'เพิ่ม skill เรียบร้อย (มีผลทันที)') : '✅ ' + t('msg.skillSaved', 'บันทึก skill เรียบร้อย (มีผลทันที)'));
        self.renderSkills();
      })
      .catch(function (e) { errEl.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; })
      .finally(function () { if (btn) { btn.disabled = false; btn.style.opacity = '1'; } });
  },

  deleteSkillPrompt: function (id) {
    var self = this;
    if (!confirm(tf('confirm.deleteSkill', { id: id }, 'ลบ skill "{id}" ออกจาก registry?\n(ไฟล์บนเครื่องนี้จะถูกแก้ทันที)'))) return;
    fetch(BASE + '/api/skills/' + encodeURIComponent(id), {
      method: 'DELETE', headers: Auth.authHeaders(),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { flash('❌ ' + t('msg.deleteSkillFailedPrefix', 'ลบไม่สำเร็จ: ') + (d.error || 'unknown'), 'error'); return; }
        flash(tf('msg.skillDeleted', { id: id }, '🗑 ลบ skill "{id}" เรียบร้อย'));
        self.renderSkills();
      })
      .catch(function (e) { flash('❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message, 'error'); });
  },
};
