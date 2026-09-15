// Structured logging (pino): pretty stdout in dev, JSON in prod, plus a daily-rolled file.
// Sensitive keys (password, token, csrf, apiKey, cookie) are redacted wherever they appear.
// Env:
//   LOG_LEVEL         fatal|error|warn|info|debug|trace  (default info)
//   LOG_DIR           folder for rolled files            (default ./logs)
//   LOG_RETAIN_DAYS   files to keep                      (default 14)
//   LOG_PRETTY        force pretty on/off                (default: pretty unless NODE_ENV=production)
//   LOG_FILE_DISABLE  '1' skips the file transport

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
    catch { /* fall through; transport will surface the error */ }
}

// strip everything after '?' before a URL reaches a log line
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

// pino-http: one row per request at res.end. /api/health is ignored; 4xx → warn, 5xx → error.
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
    // the query string carries user text (chat-search terms) — log the path only
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

// pino.transport writes on a worker thread; await this before exiting so pending lines are not truncated.
async function flushLogger() {
    try {
        await new Promise((resolve) => logger.flush(() => resolve()));
    } catch (_) { /* best-effort */ }
}

module.exports = { logger, httpLogger, flushLogger };
