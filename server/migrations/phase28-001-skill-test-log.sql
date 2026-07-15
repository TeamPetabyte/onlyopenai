-- Phase 28: skill test log — persist every admin prompt-test run so a senior
-- SAP dev can judge answers (correct / partial / incorrect) and supply the
-- corrected "golden" answer. This table is the raw material for the future
-- eval harness (batch scoring) and few-shot bank.
--
-- Notes:
--   * skill_id is TEXT (skills live in skill-prompts.json, ids are strings
--     like 'find_bapi') — no FK on purpose; skill_label is a snapshot so the
--     log stays readable even if the skill is renamed/deleted.
--   * prompt_sha256/prompt_length fingerprint the system prompt at test time
--     so we know which prompt version produced each answer.
--   * verdict NULL = not judged yet.

CREATE TABLE IF NOT EXISTS tbl_skill_test_log (
    log_id           SERIAL PRIMARY KEY,
    skill_id         TEXT NOT NULL,
    skill_label      TEXT,
    prompt_sha256    TEXT,
    prompt_length    INT,
    model            TEXT NOT NULL,
    effort           TEXT,
    question         TEXT NOT NULL,
    answer           TEXT NOT NULL,
    input_tokens     INT NOT NULL DEFAULT 0,
    output_tokens    INT NOT NULL DEFAULT 0,
    verdict          TEXT CHECK (verdict IN ('correct','partial','incorrect')),
    corrected_answer TEXT,
    verdict_note     TEXT,
    category         TEXT,
    tested_by        INT,
    judged_by        INT,
    judged_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stl_skill   ON tbl_skill_test_log (skill_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stl_verdict ON tbl_skill_test_log (verdict);
