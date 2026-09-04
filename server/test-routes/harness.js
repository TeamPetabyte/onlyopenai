// harness.js — boot one real server.js on a throwaway database for the route tests
//
// The DB name is fixed (petabyte_route_test) and dropped + recreated every run, so
// the server's own migration runner is exercised from an empty schema each time.
// OpenAI is pointed at a closed port: any request that reaches the network fails
// fast instead of spending money.

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const { Client, Pool } = require('pg');
const bcrypt = require('bcrypt');

const DB = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT) || 5433,
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'localtest',
    name: process.env.ROUTE_TEST_DB || 'petabyte_route_test',
};
const SERVER_DIR = path.join(__dirname, '..');
const BOOT_TIMEOUT_MS = 90000;

async function recreateDb() {
    const c = new Client({ host: DB.host, port: DB.port, user: DB.user, password: DB.password, database: 'postgres' });
    await c.connect();
    try {
        await c.query(`DROP DATABASE IF EXISTS "${DB.name}" WITH (FORCE)`);
        await c.query(`CREATE DATABASE "${DB.name}"`);
    } finally { await c.end(); }
}

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
    await recreateDb();
    const port = await freePort();
    const env = {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        DB_HOST: DB.host, DB_PORT: String(DB.port), DB_NAME: DB.name, DB_USER: DB.user, DB_PASS: DB.password,
        // real-looking key so HAS_API_KEY is true and the budget gate runs; base URL is a dead port
        OPENAI_API_KEY: 'sk-route-test-dummy',
        OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
        OPENAI_ADMIN_KEY: '', OPENAI_ASSISTANT_ID: '', OPENAI_VECTOR_STORE_ID: '',
        HTTPS_PROXY: '', HTTP_PROXY: '',
        ENCRYPTION_KEY: '00'.repeat(32),
        ALLOWED_ORIGINS: '',
        LOG_FILE_DISABLE: '1', LOG_PRETTY: '0', LOG_LEVEL: 'warn',
    };
    const child = spawn(process.execPath, ['server.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    const keep = (buf) => { output.push(String(buf)); if (output.length > 200) output.shift(); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let exited = null;
    child.on('exit', (code) => { exited = code; });

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
        if (exited !== null) throw new Error(`server exited with ${exited} during boot:\n${output.join('')}`);
        try {
            const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
            if (r.ok) break;
        } catch (_) { /* not up yet */ }
        if (Date.now() > deadline) { child.kill(); throw new Error(`server did not answer /api/health in ${BOOT_TIMEOUT_MS}ms:\n${output.join('')}`); }
        await sleep(250);
    }

    const pool = new Pool({ host: DB.host, port: DB.port, user: DB.user, password: DB.password, database: DB.name, max: 2 });

    // role_id 1 = admin, 3 = trainer; the seeded 'admin' is promoted to trainer by a migration, so make our own
    async function createStaff(username, password, roleId = 1) {
        const hash = await bcrypt.hash(password, 10);
        const r = await pool.query(
            `INSERT INTO tbl_user (project_id, role_id, username, password, name, surname, created_date, acc_status_id, must_change_password)
             VALUES (NULL, $3, $1, $2, 'Route', 'Staff', CURRENT_DATE, 1, FALSE) RETURNING user_id`,
            [username, hash, roleId]);
        return r.rows[0].user_id;
    }
    const createAdmin = (u, p) => createStaff(u, p, 1);

    // raw path fetch — curl-style, no normalisation, for the static-file guard tests
    async function rawGet(pathWithQuery) {
        const res = await fetch(base + pathWithQuery, { signal: AbortSignal.timeout(10000) });
        return { status: res.status };
    }

    async function req(method, urlPath, { body, auth, headers, timeoutMs = 15000 } = {}) {
        const h = { ...(auth || {}), ...(headers || {}) };
        if (body !== undefined) h['content-type'] = 'application/json';
        const res = await fetch(base + urlPath, {
            method, headers: h,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        return { status: res.status, json, text, headers: res.headers };
    }

    // login → { status, json, auth } where auth carries the session cookie + csrf header for later calls
    async function login(username, password) {
        const r = await req('POST', '/api/auth/login', { body: { username, password } });
        const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
        const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
        const auth = r.json && r.json.ok ? { cookie, 'x-csrf-token': r.json.csrfToken } : null;
        return { ...r, setCookies, auth };
    }

    async function stop() {
        await pool.end().catch(() => {});
        if (exited === null) {
            const done = new Promise((r) => child.once('exit', r));
            child.kill();
            await Promise.race([done, sleep(5000)]);
        }
    }

    return { base, req, login, createAdmin, createStaff, rawGet, pool, stop, output: () => output.join('') };
}

module.exports = { start, DB };
