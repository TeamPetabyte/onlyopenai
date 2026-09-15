-- Phase 58: gpt-6-astra pricing.
-- cost = OpenAI's published rate $10 / $1 / $50 per 1M (input / cached / output)
-- at FX 35 THB/USD, expressed per 1K tokens, same as phase27-001.
-- price = cost x10 (90% margin), the convention every model row was seeded with.
-- ponytail: the >272K-input long-context tier (2x input, 1.5x output) is not
-- modelled — no prompt here comes near it; add a second row keyed on size if one does.
-- Idempotent: only inserts if no active row exists for the model.

INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT 'gpt-6-astra', 0.35, 0.035, 1.75,
       3.5, 0.35, 17.5, NOW(),
       'gpt-6-astra: OpenAI $10/$1/$50 per 1M (FX35). Price = cost x10 (90% margin).'
WHERE NOT EXISTS (
    SELECT 1 FROM tbl_pricing WHERE model = 'gpt-6-astra' AND effective_to IS NULL
);
