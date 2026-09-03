// api.test.js — the HTTP contract of login, the auth gates, and the money gates
//
// Runs against a real server.js on a throwaway Postgres (see harness.js). The unit
// tests cover lib/*; this is the first layer that sees routes, middleware, cookies
// and SQL together. Needs a reachable Postgres: `npm run test:routes` in server/.

const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./harness');

const ADMIN = { username: 'rt_admin', password: 'RouteAdmin#1' };
const USER  = { username: 'rt_user',  password: 'RouteUser#1', changed: 'RouteUser#2' };
const PROJECT = 'proj_route_test';

let srv, admin, userId;

test.before(async () => {
    srv = await start();
    await srv.createAdmin(ADMIN.username, ADMIN.password);
    admin = (await srv.login(ADMIN.username, ADMIN.password)).auth;
    assert.ok(admin, 'admin login must work: ' + srv.output());

    const p = await srv.req('POST', '/api/projects', { auth: admin, body: { name: 'Route Test', projectId: PROJECT } });
    assert.equal(p.json?.id, PROJECT, JSON.stringify(p.json));
    const u = await srv.req('POST', '/api/users', { auth: admin,
        body: { username: USER.username, password: USER.password, displayName: 'Route User', projectId: PROJECT } });
    assert.ok(u.json?.ok, JSON.stringify(u.json));
    userId = u.json.id;
});

test.after(async () => { if (srv) await srv.stop(); });

