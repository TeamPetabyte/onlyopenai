#!/usr/bin/env node
// start.js — PetabyteAi launcher: spawns the backend (:3001) and a zero-dep static server (:8080),
// runs pre-flight checks, then opens the browser. Backend deps are installed on first run.
// Flags: --dev (nodemon backend)  --no-browser  --port-backend=N  --port-static=N  --open=PATH

'use strict';

const { spawn }   = require('child_process');
const http        = require('http');
const net         = require('net');
const fs          = require('fs');
const path        = require('path');

const ROOT        = __dirname;
const SERVER_DIR  = path.join(ROOT, 'server');
const ENV_FILE    = path.join(SERVER_DIR, '.env');
const args        = process.argv.slice(2);

const ARG = {
    dev:           args.includes('--dev'),
    noBrowser:     args.includes('--no-browser'),
    portBackend:   parseInt(getArg('--port-backend'), 10) || 3001,
    portStatic:    parseInt(getArg('--port-static'),  10) || 8080,
    // ?loggedout=1 bypasses login.html's auto-redirect so a fresh launch shows the login form
    openPath:      getArg('--open') || '/login.html?loggedout=1',
};

function getArg(key) {
    const a = args.find(x => x.startsWith(key + '='));
    return a ? a.slice(key.length + 1) : null;
}

const supportsColor = process.stdout.isTTY && process.env.TERM !== 'dumb';
const C = supportsColor ? {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bgBlue: '\x1b[44m', bgGreen: '\x1b[42m',
} : new Proxy({}, { get: () => '' });

const banner = () => {
    const lines = [
        '',
        `${C.cyan}╔═══════════════════════════════════════════════════════════╗${C.reset}`,
        `${C.cyan}║${C.reset}   ${C.bold}🚀 PetabyteAi Launcher${C.reset}                                ${C.cyan}║${C.reset}`,
        `${C.cyan}║${C.reset}   ${C.dim}Backend + Static Frontend + Pre-flight${C.reset}              ${C.cyan}║${C.reset}`,
        `${C.cyan}╚═══════════════════════════════════════════════════════════╝${C.reset}`,
        '',
    ];
    console.log(lines.join('\n'));
};

const log = {
    info:  (msg) => console.log(`${C.cyan}ℹ${C.reset}  ${msg}`),
    ok:    (msg) => console.log(`${C.green}✓${C.reset}  ${msg}`),
    warn:  (msg) => console.log(`${C.yellow}⚠${C.reset}  ${msg}`),
    err:   (msg) => console.log(`${C.red}✗${C.reset}  ${msg}`),
    step:  (msg) => console.log(`\n${C.bold}${C.blue}▸ ${msg}${C.reset}`),
    tag:   (tag, msg, color = C.gray) => process.stdout.write(`${color}[${tag}]${C.reset} ${msg}`),
};

async function preflight() {
    log.step('Pre-flight checks');

    // 1. Node version
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (nodeMajor < 16) {
        log.err(`Node.js ${process.version} is too old (need ≥ 16)`);
        process.exit(1);
    }
    log.ok(`Node.js ${process.version}`);

    // 2. .env file
    if (!fs.existsSync(ENV_FILE)) {
        log.err(`Missing ${path.relative(ROOT, ENV_FILE)}`);
        log.info(`Copy server/.env.example → server/.env and fill in credentials`);
        process.exit(1);
    }
    const envText = fs.readFileSync(ENV_FILE, 'utf8');
    const envMap  = parseEnv(envText);
    const required = ['OPENAI_API_KEY', 'DB_HOST', 'DB_USER', 'DB_NAME'];
    const missing = required.filter(k => !envMap[k] || envMap[k].includes('xxxx'));
    if (missing.length) {
        log.warn(`server/.env is missing or has placeholder values for: ${C.yellow}${missing.join(', ')}${C.reset}`);
        log.info('Server may run but features depending on those keys will fail');
    } else {
        log.ok('server/.env loaded (all required keys present)');
    }

    // 3. node_modules in server/
    if (!fs.existsSync(path.join(SERVER_DIR, 'node_modules'))) {
        log.warn('server/node_modules not found — installing dependencies...');
        await runOnce('npm', ['install'], { cwd: SERVER_DIR });
        log.ok('Dependencies installed');
    } else {
        log.ok('server/node_modules present');
    }

    // 4. Port availability
    for (const [name, port] of [['Backend', ARG.portBackend], ['Static', ARG.portStatic]]) {
        const free = await isPortFree(port);
        if (!free) {
            log.err(`Port ${port} (${name}) is already in use`);
            log.info(`Close the other process or pass --port-${name.toLowerCase()}=<other>`);
            process.exit(1);
        }
        log.ok(`Port ${port} (${name}) is free`);
    }

    // 5. DB reachability (TCP ping, soft check)
    if (envMap.DB_HOST && envMap.DB_PORT) {
        const reachable = await tcpPing(envMap.DB_HOST, parseInt(envMap.DB_PORT, 10), 2000);
        if (reachable) {
            log.ok(`PostgreSQL reachable at ${envMap.DB_HOST}:${envMap.DB_PORT}`);
        } else {
            log.warn(`Cannot reach PostgreSQL at ${envMap.DB_HOST}:${envMap.DB_PORT} — backend will retry on its own`);
        }
    }

    return envMap;
}

