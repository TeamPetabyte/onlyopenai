// Schema migration runner: applies server/migrations/*.sql in lexical order, recording each
// file's SHA-256 in _meta.schema_migrations. Idempotent; runs on boot and via `npm run migrate [--status]`.
// An already-applied file that was edited warns but is not re-run — add a new migration instead.

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Bookkeeping lives in a dedicated _meta schema, out of the public tbl_* listing.
// The DO block moves a legacy public.schema_migrations there on first boot.
const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS _meta;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name='schema_migrations')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_schema='_meta'  AND table_name='schema_migrations') THEN
        ALTER TABLE public.schema_migrations SET SCHEMA _meta;
        RAISE NOTICE '  ✔ moved public.schema_migrations → _meta.schema_migrations';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS _meta.schema_migrations (
    filename    VARCHAR(255) PRIMARY KEY,
    sha256      VARCHAR(64)  NOT NULL,
    applied_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    duration_ms INTEGER      NOT NULL DEFAULT 0
);
`;

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

// Normalize to LF before hashing so git autocrlf cannot change the hash.
function normalizeEol(s) {
    return s.replace(/\r\n/g, '\n');
}

function contentHash(body) {
    return sha256(normalizeEol(body));
}

// True when the recorded hash matches this content under either line-ending style.
function matchesAnyEolVariant(recorded, body) {
    const lf = normalizeEol(body);
    return recorded === sha256(lf) ||
           recorded === sha256(lf.replace(/\n/g, '\r\n'));
}

function listMigrationFiles() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    return fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();
}

async function getApplied(client) {
    const r = await client.query(
        'SELECT filename, sha256 FROM _meta.schema_migrations ORDER BY filename');
    const map = new Map();
    for (const row of r.rows) map.set(row.filename, row.sha256);
    return map;
}

async function applyOne(client, filename) {
    const full = path.join(MIGRATIONS_DIR, filename);
    const body = fs.readFileSync(full, 'utf8');
    const hash = contentHash(body);
    const t0   = Date.now();
    // Migration files carry their own BEGIN/COMMIT; run as-is, record after.
    await client.query(body);
    const dur = Date.now() - t0;
    await client.query(
        `INSERT INTO _meta.schema_migrations (filename, sha256, duration_ms)
         VALUES ($1, $2, $3)
         ON CONFLICT (filename) DO NOTHING`,
        [filename, hash, dur]);
    return dur;
}

function ensurePool(pool) {
    if (pool) return { pool, own: false };
    const own = new Pool({
        host:     process.env.DB_HOST || 'localhost',
        port:     parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || 'petabyte_ai',
        user:     process.env.DB_USER || 'postgres',
        password: process.env.DB_PASS || '',
    });
    return { pool: own, own: true };
}

/**
 * Run every pending migration. Returns { applied, skipped, modified }.
 * Throws on any SQL error.
 */
async function runMigrations(poolIn) {
    const { pool, own } = ensurePool(poolIn);
    const stats = { applied: [], skipped: [], modified: [] };
    const client = await pool.connect();
    try {
        await client.query(BOOTSTRAP_SQL);
        const applied = await getApplied(client);
        const files   = listMigrationFiles();

        for (const f of files) {
            const body = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
            const hash = contentHash(body);
            const prev = applied.get(f);

            if (prev === undefined) {
                console.log(`[migrate] apply ${f} ...`);
                const dur = await applyOne(client, f);
                console.log(`[migrate]   ✓ ${f} (${dur} ms)`);
                stats.applied.push(f);
            } else if (prev !== hash) {
                // Rows recorded before EOL-normalized hashing may differ only by line endings;
                // converge them to the normalized hash instead of warning.
                if (matchesAnyEolVariant(prev, body)) {
                    await client.query(
                        'UPDATE _meta.schema_migrations SET sha256=$1 WHERE filename=$2',
                        [hash, f]);
                    console.log(`[migrate] ✓ ${f} re-recorded (line-ending drift only, SQL unchanged)`);
                    stats.skipped.push(f);
                } else {
                    console.warn(`[migrate] ⚠  ${f} has been MODIFIED since it was applied`);
                    console.warn(`[migrate]   recorded: ${prev.slice(0, 12)}...`);
                    console.warn(`[migrate]   now:      ${hash.slice(0, 12)}...`);
                    console.warn(`[migrate]   (not re-running — add a NEW migration file instead)`);
                    stats.modified.push(f);
                }
            } else {
                stats.skipped.push(f);
            }
        }
    } finally {
        client.release();
        if (own) await pool.end().catch(() => {});
    }

    const total = stats.applied.length + stats.skipped.length + stats.modified.length;
    console.log(
        `[migrate] ${stats.applied.length} applied, ${stats.skipped.length} up-to-date` +
        (stats.modified.length ? `, ${stats.modified.length} MODIFIED` : '') +
        ` (${total} total)`);
    return stats;
}

/** Status-only (no changes). Returns {applied, pending, modified}. */
async function migrationStatus(poolIn) {
    const { pool, own } = ensurePool(poolIn);
    const client = await pool.connect();
    const out = { applied: [], pending: [], modified: [] };
    try {
        await client.query(BOOTSTRAP_SQL);
        const applied = await getApplied(client);
        const files   = listMigrationFiles();
        for (const f of files) {
            const body = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
            const hash = contentHash(body);
            if (!applied.has(f))              out.pending.push(f);
            else if (applied.get(f) !== hash &&
                     !matchesAnyEolVariant(applied.get(f), body)) out.modified.push(f);
            else                               out.applied.push(f);
        }
    } finally {
        client.release();
        if (own) await pool.end().catch(() => {});
    }
    return out;
}

if (require.main === module) {
    require('dotenv').config();
    (async () => {
        if (process.argv.includes('--status')) {
            const s = await migrationStatus();
            console.log('\nMigrations status:');
            console.log(`  ✓ applied  (${s.applied.length}): ${s.applied.join(', ') || '(none)'}`);
            console.log(`  • pending  (${s.pending.length}): ${s.pending.join(', ') || '(none)'}`);
            if (s.modified.length)
                console.log(`  ⚠ modified (${s.modified.length}): ${s.modified.join(', ')}`);
            process.exit(0);
        }
        try {
            const s = await runMigrations();
            process.exit(s.modified.length ? 2 : 0);
        } catch (e) {
            console.error('[migrate] ✗ FAILED:', e.message);
            process.exit(1);
        }
    })();
}

module.exports = { runMigrations, migrationStatus };