test('health answers without a session', async () => {
    const r = await srv.req('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
});

test.describe('login', () => {
    test('unknown user and wrong password both come back 401 with the same message', async () => {
        const a = await srv.login('nobody_here', 'Whatever#1');
        const b = await srv.login(USER.username, 'Wrong#1234');
        assert.equal(a.status, 401);
        assert.equal(b.status, 401);
        assert.equal(a.json.error, b.json.error);
        assert.equal(a.auth, null);
    });

    test('a good login sets an HttpOnly session cookie and returns a csrf token, not a token in the body', async () => {
        const r = await srv.login(USER.username, USER.password);
        assert.equal(r.status, 200, r.text);
        assert.equal(r.json.ok, true);
        assert.equal(typeof r.json.csrfToken, 'string');
        assert.equal(r.json.token, undefined);
        assert.equal(r.json.user.username, USER.username);
        assert.equal(r.json.user.projectId, PROJECT);
        const session = r.setCookies.find((c) => c.startsWith('petabyte_session='));
        assert.ok(session, 'petabyte_session cookie');
        assert.match(session, /HttpOnly/i);
        assert.match(session, /SameSite=Strict/i);
    });

    test('an admin-created user must change their password before anything else', async () => {
        const r = await srv.login(USER.username, USER.password);
        assert.equal(r.json.mustChangePassword, true);
        const gated = await srv.req('GET', '/api/quota-status', { auth: r.auth });
        assert.equal(gated.status, 423);
        assert.equal(gated.json.mustChangePassword, true);

        const change = await srv.req('PUT', `/api/users/${userId}/password`, { auth: r.auth, body: { password: USER.changed } });
        assert.equal(change.status, 200, change.text);
        assert.equal(change.json.ok, true);
        USER.password = USER.changed;

        const open = await srv.req('GET', '/api/quota-status', { auth: r.auth });
        assert.equal(open.status, 200, open.text);
        const again = await srv.login(USER.username, USER.password);
        assert.equal(again.json.mustChangePassword, false);
    });

    test('five wrong passwords lock the account, and the right password no longer opens it', async () => {
        const locky = { username: 'rt_locky', password: 'RouteLock#1' };
        const c = await srv.req('POST', '/api/users', { auth: admin,
            body: { username: locky.username, password: locky.password, projectId: PROJECT } });
        assert.ok(c.json?.ok, c.text);
        let last;
        for (let i = 0; i < 5; i++) last = await srv.login(locky.username, 'Nope#0000');
        assert.equal(last.status, 423, last.text);
        assert.equal(last.json.locked, true);
        const correct = await srv.login(locky.username, locky.password);
        assert.equal(correct.status, 423);
    });

    test('logout kills the session', async () => {
        const r = await srv.login(USER.username, USER.password);
        const out = await srv.req('POST', '/api/logout', { auth: r.auth });
        assert.equal(out.json.ok, true);
        const after = await srv.req('GET', '/api/quota-status', { auth: r.auth });
        assert.equal(after.status, 401);
    });
});

test.describe('gates', () => {
    test('no cookie → 401 on user routes, admin routes and chat', async () => {
        for (const [m, p] of [['GET', '/api/quota-status'], ['GET', '/api/users'], ['POST', '/api/chat']]) {
            const r = await srv.req(m, p, { body: m === 'POST' ? { prompt: 'hi' } : undefined });
            assert.equal(r.status, 401, `${m} ${p}`);
        }
    });

    test('a user is not an admin', async () => {
        const { auth } = await srv.login(USER.username, USER.password);
        const r = await srv.req('GET', '/api/users', { auth });
        assert.equal(r.status, 403);
    });

    test('a state-changing request with the cookie but no csrf header is refused', async () => {
        const { auth } = await srv.login(USER.username, USER.password);
        const r = await srv.req('POST', '/api/quota-requests', { auth: { cookie: auth.cookie }, body: { requestedExtra: 5 } });
        assert.equal(r.status, 403);
        assert.match(r.json.error, /CSRF/);
    });
});

test.describe('money gates', () => {
    let user;
    test.before(async () => { user = (await srv.login(USER.username, USER.password)).auth; });

    test('a fresh project has an empty pool and chat is refused with 402', async () => {
        const q = await srv.req('GET', '/api/quota-status', { auth: user });
        assert.equal(q.status, 200, q.text);
        assert.equal(q.json.projectPool, 0);
        assert.equal(q.json.poolEmpty, true);
        assert.equal(q.json.dailyCap, null);

        const chat = await srv.req('POST', '/api/chat', { auth: user, body: { prompt: 'hello' } });
        assert.equal(chat.status, 402, chat.text);
        assert.equal(chat.json.error, 'project_pool_empty');
    });

    test('chat without a prompt is a 400 before any money is looked at', async () => {
        const r = await srv.req('POST', '/api/chat', { auth: user, body: {} });
        assert.equal(r.status, 400);
    });

    test('a topup fills the pool and quota-status sees it', async () => {
        const t = await srv.req('PUT', `/api/projects/${PROJECT}/topup`, { auth: admin, body: { amount: 100, note: 'route test' } });
        assert.equal(t.status, 200, t.text);
        assert.equal(t.json.ok, true);
        assert.equal(t.json.newBalance, 100);
        const q = await srv.req('GET', '/api/quota-status', { auth: user });
        assert.equal(q.json.projectPool, 100);
        assert.equal(q.json.poolEmpty, false);
    });

    test('a daily cap of 0 turns chat into 429 daily_cap_exceeded even with money in the pool', async () => {
        const cap = await srv.req('PUT', `/api/users/${userId}/daily-cap`, { auth: admin, body: { dailyCap: 0 } });
        assert.equal(cap.status, 200, cap.text);
        const chat = await srv.req('POST', '/api/chat', { auth: user, body: { prompt: 'hello' } });
        assert.equal(chat.status, 429, chat.text);
        assert.equal(chat.json.error, 'daily_cap_exceeded');
        assert.equal(chat.json.canRequestMore, true);
    });

    test('quota-status reports the cap, and nothing spent yet', async () => {
        await srv.req('PUT', `/api/users/${userId}/daily-cap`, { auth: admin, body: { dailyCap: 5 } });
        const q = await srv.req('GET', '/api/quota-status', { auth: user });
        assert.equal(q.json.dailyCap, 5);
        assert.equal(q.json.effectiveCap, 5);
        assert.equal(q.json.spentToday, 0);
        assert.equal(q.json.remaining, 5);
        assert.equal(q.json.capExceeded, false);
    });

    test('a quota request: one pending per day, approval lands in bonusBalance and the effective cap', async () => {
        const bad = await srv.req('POST', '/api/quota-requests', { auth: user, body: { requestedExtra: -1 } });
        assert.equal(bad.status, 400);
        assert.equal(bad.json.error, 'invalid_amount');

        const first = await srv.req('POST', '/api/quota-requests', { auth: user, body: { requestedExtra: 10, reason: 'route test' } });
        assert.equal(first.status, 200, first.text);
        assert.equal(first.json.request.status, 'pending');
        const dup = await srv.req('POST', '/api/quota-requests', { auth: user, body: { requestedExtra: 10 } });
        assert.equal(dup.status, 409);
        assert.equal(dup.json.error, 'pending_request_exists');

        const mine = await srv.req('GET', '/api/quota-requests', { auth: user });
        assert.equal(mine.json.count, 1);

        const id = first.json.request.request_id;
        const ok = await srv.req('POST', `/api/quota-requests/${id}/resolve`, { auth: admin, body: { action: 'approve', note: 'ok' } });
        assert.equal(ok.status, 200, ok.text);
        assert.equal(ok.json.status, 'approved');
        assert.equal(ok.json.bonusBalance, 10);

        const twice = await srv.req('POST', `/api/quota-requests/${id}/resolve`, { auth: admin, body: { action: 'approve' } });
        assert.equal(twice.status, 409);
        assert.equal(twice.json.error, 'already_resolved');

        const q = await srv.req('GET', '/api/quota-status', { auth: user });
        assert.equal(q.json.bonusBalance, 10);
        assert.equal(q.json.effectiveCap, 15);
        assert.equal(q.json.remaining, 15);
    });

    test('a user cannot resolve quota requests', async () => {
        const r = await srv.req('POST', '/api/quota-requests/1/resolve', { auth: user, body: { action: 'deny' } });
        assert.equal(r.status, 403);
    });
});
