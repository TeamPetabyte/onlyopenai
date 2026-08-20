-- Phase 44: let a deleted user's name be used again.
--
-- Deleting a user is a soft delete — is_deleted flips to TRUE and the row
-- stays, which is what keeps their history, costs and audit trail readable.
-- But phase11-001 put a plain UNIQUE index on username covering every row,
-- deleted or not, so the name stayed permanently reserved by an account
-- nobody can log into. Recreating "soraya" after deleting her failed, and the
-- workaround was to create "soraya2".
--
-- The index becomes partial: unique among ACTIVE users only. A deleted row and
-- a new active row may then share a name, which is safe here because exactly
-- one query in the codebase looks a user up by username — the login at
-- server.js — and it already filters `AND u.is_deleted = FALSE`. Everywhere
-- else joins on user_id. Verified before writing this, not assumed.
--
-- Keeps the original index name so phase11-001's "already has UNIQUE(username)"
-- guard still recognises it and stays a no-op.
--
-- After this, "uma" and "soraya" are available again. Renaming soraya2 back to
-- soraya is a separate decision and is deliberately not done here.

DO $$
DECLARE
    v_def TEXT;
BEGIN
    SELECT indexdef INTO v_def
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename  = 'tbl_user'
       AND indexname  = 'tbl_user_username_uniq';

    IF v_def IS NULL THEN
        CREATE UNIQUE INDEX tbl_user_username_uniq
            ON tbl_user (username) WHERE is_deleted = FALSE;
        RAISE NOTICE '  + partial UNIQUE(username) created';

    ELSIF v_def ILIKE '%WHERE%is_deleted%' THEN
        RAISE NOTICE '  • already partial — skipping';

    ELSE
        -- A name held by two ACTIVE users would break the new index. The old
        -- index made that impossible, but check rather than trust it.
        IF EXISTS (
            SELECT 1 FROM tbl_user
             WHERE is_deleted = FALSE
             GROUP BY username HAVING count(*) > 1
        ) THEN
            RAISE EXCEPTION 'duplicate username among active users — resolve before rerunning';
        END IF;

        DROP INDEX tbl_user_username_uniq;
        CREATE UNIQUE INDEX tbl_user_username_uniq
            ON tbl_user (username) WHERE is_deleted = FALSE;
        RAISE NOTICE '  ~ UNIQUE(username) is now active-users-only';
    END IF;
END $$;
