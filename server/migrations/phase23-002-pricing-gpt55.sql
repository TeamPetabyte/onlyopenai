-- Phase 23: gpt-5.5 pricing. Cost = OpenAI's published rate (input $5 / cached
-- $0.50 / output $30 per 1M tokens) at FX ~35 THB/USD, expressed per 1K tokens.
-- _price is a PLACEHOLDER set equal to gpt-4o (0.5 / 0.25 / 1.5) so adding this
-- row does NOT change what customers are currently charged — the team finalises
-- the real gpt-5.5 rate later (UPDATE tbl_pricing ... WHERE model='gpt-5.5').
-- Idempotent: only inserts if no active gpt-5.5 row exists (the live DB may
-- already have it from a direct insert).

INSERT INTO tbl_pricing
    (model, input_cost, cached_cost, output_cost,
     input_price, cached_price, output_price, effective_from, note)
SELECT 'gpt-5.5', 0.175, 0.0175, 1.05,
       0.5, 0.25, 1.5, NOW(),
       'gpt-5.5: OpenAI $5/$0.5/$30 per 1M (FX35). _price=placeholder(=gpt-4o); team to finalize.'
WHERE NOT EXISTS (
    SELECT 1 FROM tbl_pricing WHERE model = 'gpt-5.5' AND effective_to IS NULL
);
