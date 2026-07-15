-- Phase 29: eval harness — batch-test a skill's prompt against the golden
-- dataset (senior-judged cases promoted via the ⭐ flag) and score it with an
-- AI judge. Builds on tbl_skill_test_log (phase28).
--
--   * is_eval_case: a judged log row promoted into the exam set. Promotion
--     requires a golden reference (verdict='correct' → the answer itself, or
--     a corrected_answer) — enforced in the API, not here.
--   * tbl_eval_run: one row per exam sitting (which skill/model/effort, who
--     judged, progress counters, final score).
--   * tbl_eval_result: one row per case within a run (fresh answer, judge
--     verdict + rubric JSON).

ALTER TABLE tbl_skill_test_log
    ADD COLUMN IF NOT EXISTS is_eval_case BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS tbl_eval_run (
    run_id        SERIAL PRIMARY KEY,
    skill_id      TEXT NOT NULL,
    skill_label   TEXT,
    model         TEXT NOT NULL,          -- model under test
    effort        TEXT,
    judge_model   TEXT NOT NULL,
    judge_effort  TEXT,
    status        TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','done','failed','cancelled')),
    total_cases   INT  NOT NULL DEFAULT 0,
    done_cases    INT  NOT NULL DEFAULT 0,
    pass_cases    INT  NOT NULL DEFAULT 0,
    score_pct     NUMERIC(5,1),
    error         TEXT,
    input_tokens  INT  NOT NULL DEFAULT 0,   -- answering + judging combined
    output_tokens INT  NOT NULL DEFAULT 0,
    started_by    INT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tbl_eval_result (
    result_id     SERIAL PRIMARY KEY,
    run_id        INT NOT NULL REFERENCES tbl_eval_run(run_id) ON DELETE CASCADE,
    log_id        INT NOT NULL,             -- the eval case (tbl_skill_test_log)
    category      TEXT,
    answer        TEXT,                     -- fresh answer from the model under test
    passed        BOOLEAN,
    score         NUMERIC(4,1),             -- judge overall 0-10
    judge_json    TEXT,                     -- parsed rubric JSON (as stored string)
    judge_reason  TEXT,
    error         TEXT,
    input_tokens  INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_result_run ON tbl_eval_result (run_id);
CREATE INDEX IF NOT EXISTS idx_eval_run_skill  ON tbl_eval_run (skill_id, started_at DESC);
