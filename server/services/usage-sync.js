// usage-sync.js — ดึง usage/cost จาก OpenAI admin API เข้าตารางฝั่งเรา ตามรอบเวลา

module.exports = function createUsageSync(ctx) {
const { pool, openaiAdmin, logger } = ctx;
// ดึง usage จาก OpenAI Admin API ลง tbl_daily_token — bucket แปลงเป็นวัน Asia/Bangkok
// UPSERT บน (usage_date_th, project_id, model) รันซ้ำได้; แถวไม่มี project ที่ตรง = ข้าม
// สถานะอยู่ใน tbl_sync_state (แถวเดียว id=1)
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
        // $4 โดนใช้ทั้งคอลัมน์ INTEGER และ expression BIGINT — ต้อง cast ทุกจุดใช้
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
        // state update พังไม่ล้ม sync แต่ต้อง log — เคยเงียบจน state ค้าง 'running' ตลอด
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
    // auto-sync เป็น opt-in (OPENAI_USAGE_SYNC_ENABLED) — ปิดอยู่ timer ไม่ยิง แต่ sync-now มือยังใช้ได้
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
