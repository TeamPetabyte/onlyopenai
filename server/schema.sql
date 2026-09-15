-- ============================================================
--  PetabyteAi — PostgreSQL Schema  (v2 — Phase 4 + bcrypt)
--  1) สร้าง DB:   CREATE DATABASE petabyte_ai;
--  2) รัน schema: psql -U postgres -d petabyte_ai -f schema.sql
-- ============================================================

-- ── Projects (สร้างก่อน เพราะ users อ้างอิง) ─────────────────
CREATE TABLE IF NOT EXISTS projects (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(200) NOT NULL,
    description  TEXT         NOT NULL DEFAULT '',
    input_rate   NUMERIC(10,4) NOT NULL DEFAULT 0.50,
    output_rate  NUMERIC(10,4) NOT NULL DEFAULT 1.50,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Users ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id           SERIAL PRIMARY KEY,
    username     VARCHAR(100) UNIQUE NOT NULL,
    password     TEXT         NOT NULL,       -- bcrypt hash เสมอ
    display_name VARCHAR(200) NOT NULL DEFAULT '',
    role         VARCHAR(20)  NOT NULL DEFAULT 'user',
    plan         VARCHAR(50)  NOT NULL DEFAULT 'starter',
    balance      NUMERIC(12,4) NOT NULL DEFAULT 0,
    project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Usage History ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_history (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_id      VARCHAR(100),
    skill_name    VARCHAR(200),
    skill_emoji   VARCHAR(20),
    prompt        TEXT,
    response      TEXT,
    input_tokens  INTEGER      NOT NULL DEFAULT 0,
    output_tokens INTEGER      NOT NULL DEFAULT 0,
    cost          NUMERIC(12,6) NOT NULL DEFAULT 0,
    duration_ms   INTEGER      NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Chat Sessions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_sessions (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       VARCHAR(500) NOT NULL DEFAULT 'New Chat',
    skill_id    VARCHAR(100),
    skill_name  VARCHAR(200),
    skill_emoji VARCHAR(20),
    messages    JSONB        NOT NULL DEFAULT '[]',
    thread_id   TEXT,                           -- OpenAI Assistants thread_id
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Indexes ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_username      ON users(username);
CREATE INDEX IF NOT EXISTS idx_usage_user_id       ON usage_history(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_created_at    ON usage_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON chat_sessions(updated_at DESC);

-- ── Seed: Default Projects ────────────────────────────────────
INSERT INTO projects (name, description, input_rate, output_rate) VALUES
    ('SAP Development',  'โปรเจค ABAP/SAP Development', 0.50, 1.50),
    ('SAP Consulting',   'โปรเจค SAP Consulting',        0.60, 1.80),
    ('SAP QA & Testing', 'โปรเจค QA และ Testing',        0.40, 1.20)
ON CONFLICT DO NOTHING;

-- ── Seed: Default Users ──
-- Removed 2026-09-04 (PTB-FND-001): this legacy file used to carry bcrypt hashes
-- of documented default passwords. Accounts are created with `node reset-admin.js`
-- (random password, printed once) or the admin UI. The live schema is
-- server/migrations/ — this file is a historical reference.
