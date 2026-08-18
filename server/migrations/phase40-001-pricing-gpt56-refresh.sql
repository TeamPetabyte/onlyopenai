-- Phase 40: refresh gpt-5.6 COST to OpenAI's post-2026-07-30 rates.
--
-- On 30 Jul 2026 OpenAI cut Terra 20% and Luna 80%; Sol was unchanged.
-- tbl_pricing still carried the pre-cut figures seeded by
-- phase27-001-pricing-gpt56.sql, so since that date every cost and margin
-- number the system reported for Terra and Luna has been wrong — Luna's
-- recorded cost was 5x its real one. Nothing was ever under-charged; the
-- error runs the other way, understating the margin we actually earn.
--
--   model          old (USD/1M)        new (USD/1M)        change
--   gpt-5.6-sol    $5   / $0.5 / $30   $5   / $0.5 / $30   unchanged
--   gpt-5.6-terra  $2.5 / $0.25 / $15  $2   / $0.2  / $12  -20%
--   gpt-5.6-luna   $1   / $0.1  / $6   $0.2 / $0.02 / $1.2 -80%
--
-- Cached input stays at 10% of uncached input (OpenAI's 90% cache discount),
-- the same ratio phase27-001 assumed. FX 35 THB/USD, unchanged from
-- phase27-001, so the two generations of rows stay comparable.
--   THB per 1K = USD per 1M / 1000 * 35
--
-- SELLING PRICE IS DELIBERATELY NOT TOUCHED.
-- phase27-001 set price = cost x10 (a flat 90% margin). Re-deriving the price
-- from the new cost would have cut what users pay for Terra by 20% and for
-- Luna by 80%; the owner's decision was to correct the books only and leave
-- customer-facing rates where they are. Terra and Luna therefore now sit at
-- 92% and 98% margin instead of 90%. That is intentional — do NOT "restore"
-- price = cost x10 on the assumption this row is a mistake.
--
-- Effective-dated rather than an in-place UPDATE (unlike
-- phase26-001-pricing-gpt55-finalize.sql, where the old value was a
-- placeholder that never described reality): the pre-cut cost was genuinely
-- what OpenAI charged until 30 Jul, so it stays on record as a closed row.
-- effective_from is NOW(), not backdated to 30 Jul — usage already billed
-- between then and now was computed and stored with the old rate, and
-- backdating would misrepresent what the system actually charged.
--
-- Idempotent: the UPDATE only matches a row that still holds the stale cost,
-- and the INSERT only fires on what that UPDATE closed. Re-running is a no-op.
-- The current selling price is carried forward from the closed row rather than
-- hardcoded, so a price changed by an admin since phase27-001 survives.
--
-- Verify after applying:
--   SELECT model, input_cost, cached_cost, output_cost,
--          input_price, output_price, effective_from, effective_to
--     FROM tbl_pricing WHERE model LIKE 'gpt-5.6%' ORDER BY model, effective_from;

-- ── gpt-5.6-terra: $2 / $0.20 / $12 per 1M → 0.07 / 0.007 / 0.42 THB per 1K ──
WITH closed AS (
    UPDATE tbl_pricing
       SET effective_to = NOW()
     WHERE model = 'gpt-5.6-terra'
       AND effective_to IS NULL
       AND input_cost <> 0.07
    RETURNING input_price, cached_price, output_price
)
INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT 'gpt-5.6-terra', 0.07, 0.007, 0.42,
       closed.input_price, closed.cached_price, closed.output_price, NOW(),
       'gpt-5.6-terra: OpenAI $2/$0.2/$12 per 1M (FX35), post-2026-07-30 cut. '
       || 'Selling price carried over unchanged from phase27-001 by decision, '
       || 'so margin is 92% here, not the 90% that price = cost x10 would give.'
  FROM closed;

-- ── gpt-5.6-luna: $0.20 / $0.02 / $1.20 per 1M → 0.007 / 0.0007 / 0.042 THB per 1K ──
WITH closed AS (
    UPDATE tbl_pricing
       SET effective_to = NOW()
     WHERE model = 'gpt-5.6-luna'
       AND effective_to IS NULL
       AND input_cost <> 0.007
    RETURNING input_price, cached_price, output_price
)
INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT 'gpt-5.6-luna', 0.007, 0.0007, 0.042,
       closed.input_price, closed.cached_price, closed.output_price, NOW(),
       'gpt-5.6-luna: OpenAI $0.2/$0.02/$1.2 per 1M (FX35), post-2026-07-30 cut. '
       || 'Selling price carried over unchanged from phase27-001 by decision, '
       || 'so margin is 98% here, not the 90% that price = cost x10 would give.'
  FROM closed;

-- gpt-5.6-sol is intentionally absent: OpenAI did not change it, so its
-- phase27-001 row is still correct and must not be re-dated.
