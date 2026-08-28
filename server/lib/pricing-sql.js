// pricing-sql.js — SQL ชิ้นที่คิดราคา/ต้นทุนต่อแถว ใช้ร่วมกันใน history และ cost-by-day

// LATERAL หาแถว tbl_pricing ที่ active ณ r.created_at — ตรรกะเดียวกับ fn_build_daily_usage
// ทุก endpoint ที่โชว์ cost ใช้ตัวนี้ ตัวเลขจึงตรงกันทุกหน้า (join ด้วย r.user_id ไม่ใช่ project กัน history รั่วข้าม user)
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
// ราคาต่อแถวแบบไม่ปัด — SUM แล้วค่อย ROUND ทีเดียว กัน drift สะสม
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
