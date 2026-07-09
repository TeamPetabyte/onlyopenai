-- Phase 26: finalize gpt-5.5 selling price. Since
-- phase23-002-pricing-gpt55.sql, input_price/output_price/cached_price
-- were a placeholder copied from gpt-4o so the row wouldn't violate the
-- NOT NULL constraint -- that migration's own comment said the team would
-- UPDATE it later with the real rate. gpt-5.5 is becoming the primary
-- chat model, so this can't stay a placeholder any longer.
--
-- Decision: flat 10x markup over OpenAI's cost (input_cost/output_cost/
-- cached_cost, already correct since phase23-002) -- works out to a flat
-- 90% gross margin on every rate: margin% = (price-cost)/price = 9/10.
-- Comparable to existing models (gpt-4o ~77-82%, gpt-4o-mini ~93-95%),
-- so 90% sits consistently in between, not an outlier.
--
-- Plain UPDATE (not a new effective-dated row) because the placeholder
-- was never a real historical price to preserve -- same approach the
-- phase23-002 comment itself specified.

UPDATE tbl_pricing
SET input_price  = 1.75,
    output_price = 10.5,
    cached_price = 0.175,
    note = 'gpt-5.5: OpenAI $5/$0.5/$30 per 1M (FX35). Price = cost x10 (90% margin), finalized -- see phase23-002-pricing-gpt55.sql for cost derivation.'
WHERE model = 'gpt-5.5' AND effective_to IS NULL;
