// Schema dump utility: reads every tbl_* definition from information_schema and emits an
// idempotent CREATE TABLE … IF NOT EXISTS migration (parents first, FKs after, no data).
//   node dump-schema.js > migrations/phase0-000-initial-schema.sql

'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'petabyte_ai',
    user:     process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
});

// business tables only (tbl_*); _meta.schema_migrations is bookkeeping, not schema
const TABLE_FILTER = `
    table_name LIKE 'tbl\\_%' ESCAPE '\\'
    AND table_schema = 'public'
`;

async function listTables(client) {
    const r = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE ${TABLE_FILTER}
        ORDER BY table_name
    `);
    return r.rows.map(x => x.table_name);
}

async function getColumns(client, table) {
    const r = await client.query(`
        SELECT column_name, data_type, character_maximum_length, numeric_precision,
               numeric_scale, is_nullable, column_default, udt_name
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1
        ORDER BY ordinal_position
    `, [table]);
    return r.rows;
}

async function getPrimaryKey(client, table) {
    const r = await client.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema    = kcu.table_schema
        WHERE tc.table_schema='public'
          AND tc.table_name=$1
          AND tc.constraint_type='PRIMARY KEY'
        ORDER BY kcu.ordinal_position
    `, [table]);
    return r.rows.map(x => x.column_name);
}

async function getUniques(client, table) {
    const r = await client.query(`
        SELECT tc.constraint_name, kcu.column_name, kcu.ordinal_position
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema    = kcu.table_schema
        WHERE tc.table_schema='public'
          AND tc.table_name=$1
          AND tc.constraint_type='UNIQUE'
        ORDER BY tc.constraint_name, kcu.ordinal_position
    `, [table]);
    const out = new Map();
    for (const row of r.rows) {
        if (!out.has(row.constraint_name)) out.set(row.constraint_name, []);
        out.get(row.constraint_name).push(row.column_name);
    }
    return out;
}

async function getForeignKeys(client, table) {
    const r = await client.query(`
        SELECT tc.constraint_name,
               kcu.column_name AS src_col,
               ccu.table_name  AS dst_table,
               ccu.column_name AS dst_col,
               rc.delete_rule,
               rc.update_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema    = kcu.table_schema
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_name = tc.constraint_name
         AND rc.constraint_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = rc.unique_constraint_name
         AND ccu.constraint_schema = rc.unique_constraint_schema
        WHERE tc.table_schema='public'
          AND tc.table_name=$1
          AND tc.constraint_type='FOREIGN KEY'
        ORDER BY tc.constraint_name, kcu.ordinal_position
    `, [table]);
    return r.rows;
}

