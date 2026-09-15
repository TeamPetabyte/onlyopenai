-- Phase 62: selling price = cost x5 (80% margin) on every model.
-- The owner's decision 2026-09-15 (wayfinder ticket 12): x10 "looks absurdly expensive".
-- This overrides the phase40-001 note that kept price at x10 — that note recorded the
-- decision of its day, this records the new one.
-- Effective-dated: the x10 row is closed, a new row carries the same costs with the new
-- prices. Idempotent: only rows whose price is not already cost x5 are touched.

WITH closed AS (
    UPDATE tbl_pricing
       SET effective_to = NOW()
     WHERE effective_to IS NULL
       AND effective_from <= NOW()
       AND input_price <> input_cost * 5
    RETURNING model, input_cost, cached_cost, output_cost
)
INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT model, input_cost, cached_cost, output_cost,
       input_cost * 5, cached_cost * 5, output_cost * 5, NOW(),
       model || ': price = cost x5 (80% margin) by owner decision 2026-09-15 (phase62-001); costs unchanged.'
  FROM closed;
