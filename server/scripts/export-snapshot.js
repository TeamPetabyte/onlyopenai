// ╔═══════════════════════════════════════════════════════════╗
// ║ PetabyteAi — full-DB snapshot exporter (no pg_dump needed) ║
// ╚═══════════════════════════════════════════════════════════╝
// Dumps every table in the `public` schema to a single timestamped
// JSON file so test data can be kept and reviewed later. Read-only on
// the DB — it only SELECTs. Uses the `pg` dependency already installed.
//
// Usage (from server/):
//   node scripts/export-snapshot.js                 # → ~/Desktop/petabyte-backups/
//   node scripts/export-snapshot.js --out /some/dir # custom output dir
//
// Env: DB_HOST DB_PORT DB_NAME DB_USER DB_PASS (from server/.env)

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// load .env from the server/ dir regardless of cwd
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

function arg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : process.argv[i + 1];
}

const OUT_DIR = arg('--out', path.join(os.homedir(), 'Desktop', 'petabyte-backups'));

const pool = new Pool({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'petabyte_ai',
    user:     process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
});

function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

(async () => {
    const client = await pool.connect();
    try {
        const dbName = process.env.DB_NAME;
        const tablesRes = await client.query(`
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY tablename`);
        const tables = tablesRes.rows.map(r => r.tablename);

        const snapshot = { exportedAt: new Date().toISOString(), database: dbName, tables: {} };
        const summary = [];

        for (const t of tables) {
            // quote the identifier to be safe with mixed-case / reserved names
            const rows = (await client.query(`SELECT * FROM "${t}"`)).rows;
            snapshot.tables[t] = rows;
            summary.push({ table: t, rows: rows.length });
        }

        if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
        const file = path.join(OUT_DIR, `${dbName}_snapshot_${stamp()}.json`);
        fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');

        console.log(`[snapshot] database: ${dbName}`);
        console.log(`[snapshot] tables  : ${tables.length}`);
        for (const s of summary) console.log(`             ${String(s.rows).padStart(7)}  ${s.table}`);
        const kb = (fs.statSync(file).size / 1024).toFixed(0);
        console.log(`[snapshot] ✓ wrote ${file}  (${kb} KB)`);
    } catch (e) {
        console.error('[snapshot] ✗', e.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
})();
