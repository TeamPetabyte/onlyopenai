-- Phase 64: gpt-5.6-sol cost to OpenAI's current rate $4 / $0.40 / $20 per 1M
-- (was $5 / $0.50 / $30 since phase27-001). FX 35 THB/USD, per 1K tokens:
--   cost 0.14 / 0.014 / 0.70, price = cost x5 (phase62-001) 0.70 / 0.07 / 3.50
-- Owner's decision 2026-09-23: the selling price follows the cost (x5), unlike phase40-001.
-- Effective-dated: the stale row is closed, not rewritten. Idempotent: only a row that
-- still holds the old cost is closed, and the insert fires only on what was closed.

WITH closed AS (
    UPDATE tbl_pricing
       SET effective_to = NOW()
     WHERE model = 'gpt-5.6-sol'
       AND effective_to IS NULL
       AND input_cost <> 0.14
    RETURNING model
)
INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT 'gpt-5.6-sol', 0.14, 0.014, 0.70,
       0.70, 0.07, 3.50, NOW(),
       'gpt-5.6-sol: OpenAI $4/$0.4/$20 per 1M (FX35). Price = cost x5 (80% margin), owner decision 2026-09-23.'
  FROM closed;