async function getIndexes(client, table) {
    // non-PK, non-UNIQUE indexes we should carry over
    const r = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname='public' AND tablename=$1
        ORDER BY indexname
    `, [table]);
    return r.rows;
}

function formatType(col) {
    const t = (col.data_type || '').toLowerCase();
    const udt = (col.udt_name || '').toLowerCase();
    if (t === 'character varying') return `VARCHAR(${col.character_maximum_length || 255})`;
    if (t === 'character')         return `CHAR(${col.character_maximum_length || 1})`;
    if (t === 'numeric')           return `NUMERIC(${col.numeric_precision || 10},${col.numeric_scale || 0})`;
    if (t === 'integer')           return 'INTEGER';
    if (t === 'bigint')            return 'BIGINT';
    if (t === 'smallint')          return 'SMALLINT';
    if (t === 'boolean')           return 'BOOLEAN';
    if (t === 'text')              return 'TEXT';
    if (t === 'jsonb')             return 'JSONB';
    if (t === 'json')              return 'JSON';
    if (t === 'timestamp with time zone')    return 'TIMESTAMPTZ';
    if (t === 'timestamp without time zone') return 'TIMESTAMP';
    if (t === 'date')              return 'DATE';
    if (t === 'uuid')              return 'UUID';
    // fallback to udt
    return udt.toUpperCase();
}

function columnLine(col) {
    // detect serial by default nextval('…_seq'::regclass)
    const dflt = col.column_default || '';
    const isSerial =
        /^nextval\('[^']+'::regclass\)/i.test(dflt) &&
        (col.data_type === 'integer' || col.data_type === 'bigint');
    let type;
    if (isSerial) {
        type = col.data_type === 'bigint' ? 'BIGSERIAL' : 'SERIAL';
    } else {
        type = formatType(col);
    }
    let line = `    ${col.column_name.padEnd(24)} ${type}`;
    if (!isSerial && col.column_default) {
        // sanitise obvious things
        line += ` DEFAULT ${col.column_default}`;
    }
    if (col.is_nullable === 'NO') line += ' NOT NULL';
    return line;
}

function sortByDependency(tables, fksByTable) {
    // simple topological sort: table comes after everything it FKs to
    const remaining = new Set(tables);
    const out = [];
    // safety cap
    for (let pass = 0; pass < tables.length + 2 && remaining.size; pass++) {
        for (const t of [...remaining]) {
            const fks = fksByTable.get(t) || [];
            const blockedBy = fks
                .map(f => f.dst_table)
                .filter(d => d !== t && remaining.has(d));
            if (blockedBy.length === 0) {
                out.push(t);
                remaining.delete(t);
            }
        }
    }
    // cycles — append whatever is left
    for (const t of remaining) out.push(t);
    return out;
}

(async () => {
    const client = await pool.connect();
    try {
        const tables = await listTables(client);
        if (tables.length === 0) {
            console.error('[dump-schema] no tbl_* tables found — is DB_HOST/DB_NAME correct?');
            process.exit(2);
        }
        process.stderr.write(`[dump-schema] found ${tables.length} tables: ${tables.join(', ')}\n`);

        const cols     = new Map();
        const pks      = new Map();
        const uniqs    = new Map();
        const fks      = new Map();
        const idx      = new Map();
        for (const t of tables) {
            cols.set(t, await getColumns(client, t));
            pks.set(t,  await getPrimaryKey(client, t));
            uniqs.set(t, await getUniques(client, t));
            fks.set(t,  await getForeignKeys(client, t));
            idx.set(t,  await getIndexes(client, t));
        }
        const ordered = sortByDependency(tables, fks);

        // header
        const out = [];
        out.push('-- ╔═══════════════════════════════════════════════════════════╗');
        out.push('-- ║ Phase 0 — Initial schema (auto-generated by dump-schema)  ║');
        out.push('-- ╚═══════════════════════════════════════════════════════════╝');
        out.push('-- Generated: ' + new Date().toISOString());
        out.push('-- Source: live DB (' + (process.env.DB_HOST || 'localhost') + '/' + (process.env.DB_NAME || 'petabyte_ai') + ')');
        out.push('-- All statements are IF NOT EXISTS; safe to re-run.');
        out.push('');
        out.push('BEGIN;');
        out.push('');

        // CREATE TABLE without FKs (added after)
        for (const t of ordered) {
            out.push(`-- ── ${t} ` + '─'.repeat(Math.max(0, 56 - t.length)));
            out.push(`CREATE TABLE IF NOT EXISTS ${t} (`);
            const lines = cols.get(t).map(columnLine);
            const pk = pks.get(t);
            if (pk.length) {
                lines.push(`    PRIMARY KEY (${pk.join(', ')})`);
            }
            for (const [cname, ccols] of uniqs.get(t)) {
                lines.push(`    CONSTRAINT ${cname} UNIQUE (${ccols.join(', ')})`);
            }
            out.push(lines.join(',\n'));
            out.push(');');
            out.push('');
        }

        // FKs via DO $$ IF NOT EXISTS
        out.push('-- ── Foreign keys ───────────────────────────────────────────');
        for (const t of ordered) {
            for (const fk of fks.get(t)) {
                out.push(`DO $$ BEGIN`);
                out.push(`    IF NOT EXISTS (`);
                out.push(`        SELECT 1 FROM information_schema.table_constraints`);
                out.push(`        WHERE table_name='${t}' AND constraint_name='${fk.constraint_name}'`);
                out.push(`    ) THEN`);
                out.push(`        ALTER TABLE ${t}`);
                out.push(`            ADD CONSTRAINT ${fk.constraint_name}`);
                out.push(`            FOREIGN KEY (${fk.src_col})`);
                out.push(`            REFERENCES ${fk.dst_table}(${fk.dst_col})`);
                if (fk.delete_rule && fk.delete_rule !== 'NO ACTION')
                    out.push(`            ON DELETE ${fk.delete_rule}`);
                if (fk.update_rule && fk.update_rule !== 'NO ACTION')
                    out.push(`            ON UPDATE ${fk.update_rule}`);
                out.push(`        ;`);
                out.push(`    END IF;`);
                out.push(`END $$;`);
                out.push('');
            }
        }

        // indexes (skip PK/UNIQUE ones)
        out.push('-- ── Indexes ────────────────────────────────────────────────');
        for (const t of ordered) {
            const pkCols = new Set(pks.get(t));
            const uniqueIdxNames = new Set([...uniqs.get(t).keys()]);
            for (const row of idx.get(t)) {
                // pg auto-creates an index for PK / UNIQUE; skip those
                if (uniqueIdxNames.has(row.indexname)) continue;
                if (/_pkey$/.test(row.indexname)) continue;
                // make idempotent
                let def = row.indexdef;
                def = def.replace(/^CREATE INDEX /i,        'CREATE INDEX IF NOT EXISTS ');
                def = def.replace(/^CREATE UNIQUE INDEX /i, 'CREATE UNIQUE INDEX IF NOT EXISTS ');
                out.push(def + ';');
            }
        }
        out.push('');
        out.push('COMMIT;');
        out.push('');

        process.stdout.write(out.join('\n'));
        process.stderr.write(`[dump-schema] ✓ ${ordered.length} tables emitted\n`);
    } catch (e) {
        console.error('[dump-schema] ✗', e.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
})();
