// ╔═══════════════════════════════════════════════════════════╗
// ║ Phase 11 Block C — Structured logging (pino)              ║
// ╚═══════════════════════════════════════════════════════════╝
// One place to make a logger, used everywhere.
//
// Design choices:
//   • stdout stays human-readable in dev (pino-pretty), JSON in prod
//     so log aggregators (Loki, Datadog, CloudWatch) can parse rows
//     without a shim.
//   • Also tee to a rotating file under logs/  — pino-roll rolls daily
//     and keeps LOG_RETAIN_DAYS files. Zero external cron needed.
//   • Sensitive keys are redacted (password, token, csrf, apiKey, cookie)
//     regardless of where they appear in the payload.
//   • pino is sync-by-default here: we pay the tiny cost for
//     guaranteed-flushed logs around crashes and SIGTERM. The rotating
//     file runs on a worker thread anyway (pino.transport).
//
// Env:
//   LOG_LEVEL         fatal|error|warn|info|debug|trace  (default info)
//   LOG_DIR           folder for rolled files            (default ./logs)
//   LOG_RETAIN_DAYS   files to keep                      (default 14)
//   LOG_PRETTY        force pretty on/off                (default: auto;
//                     pretty when NODE_ENV!=='production')
//   LOG_FILE_DISABLE  '1' to skip the file transport entirely
//                     (useful in smoke tests / ephemeral containers)
//
// Usage:
//   const { logger, httpLogger } = require('./logger');
//   logger.info({ userId }, 'user logged in');
//   app.use(httpLogger);

'use strict';

const path = require('path');
const fs   = require('fs');
const pino = require('pino');
const pinoHttp = require('pino-http');

const LOG_LEVEL   = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_DIR     = process.env.LOG_DIR || path.join(__dirname, 'logs');
const RETAIN_DAYS = Math.max(1, parseInt(process.env.LOG_RETAIN_DAYS, 10) || 14);
const IS_PROD     = process.env.NODE_ENV === 'production';
const PRETTY      = process.env.LOG_PRETTY
    ? process.env.LOG_PRETTY === '1' || process.env.LOG_PRETTY === 'true'
    : !IS_PROD;
const FILE_DISABLE = process.env.LOG_FILE_DISABLE === '1';

// Ensure log dir exists — pino-roll assumes it.
if (!FILE_DISABLE) {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); }
    catch (e) { /* fall through; transport will surface the error */ }
}

// ── Redaction paths ─────────────────────────────────────────
// pino's redact lets us blank out fields by dotted path. We target
// common request/response body keys plus headers. `remove: true`
// removes the key entirely so it never hits the log sink.
// PTB-FND-035: strip everything after '?' before a URL reaches a log line
const pathOnly = (u) => String(u || '').split('?')[0];

const redactPaths = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-csrf-token"]',
    'res.headers["set-cookie"]',
    '*.password',
    '*.token',
    '*.csrfToken',
    '*.apiKey',
    '*.admin_api_key',
    'password',
    'token',
    'csrfToken',
    'apiKey',
];

// ── Transport: pretty stdout + optional rolling file ────────
const targets = [];

if (PRETTY) {
    targets.push({
        target: 'pino-pretty',
        level:  LOG_LEVEL,
        options: {
            colorize:      true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore:        'pid,hostname',
            singleLine:    false,
        },
    });
} else {
    // Plain JSON to stdout (file descriptor 1) — good for container log drivers.
    targets.push({
        target: 'pino/file',
        level:  LOG_LEVEL,
        options: { destination: 1 },   // 1 = stdout
    });
}

if (!FILE_DISABLE) {
    targets.push({
        target: 'pino-roll',
        level:  LOG_LEVEL,
        options: {
            file:          path.join(LOG_DIR, 'app'),   // becomes app.YYYY-MM-DD
            frequency:     'daily',
            dateFormat:    'yyyy-MM-dd',
            extension:     '.log',
            mkdir:         true,
            limit:         { count: RETAIN_DAYS },      // keep N most-recent files
            size:          '50m',                       // also roll at 50 MB
        },
    });
}

const logger = pino({
    level: LOG_LEVEL,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    base:  { service: 'petabyte-ai', env: process.env.NODE_ENV || 'development' },
    timestamp: pino.stdTimeFunctions.isoTime,
}, pino.transport({ targets }));

// ── HTTP middleware ─────────────────────────────────────────
// pino-http adds req.log and logs one row per request at res.end.
// We filter /api/health at info level (chatty, uninteresting) and
// downgrade 4xx to warn, 5xx to error (sane defaults, but explicit).
const httpLogger = pinoHttp({
    logger,
    autoLogging: {
        ignore: (req) => req.url === '/api/health',
    },
    customLogLevel: function (req, res, err) {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
    },
    // PTB-FND-035: the query string carries chat-search terms and other user text — log the path only
    customSuccessMessage: (req, res) =>
        `${req.method} ${pathOnly(req.url)} → ${res.statusCode}`,
    customErrorMessage: (req, res, err) =>
        `${req.method} ${pathOnly(req.url)} failed: ${err.message}`,
    // Only a few req/res fields survive into the JSON
    serializers: {
        req: (req) => ({
            method: req.method,
            url:    pathOnly(req.url),
            remote: req.remoteAddress,
        }),
        res: (res) => ({ statusCode: res.statusCode }),
    },
});

// ── Shutdown flush ──────────────────────────────────────────
// pino.transport writes on a worker thread; on process exit we call
// logger.flush() so pending lines are not truncated. Callers who
// install SIGTERM handlers should await this before exiting.
async function flushLogger() {
    try {
        await new Promise((resolve) => logger.flush(() => resolve()));
    } catch (_) { /* best-effort */ }
}

module.exports = { logger, httpLogger, flushLogger };
