-- Phase 57: database-side hardening from the 2026-09-04 code review (PTB-CR-FR-2026-001).
--
-- 1. PTB-FND-001 — the bootstrap admin was seeded with a documented password
--    (admin123) and later promoted to trainer (superadmin). Any account still
--    carrying that exact hash has never had its password changed. We cannot
--    choose a new password for it, so it is set inactive and flagged; ops sets a
--    real one with `node reset-admin.js` (which no longer has a default password
--    either, and re-activates the account). On a DB where the password was
--    already changed this is a no-op.
--
-- 2. PTB-FND-023 — two quota requests from the same user could be created in
--    parallel because the "already pending" check was read-then-insert. Older
--    duplicates are cancelled (keeping the newest) so the partial unique index
--    can be created on any live DB; routes/quota.js maps 23505 to a 409.
--
-- 3. PTB-FND-040 — tbl_action_admin (what admins did) and tbl_audit_log (who
--    logged in) had no protection against UPDATE/DELETE. The application only
--    ever UPDATEs tbl_audit_log to stamp log_out_date/log_out_time on a row
--    (routes/auth.js: logout stamp and the zombie sweep at login), so that
--    single shape is allowed; everything else is refused by trigger.
--    tbl_action_admin is append-only outright.

-- 1 ── retire the default admin password ───────────────────────────────
UPDATE tbl_user
   SET acc_status_id        = 2,          -- inactive until a real password is set
       must_change_password = TRUE,
       locked_until         = NULL
 WHERE password = '$2b$10$K9KYIqxL58W0sX6wf5Rq/eQROdFg5mfxnuWD2surPnDXEgaDjpWGS'
   AND is_deleted = FALSE;

DELETE FROM tbl_session
 WHERE user_id IN (
    SELECT user_id FROM tbl_user
     WHERE password = '$2b$10$K9KYIqxL58W0sX6wf5Rq/eQROdFg5mfxnuWD2surPnDXEgaDjpWGS');

-- 2 ── one pending quota request per user ───────────────────────────────
UPDATE tbl_quota_request q
   SET status        = 'cancelled',
       resolved_at   = now(),
       resolved_note = 'superseded by a newer pending request (phase57-001 de-duplication)'
 WHERE q.status = 'pending'
   AND EXISTS (SELECT 1 FROM tbl_quota_request n
                WHERE n.user_id = q.user_id AND n.status = 'pending'
                  AND n.request_id > q.request_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_quota_request_one_pending
    ON tbl_quota_request (user_id)
 WHERE status = 'pending';

-- 3 ── audit tables cannot be rewritten ─────────────────────────────────
CREATE OR REPLACE FUNCTION trg_audit_log_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'tbl_audit_log is append-only (PTB-FND-040)';
    END IF;
    -- The only permitted change is stamping the logout time on a row that
    -- has none yet. Every other column must be identical.
    IF NEW.id            IS DISTINCT FROM OLD.id
    OR NEW.user_id       IS DISTINCT FROM OLD.user_id
    OR NEW.log_in_date   IS DISTINCT FROM OLD.log_in_date
    OR NEW.log_in_time   IS DISTINCT FROM OLD.log_in_time
    OR NEW.event_type    IS DISTINCT FROM OLD.event_type
    OR NEW.detail        IS DISTINCT FROM OLD.detail
    OR NEW.ip            IS DISTINCT FROM OLD.ip
    OR OLD.log_out_time  IS NOT NULL THEN
        RAISE EXCEPTION 'tbl_audit_log rows may only receive a logout stamp (PTB-FND-040)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_guard ON tbl_audit_log;
CREATE TRIGGER audit_log_guard
    BEFORE UPDATE OR DELETE ON tbl_audit_log
    FOR EACH ROW EXECUTE FUNCTION trg_audit_log_guard();

CREATE OR REPLACE FUNCTION trg_action_admin_guard() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'tbl_action_admin is append-only (PTB-FND-040)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS action_admin_guard ON tbl_action_admin;
CREATE TRIGGER action_admin_guard
    BEFORE UPDATE OR DELETE ON tbl_action_admin
    FOR EACH ROW EXECUTE FUNCTION trg_action_admin_guard();
