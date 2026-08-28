// sync.js — หน้า Sync Status
import { escapeHtml, flash, formatDateStd, hideModal, showModal } from './helpers.js';

export default {
  // ── SYNC STATUS ── /api/sync-status → health header + ตารางต่อ project
  renderSync: function () {
    var self = this;
    var healthEl = document.getElementById('sync-health');
    var projEl   = document.getElementById('sync-projects');
    if (healthEl) healthEl.innerHTML =
      '<div style="padding:24px;text-align:center;color:var(--text-3)">' + t('common.loading', '⏳ กำลังโหลด...') + '</div>';
    if (projEl)   projEl.innerHTML = '';

    fetch(BASE + '/api/sync-status', { headers: Auth.authHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          healthEl.innerHTML = '<div style="padding:24px;color:#e25563">' +
            '⚠ ' + escapeHtml(d.error || 'failed to load') + '</div>';
          return;
        }
        self._renderSyncHealth(d);
        self._renderSyncProjects(d.projects || []);
      })
      .catch(function (e) {
        healthEl.innerHTML = '<div style="padding:24px;color:#e25563">⚠ ' + escapeHtml(e.message) + '</div>';
      });
  },

  _renderSyncHealth: function (d) {
    var el = document.getElementById('sync-health');
    if (!el) return;
    var s = d.state || {};
    var statusKey = d.running ? 'running' : (s.last_status || 'idle');
    // Status pill colour
    var colors = {
      running:  { bg: 'rgba(74,123,214,0.10)',  bd: 'rgba(74,123,214,0.35)',  fg: '#5a8def', label: '🔄 Running' },
      ok:       { bg: 'rgba(55,179,74,0.10)',    bd: 'rgba(55,179,74,0.35)',   fg: '#3fa64d', label: '🟢 OK' },
      partial:  { bg: 'rgba(240,160,64,0.10)',   bd: 'rgba(240,160,64,0.35)',  fg: '#e6a14a', label: '🟡 Partial' },
      error:    { bg: 'rgba(220,53,69,0.10)',    bd: 'rgba(220,53,69,0.35)',   fg: '#e25563', label: '🔴 Error' },
      idle:     { bg: 'var(--surface-3)',        bd: 'var(--border-default)', fg: 'var(--text-3)', label: '⚪ Not run yet' },
    };
    var c = colors[statusKey] || colors.idle;

    var lastRun = s.last_run_at ? formatDateStd(s.last_run_at) : '—';
    var nextEta = '—';
    if (s.last_run_at && d.intervalMin) {
      var next = new Date(new Date(s.last_run_at).getTime() + d.intervalMin * 60_000);
      var diffMin = Math.max(0, Math.floor((next - Date.now()) / 60_000));
      nextEta = diffMin <= 0 ? 'overdue' : '~' + diffMin + ' min';
    }

    var blocks = [
      { label: 'Status',            value:
        '<span style="display:inline-block;padding:4px 12px;border-radius:20px;'
        + 'background:' + c.bg + ';color:' + c.fg + ';border:1px solid ' + c.bd + ';'
        + 'font-size:.82rem;font-weight:600">' + c.label + '</span>' },
      { label: 'Last Run',          value: '<span style="font-family:Geist Mono,monospace;color:var(--text-1)">' + lastRun + '</span>' },
      { label: 'Next Run',          value: '<span style="font-family:Geist Mono,monospace;color:var(--text-2)">' + nextEta + '</span>' },
      { label: 'Interval',          value: '<span style="color:var(--text-2)">' + (d.intervalMin || '?') + ' min</span>' },
      { label: 'Last Duration',     value: '<span style="font-family:Geist Mono,monospace;color:var(--text-2)">' + (s.last_duration_ms != null ? s.last_duration_ms + ' ms' : '—') + '</span>' },
      { label: 'Rows This Run',     value: '<span style="font-family:Geist Mono,monospace;color:var(--text-2)">' + (s.last_rows_inserted || 0) + '</span>' },
      { label: 'Rows Total',        value: '<span style="font-family:Geist Mono,monospace;color:var(--text-2)">' + (s.rows_synced_total || 0).toLocaleString() + '</span>' },
      { label: 'Admin Key',         value: d.adminKeyConfigured ? '<span style="color:#3fa64d">✓ configured</span>' : '<span style="color:#e25563">✗ missing</span>' },
    ];

    el.innerHTML =
        '<h3 class="card-title" style="margin-bottom:14px">Sync Health</h3>'
      + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px">'
      +   blocks.map(function (b) {
            return '<div style="padding:10px 14px;background:var(--surface-3);'
              + 'border:1px solid var(--border-subtle);border-radius:8px">'
              + '<div style="font-size:.66rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">' + b.label + '</div>'
              + '<div style="font-size:.92rem;font-weight:600">' + b.value + '</div>'
              + '</div>';
          }).join('')
      + '</div>'
      + (s.last_error
          ? '<div style="margin-top:14px;padding:12px 14px;background:rgba(220,53,69,0.06);border:1px solid rgba(220,53,69,0.30);border-radius:8px;color:#e25563;font-size:.82rem;font-family:Geist Mono,monospace">'
            + '<b>Error:</b> ' + escapeHtml(s.last_error) + '</div>'
          : '');
  },

  _renderSyncProjects: function (rows) {
    var el = document.getElementById('sync-projects');
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-3);font-size:.85rem">' + t('empty.noProjectsSystem', 'ยังไม่มี project ในระบบ') + '</div>';
      return;
    }
    var headerStrip =
        '<div style="display:grid;grid-template-columns:1.5fr 1.3fr 1.2fr 1fr;'
      + 'gap:14px;padding:10px 16px;font-size:.66rem;color:var(--text-3);'
      + 'text-transform:uppercase;letter-spacing:.05em;font-weight:700;'
      + 'border-bottom:1px solid var(--border-subtle)">'
      +   '<div>Project</div>'
      +   '<div>Last Synced</div>'
      +   '<div style="text-align:right">Tokens (7d)</div>'
      +   '<div style="text-align:right">Cached %</div>'
      + '</div>';

    var body = rows.map(function (r, idx) {
      var tokens = Number(r.tokens_7d || 0);
      var cached = Number(r.cached_7d || 0);
      var cachedPct = tokens > 0 ? ((cached / tokens) * 100).toFixed(1) + '%' : '—';
      var synced = r.openai_synced_at
        ? formatDateStd(r.openai_synced_at)
        : '<span style="color:var(--text-3);font-style:italic">never</span>';
      var pidPill = r.openai_project_id
        ? '<span style="font-family:Geist Mono,monospace;font-size:.7rem;padding:2px 7px;'
          + 'background:var(--accent-soft-bg);color:var(--accent);'
          + 'border:1px solid var(--accent-soft-border);border-radius:5px;margin-left:8px">'
          + escapeHtml(r.openai_project_id.slice(0, 16) + '…') + '</span>'
        : '';
      return '<div style="display:grid;grid-template-columns:1.5fr 1.3fr 1.2fr 1fr;'
        + 'gap:14px;align-items:center;padding:12px 16px;'
        + (idx > 0 ? 'border-top:1px solid var(--border-subtle);' : '') + '">'
        + '<div>'
        +   '<div style="font-weight:600;color:var(--text-1);font-size:.88rem">'
        +     '📂 ' + escapeHtml(r.project_name || '—') + pidPill + '</div>'
        + '</div>'
        + '<div style="font-size:.82rem;color:var(--text-2);font-family:Geist Mono,monospace">' + synced + '</div>'
        + '<div style="text-align:right;font-family:Geist Mono,monospace;color:var(--text-1);font-weight:600">' + tokens.toLocaleString() + '</div>'
        + '<div style="text-align:right;font-family:Geist Mono,monospace;color:' + (cached > 0 ? '#3fa64d' : 'var(--text-3)') + ';font-weight:600">' + cachedPct + '</div>'
        + '</div>';
    }).join('');

    el.innerHTML = '<div style="background:var(--surface-2);border:1px solid var(--border-default);'
      + 'border-radius:10px;overflow:hidden">' + headerStrip + body + '</div>';
  },

  // in-app modal replaces window.confirm() — keeps look & feel
  // consistent across destructive/long-running operations.
  syncNow: function () {
    var err = document.getElementById('sn-error');
    if (err) err.textContent = '';
    var btn = document.getElementById('sn-confirm-btn');
    if (btn) { btn.disabled = false; btn.textContent = t('m.syncNow.btn', 'เริ่ม sync'); }
    showModal('modal-confirm-sync-now');
  },
  cancelSyncNow: function () { hideModal('modal-confirm-sync-now'); },
  confirmSyncNow: function () {
    var self = this;
    var err = document.getElementById('sn-error');
    var btn = document.getElementById('sn-confirm-btn');
    if (btn) { btn.disabled = true; btn.textContent = t('btn.syncingEllipsis', 'กำลัง sync...'); }
    if (err) err.textContent = '';
    var healthEl = document.getElementById('sync-health');
    if (healthEl) healthEl.innerHTML =
      '<div style="padding:24px;text-align:center;color:var(--text-3)">⚡ ' + t('btn.syncingEllipsis', 'กำลัง sync...') + '</div>';
    fetch(BASE + '/api/sync-now', {
      method: 'POST', headers: Auth.authHeaders(),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        hideModal('modal-confirm-sync-now');
        if (!d.ok) { flash('❌ ' + t('msg.syncFailedPrefix', 'Sync failed: ') + (d.error || 'unknown'), 'error'); }
        else if (d.skipped) { flash('⏭ ' + d.reason); }
        else {
          flash('✅ ' + tf('msg.syncDone', { rows: d.rowsInserted || 0, ms: d.durationMs || 0 }, 'Sync เสร็จ · {rows} rows · {ms} ms'));
        }
        self.renderSync();
      })
      .catch(function (e) {
        if (err) err.textContent = '❌ ' + t('err.networkError', 'เครือข่ายขัดข้อง: ') + e.message;
        if (btn) { btn.disabled = false; btn.textContent = t('m.syncNow.btn', 'เริ่ม sync'); }
        self.renderSync();
      });
  },
};
