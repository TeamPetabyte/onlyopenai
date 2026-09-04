-- ════════════════════════════════════════════════════════════════════
-- PetabyteAi DB — re-runnable schema export
-- Generated: 2026-05-11T10:35:38.549Z
-- Source: OpenAI_DB@<DB_HOST>:5432
--
-- Re-import recipe:
--   psql -h <host> -U <user> -d <new-db> -f schema.sql
-- ════════════════════════════════════════════════════════════════════

-- ── Sequences (owned by SERIAL/BIGSERIAL columns) ───────────────────
CREATE SEQUENCE IF NOT EXISTS tbl_action_admin_id_seq;
CREATE SEQUENCE IF NOT EXISTS tbl_audit_log_id_seq;
CREATE SEQUENCE IF NOT EXISTS tbl_chat_message_message_id_seq;
CREATE SEQUENCE IF NOT EXISTS tbl_chat_session_session_id_seq;
CREATE SEQUENCE IF NOT EXISTS tbl_topup_history_id_seq;
CREATE SEQUENCE IF NOT EXISTS tbl_user_user_id_seq;

-- ── Tables ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tbl_acc_status (
    acc_status_id INTEGER NOT NULL,
    acc_status VARCHAR(100) NOT NULL,
    CONSTRAINT tbl_acc_status_pkey PRIMARY KEY (acc_status_id)
);

