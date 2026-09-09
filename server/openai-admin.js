// Thin wrapper around the OpenAI Admin API. Requires OPENAI_ADMIN_KEY (sk-admin-…).
// Errors carry `.status` and `.openai` so callers can tell a rejection from a network failure.
// Nothing is cached here; caching belongs to the route that owns the data.

const https = require('https');
const { URL } = require('url');

const ADMIN_KEY = process.env.OPENAI_ADMIN_KEY || '';
const BASE = 'https://api.openai.com';

function isEnabled() { return !!ADMIN_KEY; }

// Egress proxy agent (HTTPS_PROXY / HTTP_PROXY), resolved once; null = direct.
let _agent;
function getAgent() {
    if (_agent !== undefined) return _agent;
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxy) {
        try {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            _agent = new HttpsProxyAgent(proxy);
        } catch (_) { _agent = null; }
    } else {
        _agent = null;
    }
    return _agent;
}

// JSON request over Node's https, not global fetch: undici fails on some corporate
// networks where https (what the OpenAI SDK uses) connects fine.
function request(method, urlStr, headers, bodyObj) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const data = bodyObj ? JSON.stringify(bodyObj) : null;
        const opts = {
            method,
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + u.search,
            headers: { ...headers },
            timeout: 30000,
        };
        const ag = getAgent();
        if (ag) opts.agent = ag;
        if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

        const req = https.request(opts, (res) => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { buf += c; });
            res.on('end', () => {
                let json = null;
                try { json = buf ? JSON.parse(buf) : null; } catch (_) { /* non-JSON body */ }
                resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json });
            });
        });
        req.on('timeout', () => { req.destroy(new Error('request timeout after 30s')); });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function call(method, path, body) {
    if (!ADMIN_KEY) {
        const err = new Error('OPENAI_ADMIN_KEY not configured');
        err.status = 500;
        throw err;
    }
    const { status, ok, json } = await request(method, BASE + path, {
        Authorization: 'Bearer ' + ADMIN_KEY,
        'Content-Type': 'application/json',
    }, body);
    if (!ok) {
        const msg = json?.error?.message || `HTTP ${status}`;
        const err = new Error(`OpenAI Admin: ${method} ${path} → ${msg}`);
        err.status = status;
        err.openai = json?.error || json;
        throw err;
    }
    return json;
}

async function createProject(name) {
    if (!name || !String(name).trim()) throw new Error('project name required');
    return call('POST', '/v1/organization/projects', { name: String(name).trim() });
}

async function archiveProject(projectId) {
    if (!projectId) throw new Error('projectId required');
    return call('POST', `/v1/organization/projects/${encodeURIComponent(projectId)}/archive`);
}

async function listProjects(limit = 100) {
    return call('GET', `/v1/organization/projects?limit=${limit}`);
}

// A service account is the path to a programmatic API key.
async function createServiceAccount(projectId, name = 'dashboard-sa') {
    if (!projectId) throw new Error('projectId required');
    return call(
        'POST',
        `/v1/organization/projects/${encodeURIComponent(projectId)}/service_accounts`,
        { name: String(name).slice(0, 64) }
    );
}

// Promote a project user / service account so its API key gets PERMISSIONS=All.
// POST, not PATCH: PATCH 405s on some org tiers.
async function setProjectUserRole(projectId, userId, role = 'owner') {
    if (!projectId || !userId) throw new Error('projectId + userId required');
    return call(
        'POST',
        `/v1/organization/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}`,
        { role: String(role) }
    );
}

// Org-level completion usage, bucket_width=1d, grouped by project_id + model (matches tbl_daily_token).
// Times are UNIX seconds (UTC). OpenAI reports with a 5-30 min lag, so the caller re-reads the trailing days and UPSERTs.
// Returns flat buckets: [{ start_time, end_time, results: [{ project_id, model, input_tokens, output_tokens, ... }] }]
async function fetchUsageCompletions({ startTime, endTime } = {}) {
    if (!ADMIN_KEY) {
        const err = new Error('OPENAI_ADMIN_KEY not configured');
        err.status = 500;
        throw err;
    }
    if (!startTime) {
        // default: last 3 days
        startTime = Math.floor(Date.now() / 1000) - 3 * 86400;
    }
    if (!endTime) endTime = Math.floor(Date.now() / 1000);

    const out = [];
    let page = null;
    let safety = 50;            // hard cap to avoid runaway pagination
    while (safety-- > 0) {
        const qs = new URLSearchParams({
            start_time:   String(startTime),
            end_time:     String(endTime),
            bucket_width: '1d',
            // limit is capped per bucket_width (1d → 31); one page covers a month.
            limit:        '31',
        });
        qs.append('group_by', 'project_id');
        qs.append('group_by', 'model');
        if (page) qs.set('page', page);
        const { status, ok, json } = await request(
            'GET',
            BASE + '/v1/organization/usage/completions?' + qs.toString(),
            { Authorization: 'Bearer ' + ADMIN_KEY },
            null
        );
        if (!ok) {
            const msg = json?.error?.message || `HTTP ${status}`;
            const err = new Error(`OpenAI Usage: ${msg}`);
            err.status = status;
            err.openai = json?.error || json;
            throw err;
        }
        const buckets = Array.isArray(json?.data) ? json.data : [];
        for (const b of buckets) out.push(b);
        if (!json?.has_more || !json?.next_page) break;
        page = json.next_page;
    }
    return out;
}

module.exports = {
    isEnabled,
    createProject,
    archiveProject,
    listProjects,
    createServiceAccount,
    setProjectUserRole,
    fetchUsageCompletions,
};
