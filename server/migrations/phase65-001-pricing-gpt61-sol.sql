-- Phase 65: gpt-6.1-sol pricing.
-- cost = OpenAI's published Standard rate per 1M (input / cached / output) at FX 35 THB/USD,
-- expressed per 1K tokens, same as phase63-001:
--   gpt-6.1-sol  $2 / $0.10 / $10 → 0.07 / 0.0035 / 0.35
-- Cache writes ($2.50) and the >272K-input surcharge are not modelled by tbl_pricing.
-- price = cost x5 (80% margin), the convention since phase62-001.
-- Idempotent: only inserts if no active row exists for the model.

INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT 'gpt-6.1-sol', 0.07, 0.0035, 0.35,
       0.35, 0.0175, 1.75, NOW(),
       'gpt-6.1-sol: OpenAI $2/$0.1/$10 per 1M (FX35). Price = cost x5 (80% margin).'
WHERE NOT EXISTS (
    SELECT 1 FROM tbl_pricing WHERE model = 'gpt-6.1-sol' AND effective_to IS NULL
);