function parseEnv(text) {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
}

function isPortFree(port) {
    return new Promise(resolve => {
        const tester = net.createServer()
            .once('error', () => resolve(false))
            .once('listening', () => tester.close(() => resolve(true)))
            .listen(port, '0.0.0.0');
    });
}

function tcpPing(host, port, timeout = 2000) {
    return new Promise(resolve => {
        const sock = new net.Socket();
        let done = false;
        const finish = (ok) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
        sock.setTimeout(timeout);
        sock.once('connect', () => finish(true));
        sock.once('error',   () => finish(false));
        sock.once('timeout', () => finish(false));
        sock.connect(port, host);
    });
}

function runOnce(cmd, cmdArgs, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, cmdArgs, { stdio: 'inherit', shell: true, ...opts });
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)));
        child.on('error', reject);
    });
}

function waitForBackend(port, timeoutMs = 30000) {
    const url = `http://localhost:${port}/api/health`;
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            const req = http.get(url, res => {
                if (res.statusCode === 200) {
                    res.resume();
                    resolve();
                } else {
                    res.resume();
                    retry();
                }
            });
            req.on('error', retry);
            req.setTimeout(1500, () => req.destroy());
        };
        const retry = () => {
            if (Date.now() - start > timeoutMs) reject(new Error('backend health timeout'));
            else setTimeout(tick, 500);
        };
        tick();
    });
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.txt':  'text/plain; charset=utf-8',
    '.md':   'text/markdown; charset=utf-8',
    '.map':  'application/json; charset=utf-8',
};

function startStaticServer(port) {
    const server = http.createServer((req, res) => {
        try {
            // bare root → login form, bypassing a stale-session auto-redirect
            if (req.url === '/' || req.url === '') {
                res.writeHead(302, { Location: '/login.html?loggedout=1' });
                res.end();
                return;
            }
            let urlPath = decodeURIComponent(req.url.split('?')[0]);
            if (urlPath === '/' || urlPath === '') urlPath = '/login.html';

            // no directory escape
            const filePath = path.join(ROOT, urlPath);
            const rel      = path.relative(ROOT, filePath);
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                res.writeHead(403); res.end('Forbidden'); return;
            }
            // Block access to server/, .env, .git, node_modules
            const blocked = /^(server|\.env|\.git|node_modules)(\\|\/|$)/i;
            if (blocked.test(rel)) {
                res.writeHead(403); res.end('Forbidden'); return;
            }

            fs.stat(filePath, (err, stat) => {
                if (err || !stat.isFile()) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('404 Not Found');
                    return;
                }
                const ext  = path.extname(filePath).toLowerCase();
                const mime = MIME[ext] || 'application/octet-stream';
                // HTML never cached so versioned JS/CSS references stay fresh
                const cacheCtl = (ext === '.html')
                    ? 'no-store, no-cache, must-revalidate, max-age=0'
                    : 'no-cache';
                res.writeHead(200, {
                    'Content-Type':   mime,
                    'Cache-Control':  cacheCtl,
                    'Pragma':         'no-cache',
                    'Expires':        '0',
                    'X-Content-Type-Options': 'nosniff',
                });
                fs.createReadStream(filePath).pipe(res);
            });
        } catch {
            res.writeHead(500); res.end('500 Internal');
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve(server));
    });
}

