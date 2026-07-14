-- Phase 27: gpt-5.6 pricing — three-tier family (sol / terra / luna).
-- cost = OpenAI's published rate (USD per 1M tokens) at FX ~35 THB/USD,
-- expressed per 1K tokens. cached_cost = 10% of input_cost (OpenAI's cached
-- input rate, same ratio as the gpt-5.5 row in phase23-002).
-- _price = cost x10 → flat 90% gross margin, matching the finalized gpt-5.5
-- selling price (see phase26-001-pricing-gpt55-finalize.sql).
--   sol   : OpenAI $5   / $0.5  / $30 per 1M
--   terra : OpenAI $2.5 / $0.25 / $15 per 1M
--   luna  : OpenAI $1   / $0.1  / $6  per 1M
-- Idempotent per model: only inserts if no active row exists for that model.

INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT 'gpt-5.6-sol', 0.175, 0.0175, 1.05,
       1.75, 0.175, 10.5, NOW(),
       'gpt-5.6-sol: OpenAI $5/$0.5/$30 per 1M (FX35). Price = cost x10 (90% margin).'
WHERE NOT EXISTS (
    SELECT 1 FROM tbl_pricing WHERE model = 'gpt-5.6-sol' AND effective_to IS NULL
);

INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT 'gpt-5.6-terra', 0.0875, 0.00875, 0.525,
       0.875, 0.0875, 5.25, NOW(),
       'gpt-5.6-terra: OpenAI $2.5/$0.25/$15 per 1M (FX35). Price = cost x10 (90% margin).'
WHERE NOT EXISTS (
    SELECT 1 FROM tbl_pricing WHERE model = 'gpt-5.6-terra' AND effective_to IS NULL
);

INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT 'gpt-5.6-luna', 0.035, 0.0035, 0.21,
       0.35, 0.035, 2.1, NOW(),
       'gpt-5.6-luna: OpenAI $1/$0.1/$6 per 1M (FX35). Price = cost x10 (90% margin).'
WHERE NOT EXISTS (
    SELECT 1 FROM tbl_pricing WHERE model = 'gpt-5.6-luna' AND effective_to IS NULL
);
