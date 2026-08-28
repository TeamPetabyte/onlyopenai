// pricing-sql.js — SQL ชิ้นที่คิดราคา/ต้นทุนต่อแถว ใช้ร่วมกันใน history และ cost-by-day

// GET /api/history?userId=1
// Phase 6 fix: was joining r.project_id = u.project_id, which leaked history across
// users sharing a project. Now joins on r.user_id directly.
// Phase 30: shared LATERAL join that finds the tbl_pricing row active at
// r.created_at for r.model — same rate-resolution logic as
// fn_build_daily_usage() (the function that feeds tbl_daily_usage /
// spentToday(), i.e. the numbers actually deducted from the pool). Every
// endpoint that displays a cost to users now joins through this instead of
// the legacy tbl_project.input_rate/output_rate columns, so the numbers
// agree everywhere instead of drifting between two rate sources.
const PRICING_LATERAL_JOIN = `
    LEFT JOIN LATERAL (
        SELECT pr2.*
        FROM tbl_pricing pr2
        WHERE pr2.model = r.model
        ORDER BY
            (CASE WHEN pr2.effective_from <= (r.created_at AT TIME ZONE 'Asia/Bangkok')
                   AND (pr2.effective_to IS NULL OR pr2.effective_to > (r.created_at AT TIME ZONE 'Asia/Bangkok'))
                  THEN 0 ELSE 1 END),
            ABS(EXTRACT(EPOCH FROM (pr2.effective_from - (r.created_at AT TIME ZONE 'Asia/Bangkok'))))
        LIMIT 1
    ) pr ON TRUE`;
// Raw (unrounded) per-row price — for SUM(...) aggregates, round the total
// once at the end (matches fn_build_daily_usage's ROUND(SUM(...), n)
// pattern) rather than rounding each row first and compounding drift.
const PRICING_PRICE_EXPR_RAW = `
    (
        (GREATEST(r.input_tokens - COALESCE(r.input_cached_tokens, 0), 0) / 1000.0)
            * COALESCE(pr.input_price, 0.50)
      + (COALESCE(r.input_cached_tokens, 0) / 1000.0)
            * COALESCE(pr.cached_price, COALESCE(pr.input_price, 0.50) * 0.5)
      + (r.output_tokens / 1000.0)
            * COALESCE(pr.output_price, 1.50)
    )`;
// Per-row display value (e.g. one line in a history table) — rounded to 2dp.
const PRICING_COST_EXPR = `ROUND((${PRICING_PRICE_EXPR_RAW})::numeric, 2)`;


module.exports = { PRICING_LATERAL_JOIN, PRICING_PRICE_EXPR_RAW, PRICING_COST_EXPR };
