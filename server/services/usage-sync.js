// usage-sync.js — ดึง usage/cost จาก OpenAI admin API เข้าตารางฝั่งเรา ตามรอบเวลา

module.exports = function createUsageSync(ctx) {
const { pool, openaiAdmin, logger } = ctx;
// ── Phase 11 B4: /api/cost-by-day ───────────────────────────
// Day-level spend aggregate over tbl_response × tbl_project rates.
// Complements the per-user dashboard (renderUsage) — ops wants
// a date-range rollup for budgeting / invoicing.
//   ?days=30   window size (default 30, max 365)
//   ?userId=N  filter to one user (optional)
// Returns one row per day within the window (zero-fills gaps so a
// chart can render without holes).
// ══════════════════════════════════════════════════════════
//  OpenAI Usage Sync (Phase 17.3)
// ══════════════════════════════════════════════════════════
//
// Background job that pulls aggregated usage from OpenAI's Admin API every
// OPENAI_USAGE_SYNC_INTERVAL_MIN minutes and writes it into tbl_daily_token.
// Provides two HTTP endpoints:
//   GET  /api/sync-status   read current sync health + per-project drift
//   POST /api/sync-now      manually trigger one sync run (admin convenience)
//
// Design notes
// ────────────
//   * Date bucket: OpenAI returns UTC unix timestamps. We convert each
//     bucket's start_time to Asia/Bangkok local date (UTC+7) to match the
//     `usage_date_th` column semantics.
//   * UPSERT on (usage_date_th, project_id, model) — the table's new PK
//     after phase17-002. Re-running sync is safe.
//   * Skip rows where project_id from OpenAI is NULL (org-level usage with
//     no project tag — usually internal calls) or doesn't match any active
//     row in tbl_project (orphaned data from deleted projects).
//   * Status is tracked in tbl_sync_state (singleton row id=1). Two
//     dashboards reference it: the sync-status endpoint and an admin-only
//     "Sync Status" UI panel.
const BKK_OFFSET_SEC = 7 * 3600;

function _bkkDate(utcUnix) {
    // Convert UTC unix → Bangkok local "YYYY-MM-DD".
    const d = new Date((utcUnix + BKK_OFFSET_SEC) * 1000);
    return d.toISOString().slice(0, 10);   // already in Bangkok-aligned components
}

let _syncRunning = false;       // simple lock — only one run at a time
let _syncTimer   = null;

async function runUsageSync(reason = 'scheduled') {
    if (_syncRunning) {
        return { skipped: true, reason: 'previous run still in progress' };
    }
    if (!openaiAdmin.isEnabled()) {
        return { skipped: true, reason: 'OPENAI_ADMIN_KEY not configured' };
    }
    _syncRunning = true;
    const startedAt = Date.now();
    let rowsInserted = 0;
    let status = 'ok';
    let errorMsg = null;

    // Optimistic state update — show "running" in UI immediately.
    try {
        await pool.query(
            `UPDATE tbl_sync_state SET last_status='running', updated_at=NOW() WHERE id=1`);
    } catch (_) { /* not fatal */ }

    try {
        // Re-read the trailing 3 days every run — late buckets from "today"
        // can take 5-30 min to land. Idempotent UPSERT covers the overlap.
        const endTime   = Math.floor(Date.now() / 1000);
        const startTime = endTime - 3 * 86400;
        const buckets = await openaiAdmin.fetchUsageCompletions({ startTime, endTime });

        // Pre-fetch active project ids so we can filter out orphaned data.
        const projRows = await pool.query(
            `SELECT project_id FROM tbl_project WHERE is_deleted = FALSE`);
        const activeProj = new Set(projRows.rows.map(r => r.project_id));

        for (const b of buckets) {
            const bktStart = Number(b.start_time);
            const bktEnd   = Number(b.end_time);
            if (!Number.isFinite(bktStart) || !Number.isFinite(bktEnd)) continue;
            const dateStr = _bkkDate(bktStart);

            const results = Array.isArray(b.results) ? b.results : [];
            for (const r of results) {
                const projectId = r.project_id;
                const model     = r.model || 'unknown';
                if (!projectId) continue;                         // skip null project
                if (!activeProj.has(projectId)) continue;         // skip orphans

                // OpenAI uses snake_case fields; pull defensively (fields may be missing).
                const num = k => Number(r[k] || 0);
                await pool.query(`
                    INSERT INTO tbl_daily_token (
                        usage_date_th, project_id,
                        start_time_th, end_time_th, start_time_utc, end_time_utc,
                        model,
                        input_tokens, output_tokens,
                        input_cached_tokens, input_uncached_tokens,
                        input_text_tokens, output_text_tokens, input_cached_text_tokens,
                        input_audio_tokens, input_cached_audio_tokens, output_audio_tokens,
                        input_image_tokens, output_image_tokens
                    ) VALUES (
                        $1, $2,
                        $3, $4, $5, $6,
                        $7,
                        $8, $9,
                        $10, $11,
                        $12, $13, $14,
                        $15, $16, $17,
                        $18, $19
                    )
                    ON CONFLICT (usage_date_th, project_id, model) DO UPDATE SET
                        start_time_th = EXCLUDED.start_time_th,
                        end_time_th   = EXCLUDED.end_time_th,
                        start_time_utc= EXCLUDED.start_time_utc,
                        end_time_utc  = EXCLUDED.end_time_utc,
                        input_tokens  = EXCLUDED.input_tokens,
                        output_tokens = EXCLUDED.output_tokens,
                        input_cached_tokens   = EXCLUDED.input_cached_tokens,
                        input_uncached_tokens = EXCLUDED.input_uncached_tokens,
                        input_text_tokens     = EXCLUDED.input_text_tokens,
                        output_text_tokens    = EXCLUDED.output_text_tokens,
                        input_cached_text_tokens = EXCLUDED.input_cached_text_tokens,
                        input_audio_tokens         = EXCLUDED.input_audio_tokens,
                        input_cached_audio_tokens  = EXCLUDED.input_cached_audio_tokens,
                        output_audio_tokens        = EXCLUDED.output_audio_tokens,
                        input_image_tokens         = EXCLUDED.input_image_tokens,
                        output_image_tokens        = EXCLUDED.output_image_tokens
                `, [
                    dateStr, projectId,
                    bktStart + BKK_OFFSET_SEC, bktEnd + BKK_OFFSET_SEC,
                    bktStart, bktEnd,
                    String(model).slice(0, 20),
                    num('input_tokens'), num('output_tokens'),
                    num('input_cached_tokens'),
                    Math.max(0, num('input_tokens') - num('input_cached_tokens')),  // derived
                    num('input_text_tokens'), num('output_text_tokens'), num('input_cached_text_tokens'),
                    num('input_audio_tokens'), num('input_cached_audio_tokens'), num('output_audio_tokens'),
                    num('input_image_tokens'), num('output_image_tokens'),
                ]);
                rowsInserted++;
            }
            // Stamp openai_synced_at per project that had data in this run
            for (const r of results) {
                if (r.project_id && activeProj.has(r.project_id)) {
                    await pool.query(
                        `UPDATE tbl_project SET openai_synced_at = NOW() WHERE project_id = $1`,
                        [r.project_id]);
                }
            }
        }
    } catch (e) {
        status = 'error';
        errorMsg = String(e.message || e).slice(0, 500);
        logger?.warn?.({ err: errorMsg }, 'usage sync failed');
    } finally {
        _syncRunning = false;
    }

    const durationMs = Date.now() - startedAt;
    try {
        // Note: $4 is used in both an INTEGER column and a BIGINT expression.
        // PG can't infer one consistent type for the same param across those
        // contexts, so we cast it explicitly at each use.
        await pool.query(`
            UPDATE tbl_sync_state SET
                last_run_at        = NOW(),
                last_status        = $1,
                last_error         = $2,
                last_duration_ms   = $3,
                last_rows_inserted = $4::int,
                rows_synced_total  = COALESCE(rows_synced_total, 0) + $4::bigint,
                updated_at         = NOW()
             WHERE id = 1`,
            [status, errorMsg, durationMs, rowsInserted]);
    } catch (e) {
        // Don't crash the sync run for a state-update failure, but DO log
        // it — silent swallow was hiding the bug where state stuck at
        // 'running' forever.
        console.error('[sync] failed to update tbl_sync_state:', e.message);
    }

    console.log(`[sync] ${reason}: status=${status} rows=${rowsInserted} ${durationMs}ms`
        + (errorMsg ? ` err=${errorMsg}` : ''));
    return { status, rowsInserted, durationMs, errorMsg };
}

function startUsageSyncTimer() {
    if (_syncTimer) clearInterval(_syncTimer);
    const mins = Math.max(1, parseInt(process.env.OPENAI_USAGE_SYNC_INTERVAL_MIN, 10) || 15);
    if (!openaiAdmin.isEnabled()) {
        console.log('[sync] OPENAI_ADMIN_KEY not configured — usage sync disabled');
        return;
    }
    // Phase 19.9: auto-sync is opt-in via OPENAI_USAGE_SYNC_ENABLED=true.
    // Default = OFF. tbl_daily_token still exists and `POST /api/sync-now`
    // (admin manual trigger) still works — the timer just doesn't fire
    // by itself, so the app stays quiet until the team explicitly turns
    // automatic sync on. Set the env var to "true" / "1" / "yes" to enable.
    const enabled = /^(1|true|yes|on)$/i.test(String(process.env.OPENAI_USAGE_SYNC_ENABLED || ''));
    if (!enabled) {
        console.log('[sync] auto-sync disabled (set OPENAI_USAGE_SYNC_ENABLED=true to enable). Manual /api/sync-now still works.');
        return;
    }
    console.log(`[sync] usage sync will run every ${mins} min`);
    // First run shortly after boot (don't block startup)
    setTimeout(() => runUsageSync('boot'), 10_000);
    _syncTimer = setInterval(() => runUsageSync('scheduled'), mins * 60_000);
}


return { runUsageSync, startUsageSyncTimer, getSyncState: () => ({ running: _syncRunning }) };
};
