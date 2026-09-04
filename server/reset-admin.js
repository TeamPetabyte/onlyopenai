// ╔═══════════════════════════════════════════════════════════╗
// ║ Phase 11 — reset-admin CLI                                ║
// ╚═══════════════════════════════════════════════════════════╝
// Emergency tool. Resets the 'admin' account when nobody knows the
// password any more:
//   - bcrypts a new password (default: admin123)
//   - clears failed_attempts + locked_until
//   - sets must_change_password=TRUE so the next login forces a reset
//   - drops every active session for admin (Phase 7 table)
//
// Usage:
//   node reset-admin.js                       # → admin / admin123
//   node reset-admin.js --password "MyNew!1"  # → admin / MyNew!1
//   node reset-admin.js --user alice          # reset a different username
//   node reset-admin.js --list                # just list admins, do nothing
//
// Intentionally does NOT read interactive tty — this is run by ops
// non-interactively (e.g. via kubectl exec). Keep it to --flags.

'use strict';

require('dotenv').config();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    if (i === -1) return fallback;
    return process.argv[i + 1];
}
function flag(name) { return process.argv.includes(name); }

const USER_TO_RESET = arg('--user', 'admin');
const NEW_PASSWORD  = arg('--password', 'admin123');
const LIST_ONLY     = flag('--list');
const HELP          = flag('--help') || flag('-h');

if (HELP) {
    console.log(`Usage: node reset-admin.js [options]

  --user <name>       account to reset (default: admin)
  --password <pw>     new password in clear text (default: admin123)
  --list              list admin accounts and exit, change nothing
  --show              print the new password to stdout (off by default — service logs keep stdout)
  --help, -h          this text

Env: DB_HOST DB_PORT DB_NAME DB_USER DB_PASS (from .env)`);
    process.exit(0);
}

const pool = new Pool({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'petabyte_ai',
    user:     process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
});

(async () => {
    const client = await pool.connect();
    try {
        // --list path: dump every admin-role account
        if (LIST_ONLY) {
            const r = await client.query(`
                SELECT u.user_id, u.username, u.acc_status_id,
                       u.failed_attempts, u.locked_until, u.must_change_password,
                       s.acc_status, r.role_des
                FROM tbl_user u
                JOIN tbl_user_role r   ON r.role_id = u.role_id
                JOIN tbl_acc_status s  ON s.acc_status_id = u.acc_status_id
                WHERE r.role_des = 'admin' AND u.is_deleted = FALSE
                ORDER BY u.user_id
            `);
            console.log(`Admin accounts (${r.rows.length}):`);
            for (const a of r.rows) {
                console.log(`  #${a.user_id}  ${a.username.padEnd(20)}` +
                    `  status=${a.acc_status}` +
                    `  failed=${a.failed_attempts}` +
                    `  locked_until=${a.locked_until || '—'}` +
                    `  must_change=${a.must_change_password}`);
            }
            process.exit(0);
        }

        // Sanity: does the target exist?
        const u = await client.query(
            `SELECT u.user_id, u.username, r.role_des
             FROM tbl_user u
             JOIN tbl_user_role r ON r.role_id = u.role_id
             WHERE u.username = $1 AND u.is_deleted = FALSE`,
            [USER_TO_RESET]);
        if (u.rows.length === 0) {
            console.error(`[reset-admin] ✗ no active user with username='${USER_TO_RESET}'`);
            process.exit(1);
        }
        const userId = u.rows[0].user_id;
        const role   = u.rows[0].role_des;

        console.log(`[reset-admin] target: #${userId} ${USER_TO_RESET} (role=${role})`);

        // hash + update + unlock
        const hash = await bcrypt.hash(NEW_PASSWORD, 12);
        await client.query('BEGIN');
        await client.query(
            `UPDATE tbl_user
             SET password             = $1,
                 failed_attempts      = 0,
                 locked_until         = NULL,
                 must_change_password = TRUE,
                 acc_status_id        = 1                 -- active
             WHERE user_id = $2`,
            [hash, userId]);

        // Phase 7: kill every active session for this user so a stale
        // token can't keep working with the old identity.
        const killed = await client.query(
            `DELETE FROM tbl_session WHERE user_id = $1 RETURNING token`,
            [userId]);
        await client.query('COMMIT');

        console.log(`[reset-admin] ✓ password reset for ${USER_TO_RESET}`);
        console.log(`[reset-admin] ✓ unlocked (failed_attempts=0, locked_until=NULL)`);
        console.log(`[reset-admin] ✓ must_change_password = TRUE (forces reset on login)`);
        console.log(`[reset-admin] ✓ revoked ${killed.rowCount} active session(s)`);
        console.log('');
        // stdout ของ service ถูกเก็บเป็นไฟล์ (nssm) — รหัสจึงพิมพ์ต่อเมื่อสั่ง --show เท่านั้น
        if (flag('--show')) console.log(`   Login with:  ${USER_TO_RESET} / ${NEW_PASSWORD}`);
        else console.log(`   Login with:  ${USER_TO_RESET} / (รหัสที่ส่งมาทาง --password; ใช้ --show เพื่อพิมพ์ออกมา)`);
        console.log('   …then change the password immediately.');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[reset-admin] ✗', e.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
})();
