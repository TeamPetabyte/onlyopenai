// skills-lab.js — Skill Prompts + Prompt Lab + verdict + Evals
import { escapeHtml, flash, formatDateStd, hideModal, showModal } from './helpers.js';

export default {
  // --- Skill Prompts: registry view ---
  renderSkills: function () {
    var self = this;
    var statusEl = document.getElementById('skills-status');
    var listEl   = document.getElementById('skills-list');
    if (statusEl) statusEl.innerHTML = '';
    if (listEl)   listEl.innerHTML = '<div class="ad-empty">' + t('common.loading', 'กำลังโหลด...') + '</div>';

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
    var configured = (skills || []).filter(function (s) { return !s.isPlaceholder; }).length;
    var total = (skills || []).length;
    el.innerHTML = status && status.error
      ? '<span class="ad-chip bad"><span class="dot"></span>Load error</span>'
      : '<span class="ad-chip ' + (configured === total ? 'ok' : 'warn') + '"><span class="dot"></span>' + configured + ' / ' + total + ' configured · loaded ' + escapeHtml(loadedAt) + '</span>';
    if (status && status.error) el.title = status.error;
  },

  _renderSkillsList: function (skills) {
    var el = document.getElementById('skills-list');
    if (!el) return;
    if (!skills || skills.length === 0) {
      el.innerHTML = '<div class="ad-empty">' + t('empty.noSkillsYetHtml', 'ยังไม่มี skill ในไฟล์ — แก้ <code>server/config/skill-prompts.json</code> แล้วกด <b>Reload</b>') + '</div>';
      return;
    }
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    var head = '<div class="ad-skill head"><span></span><span>Skill</span><span>' + TT('col.description', 'What it does') + '</span><span>' + TT('col.status', 'Status') + '</span><span></span></div>';
    var rows = skills.map(function (s) {
      var idJs = "'" + String(s.id).replace(/'/g, "\\'") + "'";
      var status = s.isPlaceholder ? '<span class="ad-chip warn">Placeholder</span>' : '<span class="ad-chip ok"><span class="dot"></span>Configured</span>';
      return '<div class="ad-skill"' + (s.isPlaceholder ? ' style="opacity:.7"' : '') + '>'
        + '<span class="ad-skill-icn"><svg class="ic sm"><use href="#i-sparkle"/></svg></span>'
        + '<div><b>' + escapeHtml(s.label) + '</b><span class="sid">' + escapeHtml(s.id) + (s.openaiPromptId ? ' · ' + escapeHtml(s.openaiPromptId) : '') + ' · ' + (s.contentLength || 0).toLocaleString() + ' chars</span></div>'
        + '<div class="desc">' + escapeHtml(s.description || '—') + '</div>'
        + '<div>' + status + '</div>'
        + '<div class="ad-acts show" style="justify-content:flex-end">'
        +   '<button class="ad-btn icon sm ghost" title="' + escapeHtml(TT('btn.edit', 'แก้ไข')) + '" onclick="admin.openEditSkill(' + idJs + ')"><svg class="ic sm"><use href="#i-pencil"/></svg></button>'
        +   '<button class="ad-btn icon sm ghost danger" title="' + escapeHtml(TT('btn.deletePlain', 'ลบ')) + '" onclick="admin.deleteSkillPrompt(' + idJs + ')"><svg class="ic sm"><use href="#i-trash"/></svg></button>'
        + '</div>'
        + '</div>';
    }).join('');
    el.innerHTML = head + rows;
  },

  reloadSkills: function () {
    var self = this;
    fetch(BASE + '/api/skills/reload', {
      method: 'POST', headers: Auth.authHeaders(),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { flash(t('msg.reloadFailedPrefix', 'Reload failed: ') + (d.error || 'unknown'), 'error', 'success'); return; }
        if (d.status && d.status.error) {
          flash(t('msg.reloadedWithErrorPrefix', 'Reloaded แต่มี error: ') + d.status.error, 'error', 'success');
        } else {
          flash(tf('msg.reloadSuccess', { count: (d.status && d.status.count) || 0 }, 'Reload เรียบร้อย · {count} skills'), 'success', 'success');
        }
        self.renderSkills();
      })
      .catch(function (e) { flash(t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message, 'error'); });
  },

  // add / edit / delete skill prompts from the UI
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

  // --- Prompt Lab: test a prompt without touching the budget gate or real chat history ---

  // Entry point from the Skill Prompts cards: opens the lab on that skill,
  // additionally scrolls down to the history block.
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
        // Auto is the default: the chat router picks the prompt.
        var want = self._labSkillId || 'auto';
        el.innerHTML = '<option value="auto">' + escapeHtml(t('lab.autoSkill', 'Auto — AI เลือก prompt เอง')) + '</option>'
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

  // One-click fresh test: clears question, answer, meta and the approval bar.
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

  // Effort only applies to the reasoning families (gpt-5.6, gpt-6) — hide it otherwise.
  onLabModelChange: function (v) {
    var f = document.getElementById('lab-effort-field');
    if (f) f.style.display = /^gpt-(5\.6|6)/.test(v || '') ? '' : 'none';
  },

  // Show which system prompt is being tested (full content + length).
  _loadLabPrompt: function () {
    var id = this._labSkillId;
    if (!id) return;
    // auto mode has no fixed prompt to preview.
    if (id === 'auto') {
      var sum = document.getElementById('lab-prompt-summary');
      var pre = document.getElementById('lab-prompt-preview');
      if (sum) sum.textContent = t('lab.autoSummary', 'Auto — AI เลือก prompt จากคำถามอัตโนมัติ');
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
        if (sum) sum.textContent = t('lab.promptSummary', 'System prompt ที่ใช้ทดสอบ')
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
    if (btn) { btn.disabled = true; btn.style.opacity = '.6'; btn.querySelector('span').textContent = t('common.running', 'กำลังรัน...'); }
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
          + (d.routed ? ' · ' + (d.routed.label || d.routed.skillId || '') : '');   // which prompt Auto matched
        self.showVerdictBar('lab', d.logId || null);
        // The run itself created a (pending) history row — refresh the list.
        self.loadTestHistory(true);
      })
      .catch(function (e) { errEl.textContent = t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message; })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.querySelector('span').textContent = t('btn.run', 'Run'); }
      });
  },

  // แนบไฟล์ Z-program: 1MB/ไฟล์ + รวม 1.5MB (express.json รับ 2MB) — append เข้า textarea
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

  // --- Verdict: one renderer shared by the lab and the history detail; element ids carry the prefix ---

  _verdictLogIds: {},   // prefix → log_id currently being judged
  _verdictPick:   {},   // prefix → selected verdict value

  _VERDICTS: [
    { v: 'correct',   cls: 'ok',   key: 'modal.testSkill.vCorrect',   fb: 'ถูกต้อง' },
    { v: 'partial',   cls: 'warn', key: 'modal.testSkill.vPartial',   fb: 'เกือบถูก' },
    { v: 'incorrect', cls: 'bad',  key: 'modal.testSkill.vIncorrect', fb: 'ผิด' },
  ],

  // Render the judgement bar into #<prefix>-verdict; `existing` (a full log record) prefills a past verdict.
  showVerdictBar: function (prefix, logId, existing) {
    var box = document.getElementById(prefix + '-verdict');
    if (!box) return;
    if (!logId) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var TT = function (k, f) { return (typeof I18N !== 'undefined') ? I18N.t(k, f) : f; };
    this._verdictLogIds[prefix] = logId;
    this._verdictPick[prefix]   = null;
    var btns = this._VERDICTS.map(function (d) {
      return '<button type="button" class="ad-btn sm ' + d.cls + '" id="' + prefix + '-v-' + d.v + '" aria-pressed="false" onclick="admin.pickVerdict(\'' + prefix + '\',\'' + d.v + '\')">' + escapeHtml(TT(d.key, d.fb)) + '</button>';
    }).join('');
    box.innerHTML =
        '<div class="ad-verdict">'
      +   '<span style="font-weight:600;margin-right:4px">' + escapeHtml(TT('modal.testSkill.verdictLabel', 'Verdict')) + '</span>' + btns
      +   '<input class="ad-input ad-grow" id="' + prefix + '-vnote" style="height:28px;min-width:200px;font-size:12.5px" placeholder="' + escapeHtml(TT('modal.testSkill.noteLabel', 'Note (optional)')) + '" />'
      +   '<input class="ad-input" id="' + prefix + '-category" style="height:28px;width:110px;font-size:12.5px" placeholder="' + escapeHtml(TT('modal.testSkill.categoryLabel', 'FI / MM / SD')) + '" />'
      +   '<span id="' + prefix + '-verdict-msg" style="font-size:12px;color:var(--success)"></span>'
      +   '<button type="button" class="ad-btn sm primary" id="' + prefix + '-verdict-save" onclick="admin.saveVerdict(\'' + prefix + '\')">' + escapeHtml(TT('modal.testSkill.saveVerdict', 'Save verdict')) + '</button>'
      + '</div>'
      + '<div id="' + prefix + '-corrected-wrap" style="display:none;padding:12px 16px;border-top:1px solid var(--border-default)">'
      +   '<div class="ad-field"><label>' + escapeHtml(TT('modal.testSkill.correctedLabel', 'เฉลยที่ถูกต้อง')) + '</label>'
      +   '<textarea class="ad-input" id="' + prefix + '-corrected" rows="4" style="min-height:100px" placeholder="' + escapeHtml(TT('modal.testSkill.correctedPh', 'วางคำตอบที่ถูกต้อง — จะกลายเป็นเฉลยใน golden dataset')) + '"></textarea></div>'
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
      if (b) b.setAttribute('aria-pressed', String(d.v === v));
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
        if (msg) { msg.style.color = 'var(--success)'; msg.textContent = t('modal.testSkill.verdictSaved', 'บันทึกแล้ว'); }
        // refresh list ให้ badge/สถิติตรงกับ verdict ที่เพิ่งบันทึก
        if (prefix === 'lab' || prefix === 'lh') self.loadTestHistory(true);
      })
      .catch(function (e) { if (msg) { msg.style.color = '#e25563'; msg.textContent = e.message; } })
      .finally(function () { if (btn) { btn.disabled = false; btn.style.opacity = '1'; } });
  },

  // keepDetail=true keeps the open detail pane (after saving a verdict from it).
  loadTestHistory: function (keepDetail) {
    var self    = this;
    // history เป็น GLOBAL ทุก skill
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

  _verdictDot: function (v) {
    var cls = v === 'correct' ? 'ok' : v === 'partial' ? 'mid' : v === 'incorrect' ? 'bad' : '';
    return '<span class="ad-vdot ' + cls + '"></span>';
  },
  _verdictChip: function (r) {
    if (r.verdict === 'correct') return '<span class="ad-chip ok">' + t('modal.testSkill.vCorrect', 'ถูกต้อง') + (r.is_eval_case ? ' · ' + t('evals.inSetShort', 'in eval set') : '') + '</span>';
    if (r.verdict === 'partial') return '<span class="ad-chip warn">' + t('modal.testSkill.vPartial', 'เกือบถูก') + '</span>';
    if (r.verdict === 'incorrect') return '<span class="ad-chip bad">' + t('modal.testSkill.vIncorrect', 'ผิด') + '</span>';
    return '<span class="ad-chip warn">' + t('lbl.pending', 'Pending') + '</span>';
  },

  _renderTestHistory: function (rows, stats) {
    var listEl  = document.getElementById('lab-list');
    var statsEl = document.getElementById('lab-stats');
    if (statsEl) statsEl.textContent = (stats.pending || 0) + ' ' + t('lab.waitingVerdict', 'waiting for a verdict') + ' · ' + (stats.eval_cases || 0) + ' ' + t('evals.inSetShort', 'in eval set') + ' · ' + (stats.total || 0) + ' ' + t('lbl.total', 'total');
    if (!listEl) return;
    if (!rows.length) { listEl.innerHTML = '<div class="ad-empty">' + t('modal.testHistory.empty', 'ยังไม่มีการทดสอบ') + '</div>'; return; }
    var self = this;
    listEl.innerHTML = rows.map(function (r) {
      var dt = new Date(r.created_at);
      var when = dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return '<div class="ad-hist" onclick="admin.openTestLogDetail(' + r.log_id + ')">' + self._verdictDot(r.verdict)
        + '<div class="q">' + escapeHtml(r.question_preview || '') + '<span>' + escapeHtml(r.model || '') + ' · ' + when + (r.skill_label ? ' · ' + escapeHtml(r.skill_label) : '') + (r.category ? ' · ' + escapeHtml(r.category) : '') + '</span></div>'
        + self._verdictChip(r) + '</div>';
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
    var pre = function (label, text) { return '<div class="ad-field" style="margin-top:8px"><label>' + escapeHtml(label) + '</label><pre class="ad-pre">' + escapeHtml(text || '') + '</pre></div>'; };
    var canStar = log.verdict === 'correct' || (log.corrected_answer || '').trim();
    var starBtn = log.verdict
      ? '<button type="button" class="ad-btn sm' + (log.is_eval_case ? ' primary' : '') + '" onclick="admin.toggleEvalCase(' + log.log_id + ',' + (!log.is_eval_case) + ')"'
        + (canStar ? '' : ' disabled title="' + escapeHtml(t('evals.needGolden', 'ต้องมีเฉลย หรืออนุมัติ = ถูกต้อง ก่อน')) + '"') + '>'
        + (log.is_eval_case ? escapeHtml(t('evals.inSet', 'In eval set — click to remove')) : escapeHtml(t('evals.addToSet', 'Add to eval set'))) + '</button>'
      : '';
    det.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">'
      +   '<span class="ad-mono" style="font-size:12px;color:var(--text-3)">#' + log.log_id + (log.skill_label ? ' · ' + escapeHtml(log.skill_label) : '') + ' · ' + escapeHtml(log.model || '') + (log.effort ? ' / ' + escapeHtml(log.effort) : '') + ' · ' + ((log.input_tokens || 0) + (log.output_tokens || 0)).toLocaleString() + ' tokens</span>'
      +   starBtn
      + '</div>'
      + pre(t('modal.testHistory.question', 'โจทย์'), log.question)
      + pre(t('modal.testSkill.answerLabel', 'คำตอบ AI'), log.answer)
      + '<div id="lh-verdict" style="display:none;margin-top:10px;border:1px solid var(--border-default);border-radius:var(--radius-md);overflow:hidden"></div>';
    det.style.display = '';
    this.showVerdictBar('lh', log.log_id, log);
    det.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  // toggle: backend validates, then re-render the detail and the list.
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

  // --- Evals: exam runner + score report ---

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
    // ready-count for the selected skill (from the test-log stats).
    fetch(BASE + '/api/skill-test-logs?skill=' + encodeURIComponent(this._evalSkillId) + '&limit=1',
      { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var s = document.getElementById('ev-ready');
        if (!s) return;
        var n = (d.ok && d.stats && d.stats.eval_cases) || 0;
        s.textContent = n + ' ' + t('evals.readyCount', 'cases in the set') + ' · ' + t('evals.judgeInfo', 'judge: GPT-5.6 Terra / high');
        var btn = document.getElementById('ev-run-btn');
        if (btn) btn.disabled = n === 0;
      })
      .catch(function () {});
    this.loadEvalRuns();
  },

  onEvalModelChange: function (v) {
    var f = document.getElementById('ev-effort-field');
    if (f) f.style.display = /^gpt-(5\.6|6)/.test(v || '') ? '' : 'none';
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

  // Poll the active run every 2.5s until it leaves 'running'.
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
        if (txt) txt.textContent = run.done_cases + ' / ' + run.total_cases + ' · ' + run.pass_cases + ' ' + t('evals.passed', 'passed');
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
    // Keep polling: the run flips to 'cancelled' after the current case and the poller closes the UI.
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
    var delta = prev != null && prev.score_pct != null ? (Number(cur.score_pct) - Number(prev.score_pct)) : null;
    card.innerHTML = '<div class="ad-att ' + (delta === null ? 'info' : delta >= 0 ? 'ok' : 'warn') + '"><div class="icn"><svg class="ic"><use href="#i-chart"/></svg></div><div>'
      + '<b>' + escapeHtml(t('evals.latestScore', 'Latest score')) + ' ' + Number(cur.score_pct).toFixed(1) + '%'
      + (delta === null ? '' : ' <span style="color:' + (delta >= 0 ? 'var(--success)' : 'var(--danger)') + '">' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + ' ' + t('evals.vsPrevious', 'vs previous run') + '</span>') + '</b>'
      + '<p>run #' + cur.run_id + ' · ' + escapeHtml(cur.model) + (cur.effort ? '/' + escapeHtml(cur.effort) : '') + ' · ' + cur.pass_cases + ' / ' + cur.total_cases + ' ' + escapeHtml(t('evals.casesPassed', 'cases passed'))
      + ' · ' + escapeHtml(t('evals.trend', 'trend')) + ' ' + done.slice(0, 6).reverse().map(function (r) { return Number(r.score_pct).toFixed(0) + '%'; }).join(' → ') + '</p>'
      + '</div></div>';
    card.style.display = '';
  },

  _renderEvalRuns: function (runs) {
    var el = document.getElementById('ev-runs');
    if (!el) return;
    if (!runs.length) { el.innerHTML = '<div class="ad-card ad-empty" style="grid-column:1/-1">' + t('evals.noRuns', 'ยังไม่เคยสอบ skill นี้ — กด Run Eval เพื่อเริ่มรอบแรก') + '</div>'; return; }
    var best = runs.filter(function (r) { return r.status === 'done' && r.score_pct != null; }).sort(function (a, b) { return Number(b.score_pct) - Number(a.score_pct); })[0];
    var chip = function (s) {
      if (s === 'done') return ''; if (s === 'running') return '<span class="ad-chip accent">running…</span>';
      if (s === 'cancelled') return '<span class="ad-chip warn">cancelled</span>'; return '<span class="ad-chip bad">failed</span>';
    };
    el.innerHTML = runs.slice(0, 9).map(function (r) {
      var dt = new Date(r.started_at);
      var when = dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      var isBest = best && r.run_id === best.run_id;
      var pass = Number(r.pass_cases) || 0, total = Number(r.total_cases) || 0, fail = Math.max(0, total - pass);
      var cells = ''; for (var i = 0; i < Math.min(total, 60); i++) cells += '<i class="' + (i < pass ? '' : 'f') + '"></i>';
      return '<div class="ad-run' + (isBest ? ' best' : '') + '" onclick="admin.openEvalRunDetail(' + r.run_id + ')">'
        + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + (isBest ? '<span class="ad-chip accent">Best</span>' : '') + '<span class="ad-chip">#' + r.run_id + ' · ' + escapeHtml(r.model) + (r.effort ? ' · ' + escapeHtml(r.effort) : '') + '</span>' + chip(r.status) + '</div>'
        + '<div class="score">' + (r.score_pct != null ? Number(r.score_pct).toFixed(1) + '%' : '—') + ' <small>' + pass + ' / ' + total + '</small></div>'
        + '<div class="ad-cases">' + cells + '</div>'
        + '<div class="ad-kv"><span>' + when + ' · ' + ((r.input_tokens || 0) + (r.output_tokens || 0)).toLocaleString() + ' tokens</span><b>' + fail + ' ' + t('evals.failed', 'failed') + '</b></div>'
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
    var byCat = {};
    results.forEach(function (r) { var c = r.category || '—'; byCat[c] = byCat[c] || { total: 0, pass: 0 }; byCat[c].total++; if (r.passed) byCat[c].pass++; });
    var catHtml = Object.keys(byCat).sort().map(function (c) {
      var v = byCat[c]; var pct = Math.round((v.pass / v.total) * 100);
      return '<div class="ad-cap" style="min-width:0"><span style="min-width:70px;font-size:12.5px">' + escapeHtml(c) + '</span><div class="ad-bar ' + (pct >= 70 ? 'ok' : pct >= 40 ? 'warn' : 'bad') + '"><i style="width:' + pct + '%"></i></div><span class="t">' + v.pass + '/' + v.total + '</span></div>';
    }).join('');
    var failed = results.filter(function (r) { return !r.passed; });
    var rowsHtml = (failed.length ? failed : results).map(function (r) {
      var mark = r.error ? '<span class="ad-chip warn">error</span>' : (r.passed ? '<span class="ad-chip ok">pass</span>' : '<span class="ad-chip bad">fail</span>');
      return '<tr class="click" onclick="admin._toggleEvalCaseDetail(' + r.result_id + ')">'
        + '<td>' + mark + '</td>'
        + '<td>' + (r.category ? '<span class="ad-chip">' + escapeHtml(r.category) + '</span> ' : '') + escapeHtml(r.question_preview || '') + '</td>'
        + '<td class="muted">' + escapeHtml(r.judge_reason || r.error || '') + '</td>'
        + '<td class="num"' + (r.passed ? '' : ' style="color:var(--danger)"') + '>' + (r.score != null ? Number(r.score).toFixed(1) + ' / 10' : '—') + '</td></tr>'
        + '<tr id="ev-case-' + r.result_id + '" style="display:none"><td colspan="4" style="background:var(--surface-3)"></td></tr>';
    }).join('');
    det.innerHTML =
        '<div class="ad-card-head"><h4>' + (failed.length ? failed.length + ' ' + t('evals.failedCases', 'failed cases') : t('evals.allPassed', 'All cases passed')) + ' · run #' + run.run_id + '</h4>'
      +   '<span class="ad-sub">' + escapeHtml(run.model) + (run.effort ? '/' + escapeHtml(run.effort) : '') + ' · ' + t('evals.judgedBy', 'judged by') + ' ' + escapeHtml(run.judge_model || '') + ' · ' + ((run.input_tokens || 0) + (run.output_tokens || 0)).toLocaleString() + ' tokens' + (run.error ? ' · <span style="color:var(--danger)">' + escapeHtml(run.error) + '</span>' : '') + '</span></div>'
      + (catHtml ? '<div class="ad-card-body ad-stack" style="gap:6px">' + catHtml + '</div>' : '')
      + '<table class="ad-table"><thead><tr><th></th><th>' + t('col.case', 'Case') + '</th><th>' + t('evals.judgeSaid', 'Judge said') + '</th><th class="num">' + t('col.score', 'Score') + '</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>';
    det.style.display = '';
    this._evalResults = {};
    var self = this;
    results.forEach(function (r) { self._evalResults[r.result_id] = r; });
    det.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  // Expand one exam case inline: question / golden reference / fresh answer.
  _toggleEvalCaseDetail: function (resultId) {
    var row = document.getElementById('ev-case-' + resultId);
    var r = (this._evalResults || {})[resultId];
    if (!row || !r) return;
    if (row.style.display !== 'none') { row.style.display = 'none'; return; }
    var pre = function (label, text) { return '<div class="ad-field"><label>' + escapeHtml(label) + '</label><pre class="ad-pre">' + escapeHtml(text || '') + '</pre></div>'; };
    var golden = (r.corrected_answer || '').trim() || r.old_answer;
    row.firstElementChild.innerHTML = '<div class="ad-form-grid" style="grid-template-columns:1fr 1fr 1fr;padding:12px 0">' + pre(t('modal.testHistory.question', 'โจทย์'), r.question) + pre(t('evals.golden', 'เฉลย (golden)'), golden) + pre(t('evals.freshAnswer', 'คำตอบรอบสอบนี้'), r.answer) + '</div>';
    row.style.display = '';
  },

  openAddSkill: function () {
    document.getElementById('es-title').textContent = t('modal.addSkill.title', 'เพิ่ม Skill ใหม่');
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
        if (!d.ok) { flash(t('msg.loadSkillFailedPrefix', 'โหลด skill ไม่สำเร็จ: ') + (d.error || 'unknown'), 'error', 'success'); return; }
        document.getElementById('es-title').textContent = t('modal.editSkill.title', 'แก้ไข Skill');
        document.getElementById('es-mode').value = 'edit';
        document.getElementById('es-id').readOnly = true;  // id is the key — fixed on edit
        self._fillSkillModal(d.skill);
        showModal('modal-edit-skill');
        var ec = document.getElementById('es-content');
        if (ec && !ec._cc) { ec._cc = true; ec.addEventListener('input', self._updateSkillCharCount); }
      })
      .catch(function (e) { flash(t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message, 'error'); });
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
        flash(d.created ? t('msg.skillAdded', 'เพิ่ม skill เรียบร้อย (มีผลทันที)') : t('msg.skillSaved', 'บันทึก skill เรียบร้อย (มีผลทันที)'), 'success');
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
        if (!d.ok) { flash(t('msg.deleteSkillFailedPrefix', 'ลบไม่สำเร็จ: ') + (d.error || 'unknown'), 'error', 'success'); return; }
        flash(tf('msg.skillDeleted', { id: id }, 'ลบ skill "{id}" เรียบร้อย'), 'success');
        self.renderSkills();
      })
      .catch(function (e) { flash(t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message, 'error'); });
  },
};