CREATE TABLE IF NOT EXISTS tbl_action_admin (
    user_id INTEGER NOT NULL,
    project_id VARCHAR(100),
    role_id INTEGER NOT NULL,
    edit_date DATE DEFAULT CURRENT_DATE NOT NULL,
    edit_time TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL,
    id BIGINT DEFAULT nextval('tbl_action_admin_id_seq'::regclass) NOT NULL,
    action_type VARCHAR(40),
    target_type VARCHAR(20),
    target_id INTEGER,
    change_json JSONB,
    CONSTRAINT tbl_action_admin_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS tbl_audit_log (
    user_id INTEGER,
    log_in_date DATE DEFAULT CURRENT_DATE NOT NULL,
    log_in_time TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL,
    log_out_date DATE,
    log_out_time TIMESTAMP WITHOUT TIME ZONE,
    id BIGINT DEFAULT nextval('tbl_audit_log_id_seq'::regclass) NOT NULL,
    event_type VARCHAR(20),
    detail JSONB,
    ip VARCHAR(45),
    CONSTRAINT tbl_audit_log_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS tbl_balance (
    project_id VARCHAR(100) NOT NULL,
    project_credits NUMERIC DEFAULT 0 NOT NULL,
    top_up_date DATE DEFAULT CURRENT_DATE NOT NULL,
    top_up_time TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL,
    user_id INTEGER NOT NULL,
    CONSTRAINT tbl_balance_pkey PRIMARY KEY (project_id)
);

CREATE TABLE IF NOT EXISTS tbl_chat_message (
    message_id BIGINT DEFAULT nextval('tbl_chat_message_message_id_seq'::regclass) NOT NULL,
    session_id BIGINT NOT NULL,
    role VARCHAR(16) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost NUMERIC,
    model VARCHAR(64),
    skill_id VARCHAR(64),
    CONSTRAINT tbl_chat_message_pkey PRIMARY KEY (message_id),
    CONSTRAINT tbl_chat_message_role_check CHECK (role::text = ANY (ARRAY['user'::character varying, 'assistant'::character varying, 'system'::character varying]::text[]))
);

CREATE TABLE IF NOT EXISTS tbl_chat_session (
    session_id BIGINT DEFAULT nextval('tbl_chat_session_session_id_seq'::regclass) NOT NULL,
    user_id INTEGER NOT NULL,
    title VARCHAR(200) DEFAULT 'New chat'::character varying NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    is_deleted BOOLEAN DEFAULT false NOT NULL,
    message_count INTEGER DEFAULT 0 NOT NULL,
    total_cost NUMERIC DEFAULT 0 NOT NULL,
    CONSTRAINT tbl_chat_session_pkey PRIMARY KEY (session_id)
);

CREATE TABLE IF NOT EXISTS tbl_credits (
    user_id INTEGER NOT NULL,
    project_id VARCHAR(100) NOT NULL,
    user_credits NUMERIC DEFAULT 0 NOT NULL,
    CONSTRAINT tbl_credits_pkey PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS tbl_daily_token (
    usage_date_th DATE NOT NULL,
    project_id VARCHAR(100) NOT NULL,
    start_time_th BIGINT NOT NULL,
    end_time_th BIGINT NOT NULL,
    start_time_utc BIGINT NOT NULL,
    end_time_utc BIGINT NOT NULL,
    model VARCHAR(20) NOT NULL,
    input_tokens INTEGER DEFAULT 0 NOT NULL,
    output_tokens INTEGER DEFAULT 0 NOT NULL,
    input_cached_tokens INTEGER DEFAULT 0 NOT NULL,
    input_uncached_tokens INTEGER DEFAULT 0 NOT NULL,
    input_text_tokens INTEGER DEFAULT 0 NOT NULL,
    output_text_tokens INTEGER DEFAULT 0 NOT NULL,
    input_cached_text_tokens INTEGER DEFAULT 0 NOT NULL,
    input_audio_tokens INTEGER DEFAULT 0 NOT NULL,
    input_cached_audio_tokens INTEGER DEFAULT 0 NOT NULL,
    output_audio_tokens INTEGER DEFAULT 0 NOT NULL,
    input_image_tokens INTEGER DEFAULT 0 NOT NULL,
    output_image_tokens INTEGER DEFAULT 0 NOT NULL,
    CONSTRAINT tbl_daily_token_pkey PRIMARY KEY (usage_date_th)
);

CREATE TABLE IF NOT EXISTS tbl_project (
    project_id VARCHAR(100) NOT NULL,
    project_name VARCHAR(100) NOT NULL,
    project_api_key TEXT,
    admin_api_key TEXT,
    created_date DATE DEFAULT CURRENT_DATE NOT NULL,
    description TEXT DEFAULT ''::text,
    input_rate NUMERIC DEFAULT 0.50,
    output_rate NUMERIC DEFAULT 1.50,
    credit_limit NUMERIC DEFAULT 0,
    is_deleted BOOLEAN DEFAULT false NOT NULL,
    deleted_at TIMESTAMP WITH TIME ZONE,
    openai_project_id VARCHAR(64),
    openai_service_account_id VARCHAR(64),
    openai_synced_at TIMESTAMP WITH TIME ZONE,
    cached_input_rate NUMERIC DEFAULT 0.25,
    CONSTRAINT tbl_project_pkey PRIMARY KEY (project_id)
);

CREATE TABLE IF NOT EXISTS tbl_response (
    response_id VARCHAR(255) NOT NULL,
    project_id VARCHAR(100) NOT NULL,
    model VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL,
    input_param TEXT DEFAULT ''::text NOT NULL,
    output_param TEXT DEFAULT ''::text NOT NULL,
    input_tokens INTEGER DEFAULT 0 NOT NULL,
    input_cached_tokens INTEGER DEFAULT 0 NOT NULL,
    output_tokens INTEGER DEFAULT 0 NOT NULL,
    output_reasoning_tokens INTEGER DEFAULT 0 NOT NULL,
    total_tokens INTEGER DEFAULT 0 NOT NULL,
    user_id INTEGER,
    CONSTRAINT tbl_response_pkey PRIMARY KEY (response_id)
);

CREATE TABLE IF NOT EXISTS tbl_session (
    token VARCHAR(128) NOT NULL,
    user_id INTEGER NOT NULL,
    role VARCHAR(32) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    csrf_token VARCHAR(64),
    CONSTRAINT tbl_session_pkey PRIMARY KEY (token)
);

CREATE TABLE IF NOT EXISTS tbl_topup_history (
    id BIGINT DEFAULT nextval('tbl_topup_history_id_seq'::regclass) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    user_id INTEGER NOT NULL,
    amount NUMERIC NOT NULL,
    balance_before NUMERIC NOT NULL,
    balance_after NUMERIC NOT NULL,
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
    CONSTRAINT tbl_topup_history_pkey PRIMARY KEY (id),
    CONSTRAINT tbl_topup_history_amount_check CHECK (amount > 0::numeric)
);

CREATE TABLE IF NOT EXISTS tbl_user (
    user_id INTEGER DEFAULT nextval('tbl_user_user_id_seq'::regclass) NOT NULL,
    project_id VARCHAR(100),
    role_id INTEGER NOT NULL,
    username VARCHAR(100) NOT NULL,
    password VARCHAR(255) NOT NULL,
    name VARCHAR(50) NOT NULL,
    surname VARCHAR(50) DEFAULT ''::character varying NOT NULL,
    created_date DATE DEFAULT CURRENT_DATE NOT NULL,
    acc_status_id INTEGER NOT NULL,
    is_deleted BOOLEAN DEFAULT false NOT NULL,
    deleted_at TIMESTAMP WITH TIME ZONE,
    failed_attempts INTEGER DEFAULT 0 NOT NULL,
    locked_until TIMESTAMP WITH TIME ZONE,
    must_change_password BOOLEAN DEFAULT false NOT NULL,
    daily_cap NUMERIC,
    CONSTRAINT tbl_user_pkey PRIMARY KEY (user_id),
    CONSTRAINT tbl_user_daily_cap_nonneg CHECK (daily_cap IS NULL OR daily_cap >= 0::numeric)
);

CREATE TABLE IF NOT EXISTS tbl_user_role (
    role_id INTEGER NOT NULL,
    role_des VARCHAR(100) NOT NULL,
    CONSTRAINT tbl_user_role_pkey PRIMARY KEY (role_id)
);

-- ── Foreign keys ────────────────────────────────────────────────────
ALTER TABLE tbl_user
    ADD CONSTRAINT tbl_user_role_id_fkey
    FOREIGN KEY (role_id) REFERENCES tbl_user_role(role_id);
ALTER TABLE tbl_user
    ADD CONSTRAINT tbl_user_acc_status_id_fkey
    FOREIGN KEY (acc_status_id) REFERENCES tbl_acc_status(acc_status_id);
ALTER TABLE tbl_user
    ADD CONSTRAINT tbl_user_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES tbl_project(project_id)
    ON UPDATE CASCADE;
ALTER TABLE tbl_chat_message
    ADD CONSTRAINT tbl_chat_message_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES tbl_chat_session(session_id)
    ON DELETE CASCADE;
ALTER TABLE tbl_balance
    ADD CONSTRAINT tbl_balance_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES tbl_project(project_id)
    ON UPDATE CASCADE;
ALTER TABLE tbl_credits
    ADD CONSTRAINT tbl_credits_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES tbl_user(user_id);
ALTER TABLE tbl_credits
    ADD CONSTRAINT tbl_credits_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES tbl_balance(project_id)
    ON UPDATE CASCADE;
ALTER TABLE tbl_audit_log
    ADD CONSTRAINT tbl_audit_log_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES tbl_user(user_id);
ALTER TABLE tbl_action_admin
    ADD CONSTRAINT tbl_action_admin_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES tbl_user(user_id);
ALTER TABLE tbl_session
    ADD CONSTRAINT tbl_session_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES tbl_user(user_id)
    ON DELETE CASCADE;
ALTER TABLE tbl_chat_session
    ADD CONSTRAINT tbl_chat_session_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES tbl_user(user_id)
    ON DELETE CASCADE;
ALTER TABLE tbl_topup_history
    ADD CONSTRAINT tbl_topup_history_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES tbl_project(project_id)
    ON UPDATE CASCADE;
ALTER TABLE tbl_topup_history
    ADD CONSTRAINT tbl_topup_history_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES tbl_user(user_id);
ALTER TABLE tbl_response
    ADD CONSTRAINT tbl_response_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES tbl_user(user_id)
    ON DELETE SET NULL;
ALTER TABLE tbl_response
    ADD CONSTRAINT tbl_response_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES tbl_project(project_id)
    ON UPDATE CASCADE;

-- ── Indexes (non-PK) ────────────────────────────────────────────────
CREATE INDEX idx_action_admin_target ON public.tbl_action_admin USING btree (target_type, target_id) WHERE (target_type IS NOT NULL);
CREATE INDEX idx_action_admin_type ON public.tbl_action_admin USING btree (action_type) WHERE (action_type IS NOT NULL);
CREATE INDEX idx_action_admin_user_date ON public.tbl_action_admin USING btree (user_id, edit_date DESC);
CREATE INDEX idx_action_admin_user_time ON public.tbl_action_admin USING btree (user_id, edit_time DESC);
CREATE INDEX idx_audit_log_event ON public.tbl_audit_log USING btree (event_type, log_in_date DESC) WHERE (event_type IS NOT NULL);
CREATE INDEX idx_audit_log_user_time ON public.tbl_audit_log USING btree (user_id, log_in_time DESC);
CREATE INDEX idx_chat_message_session_created ON public.tbl_chat_message USING btree (session_id, created_at);
CREATE INDEX idx_chat_session_user_updated ON public.tbl_chat_session USING btree (user_id, updated_at DESC) WHERE (is_deleted = false);
CREATE INDEX idx_credits_project ON public.tbl_credits USING btree (project_id);
CREATE INDEX idx_project_active ON public.tbl_project USING btree (project_id) WHERE (is_deleted = false);
CREATE UNIQUE INDEX ux_tbl_project_openai_project_id ON public.tbl_project USING btree (openai_project_id) WHERE (openai_project_id IS NOT NULL);
CREATE INDEX idx_response_project_created ON public.tbl_response USING btree (project_id, created_at DESC);
CREATE INDEX idx_response_user_created ON public.tbl_response USING btree (user_id, created_at DESC);
CREATE INDEX idx_session_expires ON public.tbl_session USING btree (expires_at);
CREATE INDEX idx_session_user ON public.tbl_session USING btree (user_id);
CREATE INDEX ix_topup_project_time ON public.tbl_topup_history USING btree (project_id, created_at DESC);
CREATE INDEX ix_topup_user_time ON public.tbl_topup_history USING btree (user_id, created_at DESC);
CREATE INDEX idx_user_active ON public.tbl_user USING btree (user_id) WHERE (is_deleted = false);
CREATE INDEX idx_user_locked ON public.tbl_user USING btree (locked_until) WHERE (locked_until IS NOT NULL);
CREATE INDEX idx_user_project ON public.tbl_user USING btree (project_id);
CREATE UNIQUE INDEX tbl_user_username_uniq ON public.tbl_user USING btree (username);

-- ── Lookup seed data ────────────────────────────────────────────────
INSERT INTO tbl_acc_status (acc_status_id, acc_status) VALUES (1, 'active') ON CONFLICT DO NOTHING;
INSERT INTO tbl_acc_status (acc_status_id, acc_status) VALUES (2, 'inactive') ON CONFLICT DO NOTHING;
INSERT INTO tbl_acc_status (acc_status_id, acc_status) VALUES (3, 'locked') ON CONFLICT DO NOTHING;
INSERT INTO tbl_user_role (role_id, role_des) VALUES (1, 'admin') ON CONFLICT DO NOTHING;
INSERT INTO tbl_user_role (role_id, role_des) VALUES (2, 'general user') ON CONFLICT DO NOTHING;