function openBrowser(url) {
    try {
        let cmd, cmdArgs;
        switch (process.platform) {
            case 'win32':  cmd = 'cmd';   cmdArgs = ['/c', 'start', '""', url]; break;
            case 'darwin': cmd = 'open';  cmdArgs = [url]; break;
            default:       cmd = 'xdg-open'; cmdArgs = [url]; break;
        }
        const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
        child.unref();
    } catch { /* swallow — non-fatal */ }
}

function spawnBackend() {
    const cmd  = ARG.dev ? 'npx' : 'node';
    const cmdArgs = ARG.dev ? ['nodemon', '--quiet', 'server.js'] : ['server.js'];

    const child = spawn(cmd, cmdArgs, {
        cwd: SERVER_DIR,
        shell: process.platform === 'win32',
        env: { ...process.env, PORT: String(ARG.portBackend) },
    });

    const prefix = `${C.magenta}[backend]${C.reset}`;
    child.stdout.on('data', d => process.stdout.write(d.toString().split('\n').filter(Boolean).map(l => `${prefix} ${l}`).join('\n') + '\n'));
    child.stderr.on('data', d => process.stderr.write(d.toString().split('\n').filter(Boolean).map(l => `${prefix} ${C.red}${l}${C.reset}`).join('\n') + '\n'));
    return child;
}

function attachShutdown(children, staticServer) {
    let shuttingDown = false;
    const shutdown = (sig) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n${C.yellow}↓ Caught ${sig} — shutting down...${C.reset}`);
        for (const c of children) {
            try {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/pid', c.pid, '/f', '/t'], { stdio: 'ignore' });
                } else {
                    c.kill('SIGTERM');
                }
            } catch { /* ignore */ }
        }
        if (staticServer) staticServer.close();
        setTimeout(() => process.exit(0), 800);
    };
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

(async function main() {
    banner();
    await preflight();

    log.step(`Starting backend (${ARG.dev ? 'dev/nodemon' : 'production'}) on :${ARG.portBackend}`);
    const backend = spawnBackend();

    log.info('Waiting for backend to become healthy...');
    try {
        await waitForBackend(ARG.portBackend, 30000);
        log.ok('Backend is healthy');
    } catch (e) {
        log.err(`Backend did not become healthy: ${e.message}`);
        backend.kill();
        process.exit(1);
    }

    log.step(`Starting static server on :${ARG.portStatic}`);
    const staticServer = await startStaticServer(ARG.portStatic);
    log.ok(`Static frontend ready (root: ${path.basename(ROOT)})`);

    attachShutdown([backend], staticServer);

    const frontendUrl = `http://localhost:${ARG.portStatic}${ARG.openPath}`;
    const apiUrl      = `http://localhost:${ARG.portBackend}/api`;

    console.log('');
    console.log(`${C.bgGreen}${C.bold}                                                     ${C.reset}`);
    console.log(`${C.bgGreen}${C.bold}   🎉  PetabyteAi is running                         ${C.reset}`);
    console.log(`${C.bgGreen}${C.bold}                                                     ${C.reset}`);
    console.log('');
    console.log(`   ${C.bold}Frontend${C.reset}  →  ${C.cyan}${frontendUrl}${C.reset}`);
    console.log(`   ${C.bold}Backend${C.reset}   →  ${C.cyan}${apiUrl}${C.reset}`);
    console.log(`   ${C.bold}Health${C.reset}    →  ${C.cyan}${apiUrl}/health${C.reset}`);
    console.log('');
    console.log(`   ${C.dim}Mode: ${ARG.dev ? 'development (hot-reload)' : 'production'}${C.reset}`);
    console.log(`   ${C.dim}Press Ctrl+C to stop both servers cleanly${C.reset}`);
    console.log('');

    if (!ARG.noBrowser) {
        log.info(`Opening browser → ${frontendUrl}`);
        openBrowser(frontendUrl);
    }

    backend.on('exit', code => {
        log.err(`Backend exited unexpectedly (code ${code}) — shutting down launcher`);
        if (staticServer) staticServer.close();
        process.exit(code || 1);
    });
})().catch(err => {
    console.error(`\n${C.red}✗ Fatal: ${err.message}${C.reset}`);
    if (err.stack) console.error(C.gray + err.stack + C.reset);
    process.exit(1);
});
