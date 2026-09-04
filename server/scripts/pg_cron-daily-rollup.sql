-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║  pg_cron — Daily rollup of tbl_daily_usage at 00:30 (Asia/Bangkok)      ║
-- ║  Runs sp_refresh_daily_usage() for YESTERDAY, every day.                ║
-- ╚═══════════════════════════════════════════════════════════════════════╝
--
-- ⚠️  FOR THE DBA — this is NOT a normal migration. It is NOT run by
--     migrate-schema.js on boot (pg_cron is a server-admin install, not an
--     idempotent app migration). Apply it MANUALLY once, by a superuser,
--     after pg_cron is installed.
--
-- WHAT IT DOES
--   At 00:30 Bangkok time it calls sp_refresh_daily_usage(yesterday, yesterday),
--   which re-aggregates tbl_response → tbl_daily_usage for the day that just
--   ended. Idempotent (ON CONFLICT DO UPDATE) — safe to re-run / catch up.
--
-- ───────────────────────────────────────────────────────────────────────────
-- PREREQUISITES (one-time, requires OS access + a PostgreSQL restart)
-- ───────────────────────────────────────────────────────────────────────────
--   1. Install the pg_cron binary for PostgreSQL 18 on the DB host
--      (<DB_HOST>). e.g. on Debian/Ubuntu:
--          apt-get install postgresql-18-cron
--
--   2. Edit postgresql.conf:
--          shared_preload_libraries = 'pg_cron'   -- add pg_cron to the list
--          cron.database_name = 'OpenAI_DB'       -- run jobs IN our DB
--          cron.timezone = 'Asia/Bangkok'         -- so '30 0' means 00:30 local
--
--   3. Restart PostgreSQL  (pg_cron only loads at startup).
--
-- Verify the prerequisites are met (should all return rows / expected values):
--      SELECT * FROM pg_available_extensions WHERE name = 'pg_cron';
--      SHOW shared_preload_libraries;     -- must include pg_cron
--      SHOW cron.database_name;           -- should be OpenAI_DB
--      SHOW cron.timezone;                -- should be Asia/Bangkok
--
-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — enable the extension (run as superuser, in OpenAI_DB)
-- ───────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — schedule the daily job
-- ───────────────────────────────────────────────────────────────────────────
-- The command computes "yesterday" in Bangkok explicitly, so it is correct
-- no matter what session timezone the cron worker happens to use.
--
-- (A) If cron.timezone = 'Asia/Bangkok'  →  schedule literally at 00:30:
SELECT cron.schedule(
    'daily-usage-rollup',                 -- job name (unique)
    '30 0 * * *',                         -- 00:30 every day (Bangkok)
    $job$
        CALL sp_refresh_daily_usage(
            ((now() AT TIME ZONE 'Asia/Bangkok')::date - 1),
            ((now() AT TIME ZONE 'Asia/Bangkok')::date - 1)
        );
    $job$
);

-- (B) FALLBACK — if you CANNOT set cron.timezone (it stays the default 'GMT'),
--     comment out (A) above and use this instead. 00:30 Bangkok = 17:30 GMT
--     the previous calendar day:
-- SELECT cron.schedule(
--     'daily-usage-rollup',
--     '30 17 * * *',                      -- 17:30 GMT == 00:30 Bangkok (next day)
--     $job$
--         CALL sp_refresh_daily_usage(
--             ((now() AT TIME ZONE 'Asia/Bangkok')::date - 1),
--             ((now() AT TIME ZONE 'Asia/Bangkok')::date - 1)
--         );
--     $job$
-- );

-- If the job already exists and you only want to change it, cron.schedule with
-- the SAME name overwrites it (pg_cron 1.4+). Otherwise unschedule first (below).

-- ───────────────────────────────────────────────────────────────────────────
-- VERIFY
-- ───────────────────────────────────────────────────────────────────────────
--   SELECT jobid, jobname, schedule, command, active
--     FROM cron.job WHERE jobname = 'daily-usage-rollup';
--
--   -- after it has run at least once, inspect history:
--   SELECT jobid, runid, status, return_message, start_time, end_time
--     FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='daily-usage-rollup')
--    ORDER BY start_time DESC LIMIT 10;

-- ───────────────────────────────────────────────────────────────────────────
-- MANUAL TEST (run any time, does not wait for 00:30)
-- ───────────────────────────────────────────────────────────────────────────
--   CALL sp_refresh_daily_usage(
--       ((now() AT TIME ZONE 'Asia/Bangkok')::date - 1),
--       ((now() AT TIME ZONE 'Asia/Bangkok')::date - 1)
--   );
--   SELECT * FROM tbl_daily_usage ORDER BY usage_date DESC, user_id;

-- ───────────────────────────────────────────────────────────────────────────
-- ROLLBACK / REMOVE THE JOB
-- ───────────────────────────────────────────────────────────────────────────
--   SELECT cron.unschedule('daily-usage-rollup');
