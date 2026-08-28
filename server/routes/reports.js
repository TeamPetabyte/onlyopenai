// reports.js — cost-by-day, transactions, export Excel
const express = require('express');

module.exports = function (ctx) {
const router = express.Router();
const {
    expensiveRateLimiter,
    pool,
    PRICING_LATERAL_JOIN,
    PRICING_PRICE_EXPR_RAW,
    requireAdmin,
    safeError,
} = ctx;
router.get('/api/cost-by-day', requireAdmin, async (req, res) => {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    try {
        const params = [days];
        let filter = '';
        if (userId) { params.push(userId); filter = 'AND r.user_id = $2'; }
        const q = `
            WITH days AS (
                SELECT generate_series(
                    CURRENT_DATE - ($1::int - 1),
                    CURRENT_DATE,
                    INTERVAL '1 day'
                )::date AS d
            ),
            agg AS (
                SELECT r.created_at::date AS d,
                       COUNT(*)                                                    AS requests,
                       COALESCE(SUM(r.input_tokens),         0)                    AS input_tokens,
                       COALESCE(SUM(r.input_cached_tokens),  0)                    AS cached_tokens,
                       COALESCE(SUM(r.output_tokens),        0)                    AS output_tokens,
                       -- Phase 30: price from tbl_pricing (was tbl_project.input_rate/
                       -- output_rate — the legacy per-project columns, which could
                       -- disagree with tbl_daily_usage / what was actually charged).
                       ROUND(COALESCE(SUM(${PRICING_PRICE_EXPR_RAW}), 0)::numeric, 2) AS cost
                FROM tbl_response r
                JOIN tbl_project  p ON p.project_id = r.project_id
                ${PRICING_LATERAL_JOIN}
                WHERE r.created_at::date >= CURRENT_DATE - ($1::int - 1)
                  ${filter}
                GROUP BY r.created_at::date
            )
            SELECT d.d AS date,
                   COALESCE(a.requests,      0) AS requests,
                   COALESCE(a.input_tokens,  0) AS input_tokens,
                   COALESCE(a.cached_tokens, 0) AS cached_tokens,
                   COALESCE(a.output_tokens, 0) AS output_tokens,
                   COALESCE(a.cost,          0) AS cost
            FROM days d LEFT JOIN agg a ON a.d = d.d
            ORDER BY d.d ASC`;
        const r = await pool.query(q, params);
        const rows = r.rows.map(x => ({
            date:         x.date instanceof Date ? x.date.toISOString().slice(0, 10) : x.date,
            requests:     parseInt(x.requests, 10),
            inputTokens:  parseInt(x.input_tokens, 10),
            cachedTokens: parseInt(x.cached_tokens, 10),
            outputTokens: parseInt(x.output_tokens, 10),
            cost:         parseFloat(x.cost),
        }));
        const total = rows.reduce((s, x) => ({
            requests:     s.requests     + x.requests,
            inputTokens:  s.inputTokens  + x.inputTokens,
            cachedTokens: s.cachedTokens + x.cachedTokens,
            outputTokens: s.outputTokens + x.outputTokens,
            cost:         s.cost         + x.cost,
        }), { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cost: 0 });
        res.json({ ok: true, days, userId, total, rows });
    } catch (e) { res.status(500).json({ ok: false, ...safeError(e, req) }); }
});

// ══════════════════════════════════════════════════════════
//  USAGE HISTORY
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
//  TRANSACTION JOURNAL (Phase 21.5)
// ══════════════════════════════════════════════════════════
// GET /api/transactions
//   ?projectId=  filter by project (optional — admin only)
//   ?from=YYYY-MM-DD  inclusive start (default: today - 7 days for day mode)
//   ?to=YYYY-MM-DD    inclusive end   (default: today)
//   ?groupBy=day|month  default 'day'
//   ?limit=  cap rows (default 200, max 1000)
//
// Reads through v_user_credit_transaction so the JOINs to user/project
// already include display_name + project_name. day mode returns rows
// 1:1 with the underlying journal; month mode aggregates per
// (month, user, type).
router.get('/api/transactions', requireAdmin, async (req, res) => {
    const groupBy = (req.query.groupBy === 'month') ? 'month' : 'day';
    const limit   = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 1000);

    // Date defaults: keep it tight so the default load is fast.
    const today   = new Date();
    const tzShift = 7 * 60 * 60 * 1000;             // shift UTC → Bangkok for date math
    const todayBkk = new Date(today.getTime() + tzShift).toISOString().slice(0, 10);
    const dShift = (days) => new Date(today.getTime() + tzShift - days * 86400000)
                              .toISOString().slice(0, 10);
    const defaultFrom = groupBy === 'month' ? dShift(60) : dShift(6);
    const from = String(req.query.from || defaultFrom).slice(0, 10);
    const to   = String(req.query.to   || todayBkk).slice(0, 10);

    // Optional project filter
    const projFilter = (req.query.projectId || '').trim();
    const params = [from, to, limit];
    let projWhere = '';
    if (projFilter) {
        params.push(projFilter);
        projWhere = ` AND project_id = $${params.length}`;
    }

    // Hide smoke/throwaway test users by default. Pass ?includeTest=1
    // to bring them back (for debugging only).
    // Patterns matched (anchored prefixes, case-insensitive):
    //   smoke_*, p7_victim_*, delme_*, fix_*, om_*, pm_*, pm2_*,
    //   test1, test2, testuser, testuser2
    let testWhere = '';
    if (req.query.includeTest !== '1') {
        testWhere = `
            AND username !~* '^(smoke_|p7_victim_|delme_|fix_|om_|pm_|pm2_)'
            AND username NOT IN ('test1','test2','testuser','testuser2')
        `;
    }

    try {
        let rows;
        if (groupBy === 'month') {
            // Aggregate: (month, user, type) → sum amount, count events
            const sql = `
                SELECT
                    TO_CHAR(tx_month, 'FMMonth YYYY')    AS period_label,
                    tx_month                              AS period_key,
                    user_id,
                    username,
                    display_name,
                    project_id,
                    project_name,
                    type,
                    COUNT(*)::int                         AS event_count,
                    SUM(amount_display)::numeric(12, 2)   AS amount
                FROM v_user_credit_transaction
                WHERE tx_month >= $1::date
                  AND tx_month <= $2::date
                  ${projWhere}
                  ${testWhere}
                GROUP BY tx_month, user_id, username, display_name,
                         project_id, project_name, type
                ORDER BY tx_month DESC, amount DESC
                LIMIT $3`;
            const r = await pool.query(sql, params);
            rows = r.rows;
        } else {
            // Per-event detail
            const sql = `
                SELECT
                    transaction_id,
                    tx_date,
                    created_at,
                    user_id,
                    username,
                    display_name,
                    project_id,
                    project_name,
                    type,
                    amount_signed,
                    amount_display                        AS amount,
                    balance_before,
                    balance_after,
                    ref_type,
                    ref_id,
                    note,
                    created_by_username
                FROM v_user_credit_transaction
                WHERE tx_date >= $1::date
                  AND tx_date <= $2::date
                  ${projWhere}
                  ${testWhere}
                ORDER BY created_at DESC
                LIMIT $3`;
            const r = await pool.query(sql, params);
            rows = r.rows;
        }
        res.json({
            ok:       true,
            groupBy,
            from, to,
            projectId: projFilter || null,
            count:    rows.length,
            rows,
        });
    } catch (e) {
        console.error('[transactions]', e.message);
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// GET /api/transactions/export?format=csv|xlsx&groupBy=day|month&from=&to=&projectId=
// Phase 21.7 — Download the same dataset shown in "Transaction by Date" as
// a CSV or Excel file. Reuses the v_user_credit_transaction view and the
// same test-user filter as /api/transactions so the export matches what
// the admin sees on screen.
router.get('/api/transactions/export', requireAdmin, expensiveRateLimiter, async (req, res) => {
    const format  = (req.query.format === 'xlsx') ? 'xlsx' : 'csv';
    const groupBy = (req.query.groupBy === 'month') ? 'month' : 'day';

    // Date defaults — same logic as /api/transactions
    const today    = new Date();
    const tzShift  = 7 * 60 * 60 * 1000;
    const todayBkk = new Date(today.getTime() + tzShift).toISOString().slice(0, 10);
    const dShift   = (d) => new Date(today.getTime() + tzShift - d * 86400000)
                              .toISOString().slice(0, 10);
    const defaultFrom = groupBy === 'month' ? dShift(60) : dShift(6);
    const from = String(req.query.from || defaultFrom).slice(0, 10);
    const to   = String(req.query.to   || todayBkk).slice(0, 10);

    const projFilter = (req.query.projectId || '').trim();
    const params = [from, to];
    let projWhere = '';
    if (projFilter) {
        params.push(projFilter);
        projWhere = ` AND project_id = $${params.length}`;
    }
    let testWhere = '';
    if (req.query.includeTest !== '1') {
        testWhere = `
            AND username !~* '^(smoke_|p7_victim_|delme_|fix_|om_|pm_|pm2_)'
            AND username NOT IN ('test1','test2','testuser','testuser2')
        `;
    }

    try {
        let rows, columns, sheetName, fileBase;

        if (groupBy === 'month') {
            const sql = `
                SELECT
                    TO_CHAR(tx_month, 'YYYY-MM')         AS period,
                    username,
                    display_name                          AS name,
                    project_name                          AS project,
                    type,
                    COUNT(*)::int                         AS event_count,
                    SUM(amount_display)::numeric(12, 2)   AS amount
                FROM v_user_credit_transaction
                WHERE tx_month >= $1::date
                  AND tx_month <= $2::date
                  ${projWhere}
                  ${testWhere}
                GROUP BY tx_month, user_id, username, display_name,
                         project_id, project_name, type
                ORDER BY tx_month DESC, amount DESC`;
            rows = (await pool.query(sql, params)).rows;
            columns = [
                { header: 'Period',      key: 'period',      width: 12 },
                { header: 'Username',    key: 'username',    width: 22 },
                { header: 'Name',        key: 'name',        width: 24 },
                { header: 'Project',     key: 'project',     width: 22 },
                { header: 'Type',        key: 'type',        width: 12 },
                { header: 'Events',      key: 'event_count', width: 10 },
                { header: 'Amount',      key: 'amount',      width: 14 },
            ];
            sheetName = 'Monthly';
            fileBase  = `transactions-month-${from}-to-${to}`;
        } else {
            const sql = `
                SELECT
                    TO_CHAR(tx_date, 'YYYY-MM-DD')        AS date,
                    TO_CHAR(created_at AT TIME ZONE 'Asia/Bangkok',
                            'YYYY-MM-DD HH24:MI:SS')      AS created_at,
                    username,
                    display_name                          AS name,
                    project_name                          AS project,
                    type,
                    amount_signed                         AS amount,
                    balance_before,
                    balance_after,
                    ref_type,
                    ref_id,
                    note,
                    created_by_username                   AS created_by
                FROM v_user_credit_transaction
                WHERE tx_date >= $1::date
                  AND tx_date <= $2::date
                  ${projWhere}
                  ${testWhere}
                ORDER BY created_at DESC`;
            rows = (await pool.query(sql, params)).rows;
            columns = [
                { header: 'Date',         key: 'date',           width: 12 },
                { header: 'Time',         key: 'created_at',     width: 20 },
                { header: 'Username',     key: 'username',       width: 22 },
                { header: 'Name',         key: 'name',           width: 24 },
                { header: 'Project',      key: 'project',        width: 22 },
                { header: 'Type',         key: 'type',           width: 12 },
                { header: 'Amount',       key: 'amount',         width: 12 },
                { header: 'Balance Before', key: 'balance_before', width: 14 },
                { header: 'Balance After',  key: 'balance_after',  width: 14 },
                { header: 'Ref Type',     key: 'ref_type',       width: 14 },
                { header: 'Ref ID',       key: 'ref_id',         width: 10 },
                { header: 'Note',         key: 'note',           width: 30 },
                { header: 'Created By',   key: 'created_by',     width: 16 },
            ];
            sheetName = 'Day';
            fileBase  = `transactions-day-${from}-to-${to}`;
        }

        if (format === 'csv') {
            // Simple CSV writer — proper escaping for commas/quotes/newlines.
            // BOM prefix so Excel opens UTF-8 (Thai names) correctly.
            const esc = (v) => {
                if (v === null || v === undefined) return '';
                const s = String(v);
                return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const lines = [columns.map(c => esc(c.header)).join(',')];
            for (const r of rows) {
                lines.push(columns.map(c => esc(r[c.key])).join(','));
            }
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition',
                `attachment; filename="${fileBase}.csv"`);
            res.send('﻿' + lines.join('\r\n'));
            return;
        }

        // xlsx via exceljs
        const ExcelJS = require('exceljs');
        const wb = new ExcelJS.Workbook();
        wb.creator = 'PetabyteAi';
        wb.created = new Date();
        const ws = wb.addWorksheet(sheetName, {
            views: [{ state: 'frozen', ySplit: 1 }],
        });
        ws.columns = columns;
        ws.addRows(rows);

        // Header styling — Petabyte accent
        const headerRow = ws.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = {
            type: 'pattern', pattern: 'solid',
            fgColor: { argb: 'FF2563EB' },
        };
        headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
        headerRow.height = 22;

        // Number formats for money columns
        if (groupBy === 'month') {
            ws.getColumn('amount').numFmt = '#,##0.00';
            ws.getColumn('event_count').alignment = { horizontal: 'right' };
        } else {
            ws.getColumn('amount').numFmt = '+#,##0.0000;-#,##0.0000;0';
            ws.getColumn('balance_before').numFmt = '#,##0.00';
            ws.getColumn('balance_after').numFmt  = '#,##0.00';
        }
        ws.autoFilter = {
            from: { row: 1, column: 1 },
            to:   { row: 1, column: columns.length },
        };

        res.setHeader('Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition',
            `attachment; filename="${fileBase}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) {
        console.error('[transactions/export]', e.message);
        res.status(500).json({ ok: false, ...safeError(e, req) });
    }
});

// ════════════════════════════════════════════════════════════
// Phase 21.10 — Quota request workflow (Concept B)
// ════════════════════════════════════════════════════════════
// Flow:
//   user hits daily cap → POST /api/quota-requests (creates pending row)
//   admin sees the list → POST /api/quota-requests/:id/resolve {action:'approve'|'deny'}
//   approve  → INSERT tbl_daily_cap_bonus for TODAY (Bangkok) → effective cap rises
//   deny     → just updates status; cap unchanged
// One pending request per (user, today). Re-asking on the same day after a
// deny is allowed (creates a new request).


return router;
};
