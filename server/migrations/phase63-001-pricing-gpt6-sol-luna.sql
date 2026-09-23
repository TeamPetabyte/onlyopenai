-- Phase 63: gpt-6-sol and gpt-6-luna pricing (released by OpenAI 2026-09-22).
-- cost = OpenAI's published Standard rate per 1M (input / cached / output) at FX 35 THB/USD,
-- expressed per 1K tokens, same as phase58-001:
--   gpt-6-sol   $2   / $0.20 / $10   → 0.07   / 0.007   / 0.35
--   gpt-6-luna  $0.1 / $0.01 / $0.50 → 0.0035 / 0.00035 / 0.0175
-- price = cost x5 (80% margin), the convention since phase62-001.
-- Idempotent: only inserts if no active row exists for the model.

INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT 'gpt-6-sol', 0.07, 0.007, 0.35,
       0.35, 0.035, 1.75, NOW(),
       'gpt-6-sol: OpenAI $2/$0.2/$10 per 1M (FX35). Price = cost x5 (80% margin).'
WHERE NOT EXISTS (
    SELECT 1 FROM tbl_pricing WHERE model = 'gpt-6-sol' AND effective_to IS NULL
);

INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT 'gpt-6-luna', 0.0035, 0.00035, 0.0175,
       0.0175, 0.00175, 0.0875, NOW(),
       'gpt-6-luna: OpenAI $0.1/$0.01/$0.5 per 1M (FX35). Price = cost x5 (80% margin).'
WHERE NOT EXISTS (
    SELECT 1 FROM tbl_pricing WHERE model = 'gpt-6-luna' AND effective_to IS NULL
);
