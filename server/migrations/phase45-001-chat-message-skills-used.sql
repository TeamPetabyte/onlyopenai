-- Phase 45: record every skill that shaped an answer, not just the first one.
--
-- The senior asked to "audit or trace what skills it selected per session".
-- tbl_chat_message.skill_id is VARCHAR(64) and holds exactly one id, which was
-- honest while the router picked one skill and that skill answered alone.
-- From Phase 45 the primary skill still sets the format, but the other checks
-- the pasted code trips contribute their knowledge to the same answer. skill_id
-- would name one of them and quietly hide the rest.
--
-- Measured on the test program: the file tripped five code-shape rules at once
-- while exactly one skill was loaded, and the two checks that never arrived are
-- exactly the two defects both test runs failed to report.
--
-- skill_id is left alone — it still means "the skill that answered", every
-- existing query keeps working, and the UI reads it unchanged. skills_used is
-- the full picture: a comma-separated list, primary first. TEXT rather than an
-- array because it is read as a whole and never queried by element.
--
-- NULL on every row written before this migration, and on rows where no skill
-- was used at all. That is the truth for those rows; do not backfill skill_id
-- into it, or old single-skill answers would be indistinguishable from new
-- ones that genuinely used one skill.

ALTER TABLE tbl_chat_message
    ADD COLUMN IF NOT EXISTS skills_used TEXT;

COMMENT ON COLUMN tbl_chat_message.skills_used IS
    'Every skill whose knowledge reached the model, primary first, comma-separated. NULL before phase45.';
