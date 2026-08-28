// billing.js — เงินจริงอยู่ที่ project pool; daily cap เป็นเพดาน ไม่ใช่กระเป๋า

module.exports = function createBilling({ pool }) {
// Phase 21 A2 — today's spend now reads from tbl_daily_usage, which is
// already pre-aggregated per (date, user, session, model). Replaces the
// older JOIN over tbl_response × tbl_project rates (slower; required
// re-computing cost on every read; missed turns that didn't write to
// tbl_response). The rollup table is updated atomically inside the chat
// transaction so it's always in sync with what user was actually charged.
async function spentToday(userId) {
    const r = await pool.query(`
        SELECT COALESCE(SUM(total_price), 0)::numeric(12,4) AS spent
        FROM tbl_daily_usage
        WHERE user_id = $1
          AND usage_date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date`,
        [userId]);
    return parseFloat(r.rows[0].spent) || 0;
}

// ════════════════════════════════════════════════════════════
// Phase 21.10 — Concept B credit gates
// ════════════════════════════════════════════════════════════
// One pool per project (`tbl_balance.project_credits`) is the only real
// money. Per-user `daily_cap` is a SPENDING LIMIT, not a wallet. A user
// can request a one-day bonus → admin approves → an entry in
// `tbl_daily_cap_bonus` raises today's effective cap.
//
//   effective_cap(user, today) = daily_cap + Σ today's approved bonuses
//
// `checkChatBudget` is the single gate; the chat endpoint calls it before
// touching OpenAI. It distinguishes two failure modes so the UX can show
// different messages (pool empty needs admin top-up; cap reached can be
// waited out or escalated to a quota request).

async function getEffectiveDailyCap(userId) {
    // Phase 21.12 — bonus is now a PERSISTENT balance (tbl_user.bonus_balance),
    // not a today-only sum. effective_cap = daily_cap + bonus_balance.
    // Returns null when the user has no daily_cap configured (unlimited).
    const r = await pool.query(
        `SELECT daily_cap AS base, COALESCE(bonus_balance, 0) AS bonus
           FROM tbl_user
          WHERE user_id = $1 AND is_deleted = FALSE`,
        [userId]);
    if (!r.rowCount) return null;
    const base = r.rows[0].base;
    if (base === null || base === undefined) return null;
    const baseNum  = parseFloat(base);
    const bonusNum = parseFloat(r.rows[0].bonus) || 0;
    return { base: baseNum, bonus: bonusNum, effective: baseNum + bonusNum };
}

async function getProjectPool(projectId) {
    if (!projectId) return 0;
    const r = await pool.query(
        `SELECT COALESCE(project_credits, 0)::numeric AS pool
           FROM tbl_balance WHERE project_id = $1`,
        [projectId]);
    return r.rowCount ? parseFloat(r.rows[0].pool) : 0;
}

async function checkChatBudget(userId) {
    // Returns { ok: true, pool, cap, projectId }  on success,
    //   or   { ok: false, error, message, ... }   on block.
    // Errors:
    //   'project_pool_empty'  — pool ≤ 0 → admin must top up.
    //   'daily_cap_exceeded'  — usage_today ≥ effective cap → wait/request more.
    const u = await pool.query(
        `SELECT project_id FROM tbl_user WHERE user_id=$1 AND is_deleted=FALSE`,
        [userId]);
    const projectId = u.rows[0]?.project_id || null;

    const pool_ = await getProjectPool(projectId);
    if (pool_ <= 0) {
        return {
            ok: false,
            error: 'project_pool_empty',
            message: '⛔ เครดิตโครงการหมด กรุณาติดต่อผู้ดูแลเติมเงิน',
            projectPool: pool_,
            projectId,
        };
    }

    const cap = await getEffectiveDailyCap(userId);
    if (cap !== null) {
        const spent = await spentToday(userId);
        if (spent >= cap.effective) {
            return {
                ok: false,
                error: 'daily_cap_exceeded',
                message: `⛔ คุณใช้ครบโควต้ารายวันแล้ว (฿${spent.toFixed(2)} / ฿${cap.effective.toFixed(2)}) — reset เที่ยงคืน หรือกด "ขอเพิ่มโควต้า"`,
                spentToday:   spent,
                dailyCap:     cap.base,
                bonusBalance: cap.bonus,
                effective:    cap.effective,
                canRequestMore: true,
                projectPool: pool_,
                projectId,
            };
        }
    }
    return { ok: true, projectPool: pool_, cap, projectId };
}

// Phase 21 A1 — active pricing lookup for a model.
// Returns the currently effective price row (input/cached/output) from
// tbl_pricing. Falls back to caller-provided defaults if no row exists
// (e.g. brand-new model not yet seeded). The fallback path also keeps
// older / unit-test callers working when the migration hasn't been
// applied yet. Cached: 30 s in-process map, plenty for a chat workload
// while keeping latency stable when admin edits a price.
const _pricingCache = new Map();   // model → { row, expiresAt }
const PRICING_TTL_MS = 30 * 1000;
async function getActivePricing(model, fallback = {}) {
    const now = Date.now();
    const c = _pricingCache.get(model);
    if (c && c.expiresAt > now) return c.row;

    let row = null;
    try {
        const r = await pool.query(
            `SELECT input_price, cached_price, output_price
             FROM tbl_pricing
             WHERE model = $1
               AND effective_from <= NOW()
               AND (effective_to IS NULL OR effective_to > NOW())
             ORDER BY effective_from DESC LIMIT 1`,
            [model]);
        row = r.rows[0] || null;
    } catch (e) {
        console.warn('[pricing] lookup failed for', model, '—', e.message);
    }
    const fallbackInput  = Number(fallback.inputRate  ?? 0.50);
    const fallbackOutput = Number(fallback.outputRate ?? 1.50);
    const active = {
        inputPrice:  Number(row?.input_price  ?? fallbackInput),
        cachedPrice: Number(row?.cached_price ?? fallbackInput * 0.5),
        outputPrice: Number(row?.output_price ?? fallbackOutput),
        fromDb: !!row,
    };
    _pricingCache.set(model, { row: active, expiresAt: now + PRICING_TTL_MS });
    return active;
}

return { spentToday, getEffectiveDailyCap, getProjectPool, checkChatBudget, getActivePricing };
};
