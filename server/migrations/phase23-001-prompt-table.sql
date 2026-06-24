-- Phase 23: move skill prompts from the JSON file into the DB so edits made
-- via the admin UI persist (no git conflict / no loss on redeploy) and are
-- shared across server instances. skill-prompts.js seeds this table from
-- server/config/skill-prompts.json on first boot when it is empty, then the DB
-- becomes the source of truth. The JSON file remains as the initial seed + a
-- safety fallback if the DB is ever unreachable.

CREATE TABLE IF NOT EXISTS tbl_prompt (
    id               VARCHAR(64)  PRIMARY KEY,
    label            VARCHAR(200) NOT NULL DEFAULT '',
    description      TEXT         NOT NULL DEFAULT '',
    content          TEXT         NOT NULL DEFAULT '',
    openai_prompt_id VARCHAR(120) NOT NULL DEFAULT '',
    position         INTEGER      NOT NULL DEFAULT 0,
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_by       VARCHAR(100)
);

-- Lightweight audit trail: one snapshot row per add/edit/delete so a bad edit
-- can be traced and rolled back. History writes are best-effort in code.
CREATE TABLE IF NOT EXISTS tbl_prompt_history (
    history_id  BIGSERIAL    PRIMARY KEY,
    prompt_id   VARCHAR(64)  NOT NULL,
    action      VARCHAR(20)  NOT NULL,   -- insert | update | delete | seed
    label       VARCHAR(200),
    description TEXT,
    content     TEXT,
    changed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    changed_by  VARCHAR(100)
);

CREATE INDEX IF NOT EXISTS idx_prompt_active   ON tbl_prompt (is_active, position);
CREATE INDEX IF NOT EXISTS idx_prompt_hist_pid ON tbl_prompt_history (prompt_id, changed_at DESC);
