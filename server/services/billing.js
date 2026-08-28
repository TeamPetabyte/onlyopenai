// billing.js — เงินจริงอยู่ที่ project pool; daily cap เป็นเพดาน ไม่ใช่กระเป๋า

module.exports = function createBilling({ pool }) {
// spend วันนี้อ่านจาก tbl_daily_usage ที่ rollup ใน tx ของแชทแล้ว — ตรงกับที่หักจริงเสมอ
async function spentToday(userId) {
    const r = await pool.query(`
        SELECT COALESCE(SUM(total_price), 0)::numeric(12,4) AS spent
        FROM tbl_daily_usage
        WHERE user_id = $1
          AND usage_date = (NOW() AT TIME ZONE 'Asia/Bangkok')::date`,
        [userId]);
    return parseFloat(r.rows[0].spent) || 0;
}

// Concept B: เงินจริงมีที่เดียวคือ project pool; daily_cap เป็นเพดานไม่ใช่กระเป๋า
// checkChatBudget คือเกตเดียว — แยก error pool หมด vs ชน cap ให้ UX คนละข้อความ

async function getEffectiveDailyCap(userId) {
    // bonus เป็นยอดคงค้าง (tbl_user.bonus_balance) — effective = daily_cap + bonus; ไม่มี cap = null
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
    // คืน {ok:true,...} หรือ {ok:false, error:'project_pool_empty'|'daily_cap_exceeded', ...}
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

// ราคา active จาก tbl_pricing + cache 30s ต่อ process; ไม่มีแถวใช้ fallback ของผู้เรียก
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
